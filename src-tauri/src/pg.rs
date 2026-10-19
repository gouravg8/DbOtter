//! PostgreSQL: a small connection pool per open connection for browsing and metadata, plus
//! one dedicated connection per query tab for the user's SQL.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::{ClientWrapper, Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime};
use futures_util::{StreamExt, pin_mut};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::{Client, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::results::{Collector, canceled};
use crate::running::{Canceler, Running};

const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a query waits for a free pooled connection before giving up.
const POOL_WAIT: Duration = Duration::from_secs(30);
const SYSTEM_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/* ---------- TLS ---------- */

/// For `require`: encrypt, but accept any certificate (what libpq does for sslmode=require).
#[derive(Debug)]
struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Certificates from a PEM file (like libpq's sslrootcert).
fn load_root_certs(path: &str) -> AppResult<rustls::RootCertStore> {
    use rustls::pki_types::pem::PemObject;
    let bad = |e: &dyn std::fmt::Display| AppError::new(format!("Can't read CA certificate {path}: {e}"));
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(path).map_err(|e| bad(&e))? {
        roots.add(cert.map_err(|e| bad(&e))?).map_err(|e| bad(&e))?;
    }
    if roots.is_empty() {
        return Err(bad(&"no certificates in the file"));
    }
    Ok(roots)
}

fn tls_connector(mode: SslMode, root_cert: Option<&str>) -> AppResult<MakeRustlsConnect> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::new(format!("TLS setup failed: {e}")))?;
    let config = if mode == SslMode::VerifyFull {
        // a CA file replaces the system roots, as in libpq
        let roots = match root_cert.map(str::trim).filter(|p| !p.is_empty()) {
            Some(path) => load_root_certs(path)?,
            None => {
                let mut roots = rustls::RootCertStore::empty();
                roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
                if roots.is_empty() {
                    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
                }
                roots
            }
        };
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
            .with_no_client_auth()
    };
    Ok(MakeRustlsConnect::new(config))
}

fn pg_config(c: &ConnectionConfig, password: Option<&str>) -> tokio_postgres::Config {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&c.host)
        .port(c.port)
        .dbname(&c.database)
        .user(&c.user)
        .application_name("DbOtter")
        .connect_timeout(CONNECT_TIMEOUT)
        .ssl_mode(match c.ssl_mode {
            SslMode::Disable => PgSslMode::Disable,
            SslMode::Prefer => PgSslMode::Prefer,
            SslMode::Require | SslMode::VerifyFull => PgSslMode::Require,
        });
    if let Some(p) = password {
        cfg.password(p);
    }
    cfg
}

/// Auth failed because no (or a wrong) password was given: the UI then asks for one.
/// 28000 (no pg_hba entry, unknown role…) is not a password problem and is shown as is.
fn is_auth_error(e: &AppError) -> bool {
    e.code.as_deref() == Some("28P01") || e.message.contains("password missing") || e.message.contains("no password")
}

fn auth_error(e: AppError, had_password: bool) -> AppError {
    if is_auth_error(&e) {
        let message = if had_password { e.message.clone() } else { "Password required".to_string() };
        AppError { message, code: Some("password_required".into()), ..e }
    } else {
        e
    }
}

/// Feeds a simple-query stream into the collector (rows arrive as Postgres' text output).
async fn collect_results(stream: tokio_postgres::SimpleQueryStream, out: &mut Collector) -> AppResult<()> {
    pin_mut!(stream);
    while let Some(msg) = stream.next().await {
        match msg? {
            SimpleQueryMessage::RowDescription(cols) => out.columns(cols.iter().map(|c| c.name().to_string()).collect()),
            SimpleQueryMessage::Row(row) => {
                if out.wants_row() {
                    out.row((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                }
            }
            SimpleQueryMessage::CommandComplete(n) => out.complete(n),
            _ => {}
        }
    }
    Ok(())
}

/// The connection a run uses: a query tab's own one, or one borrowed from the pool.
enum Conn {
    Editor(OwnedMutexGuard<ClientWrapper>),
    Pooled(Box<Object>),
}

impl Conn {
    fn client(&self) -> &Client {
        match self {
            Conn::Editor(c) => c,
            Conn::Pooled(c) => c,
        }
    }
}

pub struct PgSession {
    /// For browsing and metadata. User SQL never runs here, so no session state
    /// (transactions, SET, temp tables) leaks between tabs.
    pool: Pool,
    /// One dedicated connection per query tab: BEGIN, UPDATE and COMMIT run one at a time
    /// all land on the same backend.
    editors: Mutex<HashMap<String, Arc<Mutex<ClientWrapper>>>>,
    /// Bumped when a tab's connection is released, so a connection that was still being
    /// opened for it at the time is closed instead of kept.
    editor_gen: std::sync::Mutex<HashMap<String, u64>>,
    /// Primary keys by (schema, table), for stable paging; cleared on schema reload.
    primary_keys: Mutex<HashMap<(String, String), Vec<String>>>,
    tls: MakeRustlsConnect,
    pub info: SessionInfo,
    /// server_version_num, e.g. 180006
    version: i32,
}

impl PgSession {
    fn generation(&self, tab: &str) -> u64 {
        *self.editor_gen.lock().unwrap().get(tab).unwrap_or(&0)
    }

    async fn pooled(&self) -> AppResult<Object> {
        self.pool.get().await.map_err(|e| match e {
            deadpool_postgres::PoolError::Timeout(_) => {
                AppError::new("All connections are busy (a long query in another tab?). Try again or cancel it.")
            }
            other => other.into(),
        })
    }

    /// The query tab's own connection, opened on first use and replaced if it dropped.
    async fn editor(&self, tab: &str) -> AppResult<OwnedMutexGuard<ClientWrapper>> {
        let existing = self.editors.lock().await.get(tab).cloned();
        if let Some(slot) = existing {
            let guard = slot.lock_owned().await;
            if !guard.is_closed() {
                return Ok(guard);
            }
        }
        let generation = self.generation(tab);
        // taken out of the pool for good: it belongs to the tab now
        let client = Object::take(self.pooled().await?);
        if self.generation(tab) != generation {
            // the tab was closed while this was being opened: don't keep it
            return Err(canceled());
        }
        let slot = Arc::new(Mutex::new(client));
        self.editors.lock().await.insert(tab.to_string(), slot.clone());
        Ok(slot.lock_owned().await)
    }
}

impl PgSession {
    /// One-off connection to check settings from the connection form.
    pub async fn test(c: &ConnectionConfig, password: Option<&str>) -> AppResult<TestResult> {
        let started = Instant::now();
        let tls = tls_connector(c.ssl_mode, c.ssl_root_cert.as_deref())?;
        let (client, connection) =
            pg_config(c, password).connect(tls).await.map_err(|e| auth_error(e.into(), password.is_some()))?;
        let handle = tokio::spawn(connection);
        let row = client.query_one("SELECT current_setting('server_version')", &[]).await?;
        let latency_ms = started.elapsed().as_millis() as u64;
        drop(client);
        let _ = handle.await;
        Ok(TestResult { product: "PostgreSQL".into(), server_version: row.get(0), latency_ms })
    }

    pub async fn connect(c: &ConnectionConfig, password: Option<&str>) -> AppResult<PgSession> {
        let tls = tls_connector(c.ssl_mode, c.ssl_root_cert.as_deref())?;
        let manager = Manager::from_config(
            pg_config(c, password),
            tls.clone(),
            ManagerConfig { recycling_method: RecyclingMethod::Fast },
        );
        let pool = Pool::builder(manager)
            .max_size(POOL_SIZE)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(POOL_WAIT))
            .build()
            .map_err(|e| AppError::new(e.to_string()))?;
        let client = pool.get().await.map_err(|e| auth_error(e.into(), password.is_some()))?;
        let row = client
            .query_one(
                "SELECT current_setting('server_version'), current_database()::text, current_user::text,
                        current_setting('server_version_num')::int",
                &[],
            )
            .await?;
        drop(client);
        let info = SessionInfo {
            kind: DbKind::Postgres,
            product: "PostgreSQL".into(),
            server_version: row.get(0),
            database: row.get(1),
            user: row.get(2),
            default_schema: "public".into(),
        };
        Ok(PgSession {
            pool,
            editors: Mutex::new(HashMap::new()),
            editor_gen: std::sync::Mutex::new(HashMap::new()),
            primary_keys: Mutex::new(HashMap::new()),
            tls,
            info,
            version: row.get(3),
        })
    }

    pub fn close(&self) {
        self.pool.close();
    }

    /// Runs `sql` (one or more statements) with the simple query protocol, so every value
    /// arrives as Postgres' own text output and any type displays correctly. With `editor`
    /// (a query tab id) it runs on that tab's own connection, otherwise on a pooled one.
    pub async fn run(
        &self,
        running: &Running,
        query_id: &str,
        sql: &str,
        max_rows: usize,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<QueryOutput> {
        let conn = match editor {
            Some(tab) => self.editor(tab).await.map(Conn::Editor),
            None => self.pooled().await.map(|c| Conn::Pooled(Box::new(c))),
        };
        let conn = match conn {
            Ok(c) => c,
            Err(e) => {
                running.end(query_id).await;
                return Err(e);
            }
        };
        running.attach(query_id, Canceler::Postgres(conn.client().cancel_token(), self.tls.clone())).await?;
        let started = Instant::now();
        let mut out = Collector::new(max_rows);
        // SQL that includes the user's WHERE text must be one statement: Postgres refuses to
        // prepare several, so `true); DELETE …` can't sneak in whatever the quoting. Done here,
        // after the cancel handle is registered, as preparing can wait on table locks.
        if single_statement && let Err(e) = conn.client().prepare(sql).await {
            running.end(query_id).await;
            let e = AppError::from(e);
            return Err(if e.code.as_deref() == Some("42601") && e.message.contains("multiple commands") {
                AppError::new("A WHERE condition can't contain several statements (use a query tab for that)").with_code("42601")
            } else {
                e
            });
        }
        let outcome = match conn.client().simple_query_raw(sql).await {
            Ok(stream) => collect_results(stream, &mut out).await,
            Err(e) => Err(e.into()),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let user_cancelled = running.end(query_id).await;
        out.finish(outcome, user_cancelled, duration_ms)
    }

    /// Closes a query tab's connection (the tab was closed).
    pub async fn release_editor(&self, tab: &str) {
        *self.editor_gen.lock().unwrap().entry(tab.to_string()).or_default() += 1;
        self.editors.lock().await.remove(tab);
    }

    pub async fn schema(&self) -> AppResult<SchemaTree> {
        self.primary_keys.lock().await.clear();
        let client = self.pooled().await?;
        let schemas = client
            .query(
                &format!("SELECT n.nspname::text FROM pg_namespace n WHERE {SYSTEM_SCHEMAS} ORDER BY n.nspname = 'public' DESC, 1"),
                &[],
            )
            .await?;
        let relations = client
            .query(
                &format!(
                    "SELECT n.nspname::text, c.relname::text, c.relkind::text, c.reltuples::bigint
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND {SYSTEM_SCHEMAS}
                     ORDER BY 1, 2"
                ),
                &[],
            )
            .await?;
        let columns = client
            .query(
                &format!(
                    "SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod)
                     FROM pg_attribute a
                     JOIN pg_class c ON c.oid = a.attrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE a.attnum > 0 AND NOT a.attisdropped
                       AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND {SYSTEM_SCHEMAS}
                     ORDER BY 1, 2, a.attnum"
                ),
                &[],
            )
            .await?;

        let mut cols: HashMap<(String, String), Vec<ColumnBrief>> = HashMap::new();
        for r in &columns {
            cols.entry((r.get(0), r.get(1)))
                .or_default()
                .push(ColumnBrief { name: r.get(2), data_type: r.get(3) });
        }
        let mut tree: Vec<SchemaNode> =
            schemas.iter().map(|r| SchemaNode { name: r.get(0), relations: vec![] }).collect();
        for r in &relations {
            let (schema, name, kind): (String, String, String) = (r.get(0), r.get(1), r.get(2));
            let kind = match kind.as_str() {
                "v" => RelationKind::View,
                "m" => RelationKind::MaterializedView,
                "f" => RelationKind::ForeignTable,
                _ => RelationKind::Table,
            };
            let columns = cols.remove(&(schema.clone(), name.clone())).unwrap_or_default();
            if let Some(node) = tree.iter_mut().find(|s| s.name == schema) {
                node.relations.push(RelationNode { name, kind, estimated_rows: r.get(3), columns });
            }
        }
        Ok(SchemaTree { schemas: tree })
    }

    pub async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        // a structure reload (the table tab's refresh) also refreshes the cached key
        self.forget_primary_key(schema, table).await;
        // generated columns arrived in Postgres 12
        let generated = if self.version >= 120000 { "a.attgenerated::text" } else { "''::text" };
        let client = self.pooled().await?;
        let rel = crate::sql::Dialect::Postgres.qualified(schema, table);
        let head = client
            .query_opt(
                "SELECT c.oid::bigint, c.relkind::text, c.reltuples::bigint,
                        CASE WHEN c.relkind IN ('r', 'm') THEN pg_size_pretty(pg_total_relation_size(c.oid))
                             -- a partitioned table holds no data itself: sum its partitions, at any depth
                             -- (pg_inherits rather than pg_partition_tree, which needs Postgres 12)
                             WHEN c.relkind = 'p' THEN pg_size_pretty((
                               WITH RECURSIVE tree(oid) AS (
                                 SELECT c.oid UNION ALL SELECT i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.oid)
                               SELECT coalesce(sum(pg_total_relation_size(oid)), 0)::bigint FROM tree)) END,
                        CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END,
                        obj_description(c.oid, 'pg_class')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema, &table],
            )
            .await?
            .ok_or_else(|| AppError::new(format!("{rel} not found")).with_code("not_found"))?;
        let oid: i64 = head.get(0);
        let oid = oid as u32;

        let columns = client
            .query(
                &format!("SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid),
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary
                                AND a.attnum = ANY(i.indkey)),
                        col_description(a.attrelid, a.attnum), {generated}, a.attidentity::text
                 FROM pg_attribute a
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum"),
                &[&oid],
            )
            .await?
            .iter()
            .map(|r| {
                let expr: Option<String> = r.get(3);
                let (generated, identity): (String, String) = (r.get(6), r.get(7));
                ColumnInfo {
                    name: r.get(0),
                    data_type: r.get(1),
                    nullable: r.get(2),
                    // generated columns keep their expression in pg_attrdef too
                    default: if generated.is_empty() { expr.clone() } else { None },
                    generated: match generated.as_str() {
                        "s" => expr.map(|e| format!("GENERATED ALWAYS AS ({e}) STORED")),
                        "v" => expr.map(|e| format!("GENERATED ALWAYS AS ({e}) VIRTUAL")),
                        _ => match identity.as_str() {
                            "a" => Some("GENERATED ALWAYS AS IDENTITY".into()),
                            "d" => Some("GENERATED BY DEFAULT AS IDENTITY".into()),
                            _ => None,
                        },
                    },
                    primary_key: r.get(4),
                    comment: r.get(5),
                }
            })
            .collect();

        let indexes = client
            .query(
                "SELECT ci.relname::text, pg_get_indexdef(i.indexrelid), i.indisunique, i.indisprimary,
                        pg_size_pretty(pg_relation_size(i.indexrelid))
                 FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
                 WHERE i.indrelid = $1
                 ORDER BY i.indisprimary DESC, ci.relname",
                &[&oid],
            )
            .await?
            .iter()
            .map(|r| IndexInfo {
                name: r.get(0),
                definition: r.get(1),
                unique: r.get(2),
                primary: r.get(3),
                size: r.get(4),
            })
            .collect();

        let constraints = client
            .query(
                "SELECT conname::text, contype::text, pg_get_constraintdef(oid, true)
                 FROM pg_constraint
                 -- Postgres 18 also lists NOT NULL as constraints ('n'); the columns show those
                 WHERE conrelid = $1 AND contype <> 'n'
                 ORDER BY contype = 'p' DESC, contype = 'f' DESC, conname",
                &[&oid],
            )
            .await?
            .iter()
            .map(|r| {
                let kind: String = r.get(1);
                ConstraintInfo {
                    name: r.get(0),
                    kind: match kind.as_str() {
                        "p" => "primary key",
                        "f" => "foreign key",
                        "u" => "unique",
                        "c" => "check",
                        "x" => "exclusion",
                        _ => "other",
                    }
                    .to_string(),
                    definition: r.get(2),
                }
            })
            .collect();

        Ok(TableStructure {
            columns,
            indexes,
            constraints,
            estimated_rows: head.get(2),
            total_size: head.get(3),
            definition: head.get(4),
            comment: head.get(5),
        })
    }

    /// Primary key columns in key order (empty for views and tables without one).
    pub async fn primary_key(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let key = (schema.to_string(), table.to_string());
        if let Some(pk) = self.primary_keys.lock().await.get(&key) {
            return Ok(pk.clone());
        }
        let client = self.pooled().await?;
        let rows = client
            .query(
                "SELECT a.attname::text
                 FROM pg_index i
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = to_regclass(format('%I.%I', $1::text, $2::text)) AND i.indisprimary
                 ORDER BY array_position(i.indkey::int2[], a.attnum)",
                &[&schema, &table],
            )
            .await?;
        let pk: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
        self.primary_keys.lock().await.insert(key, pk.clone());
        Ok(pk)
    }

    pub async fn forget_primary_key(&self, schema: &str, table: &str) {
        self.primary_keys.lock().await.remove(&(schema.to_string(), table.to_string()));
    }
}

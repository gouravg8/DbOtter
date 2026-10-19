//! Queries in flight, by the UI's query id, so they can be cancelled. A query registers when
//! it starts waiting for a connection and attaches its engine's cancel handle once it has one;
//! a cancel in between is remembered and honoured as soon as the connection arrives.

use std::collections::HashMap;

use tokio::sync::Mutex;
use tokio_postgres::CancelToken;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::{AppError, AppResult};
use crate::results::canceled;

/// How to stop a running query on each engine.
#[derive(Clone)]
pub enum Canceler {
    /// Postgres' out-of-band cancel request.
    Postgres(CancelToken, MakeRustlsConnect),
    /// `KILL QUERY <id>` sent from another connection of the pool.
    Mysql { pool: mysql_async::Pool, connection_id: u32 },
    /// sqlite3_interrupt on the query's connection.
    Sqlite(std::sync::Arc<rusqlite::InterruptHandle>),
}

impl Canceler {
    async fn cancel(&self) -> AppResult<()> {
        match self {
            Canceler::Postgres(token, tls) => Ok(token.cancel_query(tls.clone()).await?),
            Canceler::Mysql { pool, connection_id } => {
                use mysql_async::prelude::Queryable;
                let mut conn = pool.get_conn().await.map_err(|e| AppError::new(e.to_string()))?;
                conn.query_drop(format!("KILL QUERY {connection_id}")).await.map_err(|e| AppError::new(e.to_string()))
            }
            Canceler::Sqlite(handle) => {
                handle.interrupt();
                Ok(())
            }
        }
    }
}

#[derive(Default)]
struct RunState {
    canceler: Option<Canceler>,
    cancelled: bool,
}

#[derive(Default)]
pub struct Running(Mutex<HashMap<String, RunState>>);

impl Running {
    /// The query starts (before waiting for a connection).
    pub async fn begin(&self, id: &str) {
        self.0.lock().await.insert(id.to_string(), RunState::default());
    }

    /// The query has its connection. Fails if it was cancelled while waiting.
    pub async fn attach(&self, id: &str, canceler: Canceler) -> AppResult<()> {
        let mut map = self.0.lock().await;
        let state = map.entry(id.to_string()).or_default();
        if state.cancelled {
            map.remove(id);
            return Err(canceled());
        }
        state.canceler = Some(canceler);
        Ok(())
    }

    /// The query is over; returns whether the user asked to cancel it.
    pub async fn end(&self, id: &str) -> bool {
        self.0.lock().await.remove(id).is_some_and(|s| s.cancelled)
    }

    /// Returns false when the query already finished.
    pub async fn cancel(&self, id: &str) -> AppResult<bool> {
        let canceler = {
            let mut map = self.0.lock().await;
            let Some(state) = map.get_mut(id) else { return Ok(false) };
            state.cancelled = true;
            match &state.canceler {
                Some(c) => c.clone(),
                // still waiting for a connection: it stops as soon as it gets one
                None => return Ok(true),
            }
        };
        canceler.cancel().await?;
        Ok(true)
    }
}

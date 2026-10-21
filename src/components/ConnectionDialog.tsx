import { Check, CircleAlert, KeyRound, Lock, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api, DEFAULT_PORT, KIND_LABEL, toAppError, type ConnectionConfig, type ConnectionInput, type DbKind, type SslMode } from "../lib/api";
import { parseConnectionUrl } from "../lib/format";
import { useApp } from "../lib/store";
import { describeConnection } from "../lib/dialect";
import type { Risk } from "../lib/risk";
import { Modal, Spinner } from "./ui";

const COLORS = [null, "#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444"];
const SSL: { value: SslMode; label: string }[] = [
  { value: "prefer", label: "Prefer (TLS if available)" },
  { value: "disable", label: "Disable" },
  { value: "require", label: "Require (no certificate check)" },
  { value: "verify-full", label: "Verify full (check certificate and host)" },
];
const KINDS: DbKind[] = ["postgres", "mysql", "sqlite"];
/** Values the form starts with per engine; swapped on an engine change unless edited. */
const DEFAULTS: Record<DbKind, { port: string; database: string; user: string }> = {
  postgres: { port: "5432", database: "postgres", user: "postgres" },
  mysql: { port: "3306", database: "", user: "root" },
  sqlite: { port: "", database: "", user: "" },
};
const URL_HINT: Record<DbKind, string> = {
  postgres: "postgres://user:password@host:5432/database",
  mysql: "mysql://user:password@host:3306/database",
  sqlite: "sqlite:///path/to/file.db  or just the file path",
};

export function ConnectionDialog({ conn }: { conn?: ConnectionConfig }) {
  const { setDialog, connectionSaved, toast } = useApp.getState();
  const kind0: DbKind = conn?.kind ?? "postgres";
  const [form, setForm] = useState({
    kind: kind0,
    name: conn?.name ?? "",
    host: conn?.host ?? "localhost",
    port: conn ? String(conn.port || "") : DEFAULTS[kind0].port,
    database: conn?.database ?? DEFAULTS[kind0].database,
    user: conn?.user ?? DEFAULTS[kind0].user,
    password: "",
    sslMode: conn?.sslMode ?? ("prefer" as SslMode),
    savePassword: conn?.savePassword ?? true,
    color: conn?.color ?? null,
    sslRootCert: conn?.sslRootCert ?? "",
    readOnly: conn?.readOnly ?? false,
    production: conn?.production ?? false,
  });
  const [url, setUrl] = useState("");
  // the name follows the URL until the user types their own
  const [autoName, setAutoName] = useState<string | null>(conn ? null : "");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const close = () => setDialog(null);
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const sqlite = form.kind === "sqlite";

  /** Engine switch: fields still at the old engine's defaults take the new one's. */
  const switchKind = (f: typeof form, kind: DbKind): typeof form => {
    const from = DEFAULTS[f.kind];
    const to = DEFAULTS[kind];
    const keep = (field: "port" | "database" | "user") => (f[field] === from[field] ? to[field] : f[field]);
    return { ...f, kind, port: keep("port"), database: kind === "sqlite" || f.kind === "sqlite" ? to.database : keep("database"), user: keep("user") };
  };

  const input = (): ConnectionInput => ({
    id: conn?.id,
    kind: form.kind,
    name: form.name,
    host: sqlite ? "" : form.host,
    port: sqlite ? 0 : Number(form.port) || DEFAULT_PORT[form.kind],
    database: form.database,
    user: sqlite ? "" : form.user,
    sslMode: form.sslMode,
    savePassword: !sqlite && form.savePassword,
    color: form.color,
    sslRootCert: !sqlite && form.sslMode === "verify-full" ? form.sslRootCert.trim() || null : null,
    readOnly: form.readOnly,
    production: form.production,
    // empty keeps the saved password when editing
    password: (!sqlite && form.password) || undefined,
  });

  const autoNameFor = (f: typeof form) =>
    f.kind === "sqlite" ? (f.database.split(/[\\/]/).pop() ?? "") : `${f.database || f.user}@${f.host}`;

  const pasteUrl = (text: string) => {
    setUrl(text);
    const p = parseConnectionUrl(text);
    if (!p) return;
    const followUrl = autoName !== null && form.name === autoName;
    let next = p.kind !== form.kind ? switchKind(form, p.kind) : { ...form };
    next = {
      ...next,
      host: p.host ?? next.host,
      port: p.port ? String(p.port) : next.port,
      database: p.database ?? next.database,
      user: p.user ?? next.user,
      password: p.password ?? next.password,
      sslMode: p.sslMode ?? next.sslMode,
    };
    if (followUrl) {
      next.name = autoNameFor(next);
      setAutoName(next.name);
    }
    setForm(next);
    setTest(null);
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const r = await api.testConnection(input());
      setTest({ ok: true, text: `Connected · ${r.product} ${r.serverVersion} · ${r.latencyMs} ms` });
    } catch (e) {
      setTest({ ok: false, text: toAppError(e).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async (andConnect: boolean) => {
    setBusy("save");
    try {
      const saved = await api.saveConnection(input());
      close();
      toast(conn ? "Connection updated" : "Connection saved");
      // an edited connection's session was closed by the backend: reconnect if it was open
      await connectionSaved(saved.id, andConnect);
    } catch (e) {
      setTest({ ok: false, text: toAppError(e).message });
      setBusy(null);
    }
  };

  const port = Number(form.port);
  const portOk = sqlite || (Number.isInteger(port) && port >= 1 && port <= 65535);
  const valid = sqlite ? !!form.database.trim() : form.host.trim() && form.user.trim() && portOk;
  const keychainNote = conn?.savePassword
    ? form.savePassword
      ? "Saved in keychain (type to change)"
      : "Saved password will be removed from the keychain"
    : conn
      ? "Asked when connecting"
      : "";

  return (
    <Modal
      title={conn ? "Edit connection" : "New connection"}
      onClose={close}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={() => void runTest()} disabled={!valid || !!busy}>
            {busy === "test" && <Spinner size={12} />} Test
          </button>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => void save(false)} disabled={!valid || !!busy}>
            Save
          </button>
          <button type="button" className="btn primary" onClick={() => void save(true)} disabled={!valid || !!busy}>
            {busy === "save" && <Spinner size={12} />} Save & connect
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(true);
        }}
      >
        <div className="segmented kinds" role="radiogroup" aria-label="Database">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={form.kind === k}
              className={form.kind === k ? "active" : ""}
              onClick={() => {
                if (k === form.kind) return;
                const next = switchKind(form, k);
                if (autoName !== null && form.name === autoName) {
                  next.name = autoNameFor(next);
                  setAutoName(next.name);
                }
                setForm(next);
                setTest(null);
              }}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Paste a connection URL</span>
          <input
            className="mono"
            value={url}
            placeholder={URL_HINT[form.kind]}
            onChange={(e) => pasteUrl(e.target.value)}
            aria-label="Connection URL"
          />
          {url && !parseConnectionUrl(url) && <small className="warn">Not a postgres://, mysql:// or sqlite: URL</small>}
        </label>
        <div className="form-divider">
          <span>or fill in</span>
        </div>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            placeholder={autoNameFor(form) || "My database"}
            onChange={(e) => {
              set({ name: e.target.value });
              setAutoName(null);
            }}
          />
        </label>
        {sqlite ? (
          <label className="field">
            <span>Database file</span>
            <input
              className="mono"
              value={form.database}
              placeholder="/path/to/app.db"
              aria-label="Database file"
              onChange={(e) => {
                const next = { ...form, database: e.target.value };
                if (autoName !== null && form.name === autoName) {
                  next.name = autoNameFor(next);
                  setAutoName(next.name);
                }
                setForm(next);
                setTest(null);
              }}
              required
            />
            <small className="muted">An existing SQLite file. A path starting with ~/ is in your home folder.</small>
          </label>
        ) : (
          <>
            <div className="field-row">
              <label className="field grow">
                <span>Host</span>
                <input value={form.host} onChange={(e) => set({ host: e.target.value })} required />
              </label>
              <label className="field port">
                <span>Port</span>
                <input
                  value={form.port}
                  inputMode="numeric"
                  maxLength={5}
                  aria-invalid={!portOk}
                  onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })}
                />
                {!portOk && <small className="warn">1–65535</small>}
              </label>
            </div>
            <div className="field-row">
              <label className="field grow">
                <span>Database</span>
                <input
                  value={form.database}
                  placeholder={form.kind === "mysql" ? "optional: all databases" : ""}
                  onChange={(e) => set({ database: e.target.value })}
                />
              </label>
              <label className="field grow">
                <span>User</span>
                <input value={form.user} onChange={(e) => set({ user: e.target.value })} required />
              </label>
            </div>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={form.password}
                autoComplete="off"
                placeholder={keychainNote}
                onChange={(e) => set({ password: e.target.value })}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.savePassword} onChange={(e) => set({ savePassword: e.target.checked })} />
              <KeyRound size={13} /> Save password in the system keychain
            </label>
          </>
        )}
        <div className="field-row">
          {!sqlite && (
            <label className="field grow">
              <span>SSL</span>
              <select value={form.sslMode} onChange={(e) => set({ sslMode: e.target.value as SslMode })}>
                {SSL.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field">
            <span>Color</span>
            <div className="swatches" role="radiogroup" aria-label="Color">
              {COLORS.map((c) => (
                <button
                  key={c ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={form.color === c}
                  aria-label={c ?? "No color"}
                  className={`swatch ${form.color === c ? "on" : ""} ${c ? "" : "none"}`}
                  style={c ? { background: c } : undefined}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </div>
        </div>
        {!sqlite && form.sslMode === "verify-full" && (
          <label className="field">
            <span>CA certificate file (optional)</span>
            <input
              className="mono"
              value={form.sslRootCert}
              placeholder="/path/to/root.crt (default: the system's trusted roots)"
              onChange={(e) => set({ sslRootCert: e.target.value })}
            />
          </label>
        )}
        <div className="safety">
          <label className="check">
            <input type="checkbox" checked={form.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
            <Lock size={13} /> Read-only <span className="muted small">(the database refuses every write)</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.production}
              // production stands out in red unless another color was picked
              onChange={(e) => set({ production: e.target.checked, color: e.target.checked && !form.color ? "#ef4444" : form.color })}
            />
            <ShieldAlert size={13} /> Production{" "}
            <span className="muted small">(ask before UPDATE / DELETE without WHERE, DROP, TRUNCATE)</span>
          </label>
        </div>
        {/* lets Enter submit */}
        <button type="submit" hidden />
      </form>
      {test && (
        <div className={`test-result ${test.ok ? "ok" : "bad"}`} role="status">
          {test.ok ? <Check size={14} /> : <CircleAlert size={14} />} {test.text}
        </div>
      )}
    </Modal>
  );
}

export function PasswordPrompt({ connId, error }: { connId: string; error?: string }) {
  const conn = useApp((s) => s.connections.find((c) => c.id === connId));
  const { setDialog, connect } = useApp.getState();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setDialog(null);
    await connect(connId, password, remember);
  };
  return (
    <Modal
      title={`Password for ${conn?.name ?? "connection"}`}
      onClose={() => setDialog(null)}
      width={400}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
            Connect
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted small">
          {conn && describeConnection(conn)}
        </p>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </label>
        {error && <div className="test-result bad">{error}</div>}
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <KeyRound size={13} /> Remember in the system keychain
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Risky statements about to run on a production connection. Cancel has the focus. */
export function RiskyDialog({ connName, risks, onConfirm }: { connName: string; risks: Risk[]; onConfirm: () => void }) {
  const { setDialog } = useApp.getState();
  return (
    <Modal
      title={
        <span className="risky-title">
          <ShieldAlert size={16} /> Run on production "{connName}"?
        </span>
      }
      onClose={() => setDialog(null)}
      width={560}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger-solid"
            onClick={() => {
              setDialog(null);
              onConfirm();
            }}
          >
            Run anyway
          </button>
        </>
      }
    >
      <p className="muted small">
        {risks.length === 1 ? "This statement changes" : "These statements change"} more than a few rows, or remove things.
      </p>
      <ul className="risks">
        {risks.map((r, i) => (
          <li key={i}>
            <span className="prod-badge">{r.reason}</span>
            <pre className="mono">{r.statement.length > 300 ? `${r.statement.slice(0, 300)}…` : r.statement}</pre>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm }: { title: string; body: string; action: string; onConfirm: () => void }) {
  const { setDialog } = useApp.getState();
  return (
    <Modal
      title={title}
      onClose={() => setDialog(null)}
      width={420}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger-solid"
            onClick={() => {
              setDialog(null);
              onConfirm();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p className="muted">{body}</p>
    </Modal>
  );
}

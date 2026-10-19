import { Check, CircleAlert, KeyRound } from "lucide-react";
import { useState } from "react";
import { api, toAppError, type ConnectionConfig, type ConnectionInput, type SslMode } from "../lib/api";
import { parsePostgresUrl } from "../lib/format";
import { useApp } from "../lib/store";
import { Modal, Spinner } from "./ui";

const COLORS = [null, "#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444"];
const SSL: { value: SslMode; label: string }[] = [
  { value: "prefer", label: "Prefer (TLS if available)" },
  { value: "disable", label: "Disable" },
  { value: "require", label: "Require (no certificate check)" },
  { value: "verify-full", label: "Verify full (check certificate and host)" },
];

export function ConnectionDialog({ conn }: { conn?: ConnectionConfig }) {
  const { setDialog, connectionSaved, toast } = useApp.getState();
  const [form, setForm] = useState({
    name: conn?.name ?? "",
    host: conn?.host ?? "localhost",
    port: String(conn?.port ?? 5432),
    database: conn?.database ?? "postgres",
    user: conn?.user ?? "postgres",
    password: "",
    sslMode: conn?.sslMode ?? ("prefer" as SslMode),
    savePassword: conn?.savePassword ?? true,
    color: conn?.color ?? null,
    sslRootCert: conn?.sslRootCert ?? "",
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

  const input = (): ConnectionInput => ({
    id: conn?.id,
    name: form.name,
    host: form.host,
    port: Number(form.port) || 5432,
    database: form.database,
    user: form.user,
    sslMode: form.sslMode,
    savePassword: form.savePassword,
    color: form.color,
    sslRootCert: form.sslMode === "verify-full" ? form.sslRootCert.trim() || null : null,
    // empty keeps the saved password when editing
    password: form.password || undefined,
  });

  const pasteUrl = (text: string) => {
    setUrl(text);
    const p = parsePostgresUrl(text);
    if (!p) return;
    const name = `${p.database ?? form.database}@${p.host ?? form.host}`;
    const followUrl = autoName !== null && form.name === autoName;
    setForm((f) => ({
      ...f,
      host: p.host ?? f.host,
      port: p.port ? String(p.port) : f.port,
      database: p.database ?? f.database,
      user: p.user ?? f.user,
      password: p.password ?? f.password,
      sslMode: p.sslMode ?? f.sslMode,
      name: followUrl ? name : f.name,
    }));
    if (followUrl) setAutoName(name);
    setTest(null);
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const r = await api.testConnection(input());
      setTest({ ok: true, text: `Connected · PostgreSQL ${r.serverVersion} · ${r.latencyMs} ms` });
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
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  const valid = form.host.trim() && form.user.trim() && portOk;
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
        <label className="field">
          <span>Paste a connection URL</span>
          <input
            className="mono"
            value={url}
            placeholder="postgres://user:password@host:5432/database"
            onChange={(e) => pasteUrl(e.target.value)}
            aria-label="Connection URL"
          />
          {url && !parsePostgresUrl(url) && <small className="warn">Not a postgres:// URL</small>}
        </label>
        <div className="form-divider">
          <span>or fill in</span>
        </div>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            placeholder={`${form.database}@${form.host}`}
            onChange={(e) => {
              set({ name: e.target.value });
              setAutoName(null);
            }}
          />
        </label>
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
            <input value={form.database} onChange={(e) => set({ database: e.target.value })} />
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
        <div className="field-row">
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
        {form.sslMode === "verify-full" && (
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
          {conn?.user}@{conn?.host}:{conn?.port}/{conn?.database}
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

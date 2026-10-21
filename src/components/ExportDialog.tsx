import { CircleAlert, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, inTauri, newId, toAppError, type AppError, type ExportFormat } from "../lib/api";
import { FORMATS, formatBytes, joinPath, safeFileName, withExtension } from "../lib/export";
import { formatCount, formatDuration } from "../lib/format";
import { useApp, type ExportTarget } from "../lib/store";
import { Modal, Spinner } from "./ui";

/** Writes every row of a table, or of a query result run again, to a file. */
export function ExportDialog({ target }: { target: ExportTarget }) {
  const { setDialog, toast } = useApp.getState();
  const connName = useApp((s) => s.connections.find((c) => c.id === target.connId)?.name ?? "");
  const baseName = target.kind === "table" ? target.query.table : target.name;
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [path, setPath] = useState("");
  const [insertInto, setInsertInto] = useState(target.kind === "table" ? target.query.table : "query_result");
  // the native save dialog already asked about replacing this path
  const [confirmedPath, setConfirmedPath] = useState<string | null>(null);
  const [running, setRunning] = useState<{ queryId: string; startedAt: number } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [now, setNow] = useState(Date.now());
  // still open when the export returns (set on mount too: StrictMode mounts twice)
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .exportDir()
      .catch(() => "~")
      .then((dir) => live && setPath((p) => p || joinPath(dir, `${safeFileName(baseName)}.csv`)));
    return () => {
      live = false;
    };
  }, [baseName]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const pickFormat = (f: ExportFormat) => {
    setFormat(f);
    setPath((p) => withExtension(p, f));
    setError(null);
  };

  const browse = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({
      defaultPath: path || undefined,
      filters: [{ name: FORMATS.find((f) => f.id === format)!.label, extensions: [format] }],
    }).catch((e) => {
      toast(toAppError(e).message, "error");
      return null;
    });
    if (!chosen) return;
    setPath(chosen);
    setConfirmedPath(chosen);
    setError(null);
  };

  const run = async (overwrite = false) => {
    if (running || !path.trim()) return;
    const queryId = newId();
    setError(null);
    setRunning({ queryId, startedAt: Date.now() });
    setNow(Date.now());
    try {
      const out = await api.export({
        id: target.connId,
        queryId,
        source: target.kind === "table" ? { kind: "table", query: target.query } : { kind: "sql", sql: target.sql },
        format,
        path: path.trim(),
        overwrite: overwrite || confirmedPath === path,
        target: format === "sql" ? insertInto : undefined,
        editor: target.kind === "sql" ? target.editor : undefined,
      });
      if (!open.current) return;
      setDialog(null);
      toast(`Exported ${formatCount(out.rows)} row${out.rows === 1 ? "" : "s"} (${formatBytes(out.bytes)}) to ${out.path}`);
    } catch (e) {
      if (!open.current) return;
      setRunning(null);
      setError(toAppError(e));
    }
  };

  const cancel = () => {
    if (running) void api.cancel(running.queryId);
  };
  // closing while it runs stops the export, which then removes its partial file
  const close = () => {
    cancel();
    setDialog(null);
  };

  const what =
    target.kind === "table"
      ? `Every row of ${target.query.schema}.${target.query.table}` +
        (target.query.filters?.length || target.query.whereRaw ? " that matches the filters" : "") +
        (target.query.sort ? `, sorted by ${target.query.sort.column}` : "") +
        " — all pages, not just the one shown."
      : "Runs the query again and writes every row, past the result limit.";
  const exists = error?.code === "exists";

  return (
    <Modal
      title={`Export ${target.kind === "table" ? target.query.table : "query result"}`}
      onClose={close}
      width={520}
      footer={
        <>
          {running && (
            <span className="muted export-progress">
              <Spinner size={13} /> Exporting… {formatDuration(Math.max(0, now - running.startedAt))}
            </span>
          )}
          <div className="spacer" />
          {running ? (
            <button type="button" className="btn" onClick={cancel}>
              Cancel export
            </button>
          ) : (
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          )}
          {exists && !running ? (
            <button type="button" className="btn danger-solid" onClick={() => void run(true)}>
              Replace file
            </button>
          ) : (
            <button type="submit" form="export-form" className="btn primary" disabled={!!running || !path.trim()}>
              Export
            </button>
          )}
        </>
      }
    >
      <form
        id="export-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <p className="muted export-what">
          {what}
          {connName && <span> From {connName}.</span>}
        </p>
        <div className="segmented kinds" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={format === f.id}
              className={format === f.id ? "active" : ""}
              disabled={!!running}
              onClick={() => pickFormat(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="field">
          <span>File</span>
          <div className="field-row">
            <input
              className="grow mono-input"
              value={path}
              disabled={!!running}
              spellCheck={false}
              aria-label="File"
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
            />
            {inTauri && (
              <button type="button" className="btn" disabled={!!running} onClick={() => void browse()}>
                <FolderOpen size={13} /> Browse…
              </button>
            )}
          </div>
        </div>
        {format === "sql" && (
          <label className="field">
            <span>Table name in the INSERTs</span>
            <input value={insertInto} disabled={!!running} spellCheck={false} onChange={(e) => setInsertInto(e.target.value)} />
          </label>
        )}
        {format === "csv" && <p className="muted small-note">A header row, then one line per row. NULL is an empty field, an empty string is "".</p>}
        {format === "json" && <p className="muted small-note">An array of objects; every value is a string or null.</p>}
        {error && (
          <div className="test-result bad" role="alert">
            <CircleAlert size={14} />
            <span>{exists ? "That file already exists. Replace it, or choose another name." : error.message}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}

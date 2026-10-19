import { Braces, CircleAlert, Copy, History, Play, Sheet, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatCount, formatDuration, toCsv, toJson } from "../lib/format";
import { MOD, modKey, useApp, type QueryTab as QueryTabState } from "../lib/store";
import { ConnectionPicker } from "./ConnectionPicker";
import { DataGrid } from "./DataGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Kbd, Spinner, copyText } from "./ui";

/** Range of the token at a Postgres error position, in editor offsets. */
function errorRange(sql: string, offset: number, position?: number) {
  if (!position) return null;
  const from = offset + position - 1;
  let to = from;
  while (to < sql.length && /[\w$."]/.test(sql[to])) to++;
  return { from, to: Math.max(to, from + 1) };
}

/** "line 3" for an editor offset. */
const lineOf = (sql: string, pos: number) => sql.slice(0, pos).split("\n").length;

export function QueryTab({ tab, active }: { tab: QueryTabState; active: boolean }) {
  const editor = useRef<SqlEditorHandle>(null);
  const settings = useApp((s) => s.settings);
  const session = useApp((s) => (tab.connId ? s.sessions[tab.connId] : undefined));
  const { updateTab, runQuery, cancelQuery, openHistory } = useApp.getState();
  const [now, setNow] = useState(Date.now());
  const [vimMode, setVimMode] = useState("");
  const [dragging, setDragging] = useState(false);
  const [rootH, setRootH] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current!;
    const ro = new ResizeObserver(() => setRootH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!tab.running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [tab.running]);

  // focus as soon as the tab is shown (not a tick later), so keys typed right after
  // switching land here
  useLayoutEffect(() => {
    if (active) editor.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const focus = () => editor.current?.focus();
    // Ctrl/⌘ R in a query tab: reload the tables and columns autocomplete knows
    const refresh = () => tab.connId && void useApp.getState().refreshSchema(tab.connId);
    window.addEventListener("dbotter:focus-main", focus);
    window.addEventListener("dbotter:refresh", refresh);
    return () => {
      window.removeEventListener("dbotter:focus-main", focus);
      window.removeEventListener("dbotter:refresh", refresh);
    };
  }, [active, tab.connId]);

  useEffect(() => {
    if (active) window.dispatchEvent(new CustomEvent("dbotter:vim-mode", { detail: vimMode }));
  }, [active, vimMode]);

  const run = (sql: string, offset: number) => void runQuery(tab.id, sql, offset);
  const runCurrent = () => {
    const q = editor.current?.current();
    if (q) run(q.sql, q.offset);
  };
  const runAll = () => {
    const q = editor.current!.all();
    run(q.sql, q.offset);
  };

  // from the text that ran (the editor may have changed while it ran)
  const { range, line } = useMemo(() => {
    const e = tab.error;
    if (!e?.position) return { range: null, line: null };
    const token = errorRange(e.sql, 0, e.position)!;
    const range = { from: e.offset + token.from, to: e.offset + token.to };
    return { range, line: lineOf(tab.sql.slice(0, range.from), range.from) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.error]);

  const result = tab.output?.results[tab.activeResult];
  // a height saved in a bigger window must still leave room for the results
  const height = Math.max(80, Math.min(tab.editorHeight ?? 260, rootH ? rootH - 160 : Infinity));

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const top = root.current!.getBoundingClientRect().top + 40;
    const max = root.current!.clientHeight - 120;
    const move = (ev: MouseEvent) => updateTab(tab.id, { editorHeight: Math.max(80, Math.min(max, ev.clientY - top)) });
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      ref={root}
      className={`query-tab ${dragging ? "resizing" : ""}`}
      onKeyDown={(e) => {
        // run from anywhere in the tab (e.g. while the result grid has focus)
        if (modKey(e) && e.key === "Enter" && !e.defaultPrevented) {
          e.preventDefault();
          if (e.shiftKey) runAll();
          else runCurrent();
        }
      }}
    >
      <div className="toolbar">
        <ConnectionPicker
          value={tab.connId}
          onChange={(connId) => {
            if (connId === tab.connId) return;
            // the tab's own connection belonged to the old database
            void api.releaseEditor(tab.id).catch(() => {});
            updateTab(tab.id, { connId });
          }}
        />
        <div className="toolbar-sep" />
        {tab.running ? (
          <button type="button" className="btn danger" onClick={() => void cancelQuery(tab.id)} title="Cancel the running query">
            <Square size={13} fill="currentColor" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={runCurrent}
            disabled={!tab.connId}
            title={`Run the selection or the statement under the cursor (${MOD} Enter)`}
          >
            <Play size={13} fill="currentColor" /> Run
          </button>
        )}
        <button type="button" className="btn" onClick={runAll} disabled={!tab.connId || !!tab.running} title={`Run everything (${MOD} Shift Enter)`}>
          Run all
        </button>
        <div className="spacer" />
        {session?.status === "connected" && session.info && (
          <span className="muted small toolbar-info">
            {session.info.user}@{session.info.database}
          </span>
        )}
        <button type="button" className="icon-btn" onClick={openHistory} title="Query history">
          <History size={15} />
        </button>
      </div>

      <div className="query-editor" style={{ height }}>
        <SqlEditor
          ref={editor}
          value={tab.sql}
          onChange={(sql) => updateTab(tab.id, { sql })}
          onRun={run}
          schema={session?.schema}
          vim={settings.vim}
          errorRange={range}
          onVimMode={setVimMode}
          autoFocus={active}
        />
      </div>
      <div className="splitter" onMouseDown={startDrag} />

      <div className="results">
        {tab.running && (
          <div className="results-running">
            <Spinner size={13} /> Running… {formatDuration(Math.max(0, now - tab.running.startedAt))}
            <button type="button" className="btn small" onClick={() => void cancelQuery(tab.id)}>
              Cancel
            </button>
          </div>
        )}
        {tab.error && !tab.running && (
          <div className="error-panel" role="alert">
            <CircleAlert size={16} />
            <div>
              <div className="error-message">{tab.error.message}</div>
              {tab.error.detail && <div className="error-extra">Detail: {tab.error.detail}</div>}
              {tab.error.hint && <div className="error-extra">Hint: {tab.error.hint}</div>}
              <div className="error-meta">
                {tab.error.code && <span>SQLSTATE {tab.error.code}</span>}
                {line && <span>Line {line}</span>}
              </div>
            </div>
          </div>
        )}
        {!tab.error && tab.output && (
          <div className={`results-body ${tab.running ? "stale" : ""}`}>
            {tab.output.results.length > 1 && (
              <div className="result-tabs" role="tablist">
                {tab.output.results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={i === tab.activeResult}
                    className={`result-tab ${i === tab.activeResult ? "active" : ""}`}
                    onClick={() => updateTab(tab.id, { activeResult: i })}
                  >
                    {i + 1}. {r.hasRows ? `${formatCount(r.rows.length)} rows` : `${formatCount(r.rowCount)} affected`}
                  </button>
                ))}
              </div>
            )}
            {result?.hasRows ? (
              <DataGrid
                columns={result.columns.map((name) => ({ name }))}
                rows={result.rows}
                vim={settings.vim}
                resetKey={result}
              />
            ) : (
              <div className="results-message">
                {result ? (
                  <>
                    Statement OK · <b>{formatCount(result.rowCount)}</b> row{result.rowCount === 1 ? "" : "s"} affected
                  </>
                ) : (
                  "No statements"
                )}
              </div>
            )}
            <div className="results-foot">
              {result?.hasRows && (
                <span>
                  <b>{formatCount(result.rows.length)}</b> row{result.rows.length === 1 ? "" : "s"}
                </span>
              )}
              <span>{formatDuration(tab.output.durationMs)}</span>
              {tab.output.canceled && (
                <span className="warn" title="Statements after this one didn't run. If the tab had an open transaction, it is now aborted: run ROLLBACK.">
                  Cancelled: later statements didn't run
                </span>
              )}
              {result?.truncated && (
                <span className="warn" title="Rows past the limit were not kept. Change the limit in Settings.">
                  First {formatCount(result.rows.length)}
                  {result.rowCount > result.rows.length ? ` of ${formatCount(result.rowCount)}` : ""} rows (limit in Settings)
                </span>
              )}
              <div className="spacer" />
              {result?.hasRows && (
                <>
                  <button type="button" className="btn ghost small" title="Copy all rows as CSV" aria-label="Copy all rows as CSV" onClick={() => copyText(toCsv(result.columns, result.rows), "Copied all rows as CSV")}>
                    <Sheet size={13} /> <span className="btn-label">CSV</span>
                  </button>
                  <button type="button" className="btn ghost small" title="Copy all rows as JSON" aria-label="Copy all rows as JSON" onClick={() => copyText(toJson(result.columns, result.rows), "Copied all rows as JSON")}>
                    <Braces size={13} /> <span className="btn-label">JSON</span>
                  </button>
                  <button type="button" className="btn ghost small" title="Copy column names" aria-label="Copy column names" onClick={() => copyText(result.columns.join(", "), "Copied column names")}>
                    <Copy size={13} /> <span className="btn-label">Columns</span>
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {!tab.output && !tab.error && !tab.running && (
          <div className="results-empty">
            <div>
              <Kbd>{MOD}</Kbd> <Kbd>Enter</Kbd> run statement under cursor
            </div>
            <div>
              <Kbd>{MOD}</Kbd> <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> run everything
            </div>
            <div>
              <Kbd>{MOD}</Kbd> <Kbd>K</Kbd> command palette
            </div>
            {!tab.connId && <div className="warn">Pick a connection above to run queries.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

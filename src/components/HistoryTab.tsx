import { CircleAlert, Copy, Search, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, toAppError, type HistoryEntry } from "../lib/api";
import { formatCount, formatDuration, timeAgo } from "../lib/format";
import { useApp } from "../lib/store";
import { Spinner, copyText } from "./ui";

export function HistoryTab({ active }: { active: boolean }) {
  const connections = useApp((s) => s.connections);
  const { openQueryTab, setDialog, toast } = useApp.getState();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api
      .history()
      .then(setEntries)
      .catch((e) => {
        setEntries([]);
        toast(toAppError(e).message, "error");
      });

  useEffect(() => {
    if (active) {
      void load();
      setTimeout(() => searchRef.current?.focus(), 0);
    }
    // reload whenever the tab is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const shown = useMemo(() => {
    const all = entries ?? [];
    // every word must appear (subsequence matching is too loose on long SQL)
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((e) => words.every((w) => e.sql.toLowerCase().includes(w))) : all;
  }, [entries, search]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const open = (e?: HistoryEntry) =>
    e && openQueryTab(connections.some((c) => c.id === e.connectionId) ? e.connectionId : undefined, e.sql);

  const keys = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("button")) return;
    const inSearch = e.target === searchRef.current;
    if (e.key === "ArrowDown" || (!inSearch && e.key === "j")) setFocus((f) => Math.min(shown.length - 1, f + 1));
    else if (e.key === "ArrowUp" || (!inSearch && e.key === "k")) setFocus((f) => Math.max(0, f - 1));
    else if (e.key === "Enter") open(shown[focus]);
    else if (!inSearch && e.key === "y" && shown[focus]) void copyText(shown[focus].sql, "Copied SQL");
    else if (!inSearch && e.key === "/") searchRef.current?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div className="history-tab" onKeyDown={keys}>
      <div className="toolbar">
        <div className="search-box">
          <Search size={13} />
          <input ref={searchRef} value={search} placeholder="Search history…" onChange={(e) => { setSearch(e.target.value); setFocus(0); }} aria-label="Search history" />
        </div>
        <div className="spacer" />
        <span className="muted small">{entries ? `${formatCount(shown.length)} queries` : ""}</span>
        <button
          type="button"
          className="btn ghost small"
          disabled={!entries?.length}
          onClick={() =>
            setDialog({
              kind: "confirm",
              title: "Clear query history?",
              body: "Every saved query in the history is deleted. This can't be undone.",
              action: "Clear history",
              onConfirm: () =>
                void api
                  .clearHistory()
                  .then(load)
                  .catch((e) => toast(`Couldn't clear history: ${toAppError(e).message}`, "error")),
            })
          }
        >
          <Trash2 size={13} /> Clear
        </button>
      </div>
      <div ref={list} className="history-list" tabIndex={-1}>
        {entries === null && (
          <div className="center-msg">
            <Spinner /> Loading…
          </div>
        )}
        {entries && !shown.length && <div className="center-msg muted">{search ? "No matches" : "Queries you run show up here"}</div>}
        {shown.map((e, i) => {
          const conn = connections.find((c) => c.id === e.connectionId);
          return (
            <div
              key={e.id}
              data-i={i}
              className={`history-item ${i === focus ? "focused" : ""}`}
              onClick={() => setFocus(i)}
              onDoubleClick={() => open(e)}
            >
              <pre className="history-sql">{e.sql.trim()}</pre>
              <div className="history-meta">
                {conn && (
                  <span>
                    <span className="dot" style={{ background: conn.color ?? "var(--subtle)" }} /> {conn.name}
                  </span>
                )}
                <span>{timeAgo(e.ranAt)}</span>
                <span>{formatDuration(e.durationMs)}</span>
                {e.error ? (
                  <span className="danger-text" title={e.error}>
                    <CircleAlert size={12} /> {e.error.length > 60 ? `${e.error.slice(0, 60)}…` : e.error}
                  </span>
                ) : e.rowCount !== null ? (
                  <span>
                    {formatCount(e.rowCount)} row{e.rowCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                <div className="spacer" />
                <button type="button" className="btn ghost small" onClick={() => open(e)} title="Open in a new query tab (Enter)">
                  <SquareTerminal size={13} /> Open
                </button>
                <button type="button" className="icon-btn tiny" aria-label="Copy SQL" onClick={() => void copyText(e.sql, "Copied SQL")}>
                  <Copy size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

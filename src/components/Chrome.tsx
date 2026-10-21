/** Tab bar, status bar and toasts. */
import { CircleAlert, History, Keyboard, Plus, SquareTerminal, Table, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MOD, useApp, type Tab } from "../lib/store";
import { resolveTheme } from "../lib/themes";
import { Spinner } from "./ui";

function tabLabel(t: Tab) {
  if (t.kind === "query") return t.title;
  if (t.kind === "table") return t.table;
  return "History";
}

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const connections = useApp((s) => s.connections);
  const { setActiveTab, closeTab, openQueryTab, updateTab } = useApp.getState();
  const [renaming, setRenaming] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bar.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="tabbar" ref={bar} role="tablist">
      {tabs.map((t) => {
        const conn = "connId" in t ? connections.find((c) => c.id === t.connId) : undefined;
        const Icon = t.kind === "query" ? SquareTerminal : t.kind === "table" ? Table : History;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab ${t.id === activeId ? "active" : ""}`}
            title={t.kind === "table" ? `${t.schema}.${t.table}${conn ? ` · ${conn.name}` : ""}` : conn?.name}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              } else if (e.button === 0) setActiveTab(t.id);
            }}
            onDoubleClick={() => t.kind === "query" && setRenaming(t.id)}
          >
            {conn?.color && <span className="tab-color" style={{ background: conn.color }} />}
            {t.kind === "query" && t.running ? <Spinner size={12} /> : <Icon size={13} className="tab-icon" />}
            {renaming === t.id && t.kind === "query" ? (
              <input
                className="tab-rename"
                defaultValue={t.title}
                autoFocus
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  updateTab(t.id, { title: e.target.value.trim() || t.title });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-label">{tabLabel(t)}</span>
            )}
            {t.kind === "query" && t.error && !t.running && <CircleAlert size={12} className="tab-error" />}
            <button
              type="button"
              className="tab-close"
              aria-label="Close tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(t.id)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button type="button" className="icon-btn tab-new" title={`New query (${MOD} T)`} onClick={() => openQueryTab()}>
        <Plus size={15} />
      </button>
    </div>
  );
}

export function StatusBar() {
  const connId = useApp((s) => s.currentConnId());
  const conn = useApp((s) => s.connections.find((c) => c.id === connId));
  const session = useApp((s) => (connId ? s.sessions[connId] : undefined));
  const settings = useApp((s) => s.settings);
  const inQuery = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId)?.kind === "query");
  const [vimMode, setVimMode] = useState("");
  const theme = resolveTheme(settings.themeId, settings.customThemes, window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const on = (e: Event) => setVimMode((e as CustomEvent<string>).detail);
    window.addEventListener("dbotter:vim-mode", on);
    return () => window.removeEventListener("dbotter:vim-mode", on);
  }, []);

  return (
    <footer className="statusbar">
      {conn ? (
        <span className="status-conn">
          <span className="dot" style={{ background: conn.color ?? "var(--subtle)" }} />
          {conn.name}
          {session?.status === "connected" && session.info && (
            <span className="muted">
              {" "}
              {" "}
              · {session.info.kind === "sqlite" ? session.info.database : `${session.info.user}@${session.info.database}`} ·{" "}
              {session.info.product} {session.info.serverVersion.split(/[\s-]/)[0]}
            </span>
          )}
          {session?.status === "connecting" && <span className="muted"> · connecting…</span>}
          {!session && <span className="muted"> · not connected</span>}
        </span>
      ) : (
        <span className="muted">No connection</span>
      )}
      <div className="spacer" />
      {settings.vim && (
        <span className={`vim-badge ${inQuery && vimMode.startsWith("insert") ? "insert" : inQuery && vimMode.startsWith("visual") ? "visual" : ""}`}>
          <Keyboard size={12} /> {inQuery && vimMode ? vimMode.toUpperCase() : "VIM"}
        </span>
      )}
      <button type="button" className="status-btn" onClick={() => useApp.getState().setDialog({ kind: "settings" })}>
        {theme.name}
      </button>
      <button type="button" className="status-btn" onClick={() => useApp.getState().setDialog({ kind: "palette", mode: "all" })}>
        {MOD} K
      </button>
    </footer>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" && <CircleAlert size={14} />} {t.text}
        </div>
      ))}
    </div>
  );
}

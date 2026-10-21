/** Tab bar, status bar and toasts. */
import { CircleAlert, Command, Download, Heart, History, Keyboard, Lock, Palette, PanelLeftClose, PanelLeftOpen, Plus, Settings, SquareTerminal, Table, X } from "lucide-react";
import { useUpdates } from "../lib/updates";
import { useEffect, useRef, useState } from "react";
import { MOD, useApp, type Tab } from "../lib/store";
import { resolveTheme } from "../lib/themes";
import { Spinner, useMenu, type MenuItem } from "./ui";

function tabLabel(t: Tab) {
  if (t.kind === "query") return t.title;
  if (t.kind === "table") return t.table;
  return "History";
}

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const connections = useApp((s) => s.connections);
  const { setActiveTab, closeTab, closeTabs, openQueryTab, updateTab, reopenClosedTab } = useApp.getState();
  const hasClosed = useApp((s) => s.closedTabs.length > 0);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const menu = useMenu();

  const tabMenu = (t: Tab, x: number, y: number) => {
    const i = tabs.findIndex((x) => x.id === t.id);
    const ids = (list: Tab[]) => list.map((x) => x.id);
    const connId = "connId" in t ? t.connId : null;
    const conn = connections.find((c) => c.id === connId);
    const sameConn = tabs.filter((x) => "connId" in x && x.connId === connId);
    const tables = tabs.filter((x) => x.kind === "table");
    const item = (label: string, list: Tab[], hint?: string, keep?: string): MenuItem => ({
      label,
      hint,
      disabled: !list.length,
      onSelect: () => closeTabs(ids(list), keep),
    });
    menu.open(x, y, [
      { label: "Close", icon: <X size={14} />, hint: `${MOD} W`, onSelect: () => closeTab(t.id) },
      item("Close others", tabs.filter((x) => x.id !== t.id), undefined, t.id),
      item("Close tabs to the left", tabs.slice(0, i), undefined, t.id),
      item("Close tabs to the right", tabs.slice(i + 1), undefined, t.id),
      item("Close all", tabs),
      "divider",
      ...(conn ? [item(`Close all tabs of "${conn.name}"`, sameConn)] : []),
      item("Close all table tabs", tables, undefined, t.kind === "table" ? undefined : t.id),
      "divider",
      { label: "Reopen closed tab", hint: `${MOD} Shift T`, disabled: !hasClosed, onSelect: reopenClosedTab },
    ]);
  };

  useEffect(() => {
    bar.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="tabbar" ref={bar} role="tablist">
      <button
        type="button"
        className="icon-btn sidebar-toggle"
        title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${MOD} B)`}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-pressed={sidebarOpen}
        onClick={() => useApp.getState().setSidebarOpen(!sidebarOpen)}
      >
        {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
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
            onContextMenu={(e) => {
              e.preventDefault();
              tabMenu(t, e.clientX, e.clientY);
            }}
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
      {menu.element}
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
  const update = useUpdates((s) => s.state);
  const theme = resolveTheme(settings.themeId, settings.customThemes, window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const on = (e: Event) => setVimMode((e as CustomEvent<string>).detail);
    window.addEventListener("dbotter:vim-mode", on);
    return () => window.removeEventListener("dbotter:vim-mode", on);
  }, []);

  return (
    <footer className="statusbar">
      <div className="status-left">
      {conn ? (
        <span className="status-conn">
          <span className="dot" style={{ background: conn.color ?? "var(--subtle)" }} />
          {conn.name}
          {conn.production && <span className="prod-badge">production</span>}
          {conn.readOnly && (
            <span className="ro-badge">
              <Lock size={10} /> read-only
            </span>
          )}
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
      </div>
      <div className="status-center">
        <button type="button" className="status-btn made-with" title="About DbOtter" onClick={() => useApp.getState().setDialog({ kind: "settings", section: "about" })}>
          Made with <Heart size={11} className="heart" fill="currentColor" /> by Gourav Soni
        </button>
      </div>
      <div className="status-right">
      {"version" in update && (
        <button type="button" className="status-btn update-badge" title="Install the new version" onClick={() => useApp.getState().setDialog({ kind: "update" })}>
          <Download size={12} /> Update {update.version}
        </button>
      )}
      {settings.vim && (
        <span className={`vim-badge ${inQuery && vimMode.startsWith("insert") ? "insert" : inQuery && vimMode.startsWith("visual") ? "visual" : ""}`}>
          <Keyboard size={12} /> {inQuery && vimMode ? vimMode.toUpperCase() : "VIM"}
        </span>
      )}
      <button type="button" className="status-btn" title="Change the theme" onClick={() => useApp.getState().setDialog({ kind: "settings", section: "appearance" })}>
        <Palette size={12} /> {theme.name}
      </button>
      <button type="button" className="status-btn" title={`Settings (${MOD} ,)`} onClick={() => useApp.getState().setDialog({ kind: "settings" })}>
        <Settings size={12} /> Settings
      </button>
      <button
        type="button"
        className="status-btn"
        title={`Command palette: every action, connection and table (${MOD} Shift P)`}
        onClick={() => useApp.getState().setDialog({ kind: "palette", mode: "all" })}
      >
        <Command size={12} /> Commands <span className="status-kbd">{MOD} Shift P</span>
      </button>
      </div>
    </footer>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const { dismissToast } = useApp.getState();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${t.action ? "has-action" : ""}`}>
          {t.kind === "error" && <CircleAlert size={14} />} <span className="toast-text">{t.text}</span>
          {t.action && (
            <>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  dismissToast(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
              <button type="button" className="icon-btn toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
                <X size={13} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

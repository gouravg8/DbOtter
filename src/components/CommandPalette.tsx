import {
  Eye,
  History,
  Keyboard,
  Layers,
  PanelLeft,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
  Table,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fuzzyScore } from "../lib/format";
import { MOD, useApp } from "../lib/store";
import { BUILT_IN_THEMES, SYSTEM_THEME_ID } from "../lib/themes";

interface Item {
  id: string;
  label: string;
  /** Extra text that is searched and shown dimmed. */
  detail?: string;
  group: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

const MAX = 80;

export function CommandPalette({ mode }: { mode: "all" | "tables" }) {
  const state = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => state.setDialog(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    const cur = state.currentConnId();
    const curConn = state.connections.find((c) => c.id === cur);
    if (mode === "all") {
      out.push(
        { id: "new-query", label: "New query tab", group: "Actions", icon: <SquareTerminal size={14} />, hint: `${MOD} T`, run: () => state.openQueryTab() },
        { id: "new-conn", label: "New connection", group: "Actions", icon: <Plus size={14} />, run: () => state.setDialog({ kind: "connection" }) },
        { id: "history", label: "Query history", group: "Actions", icon: <History size={14} />, hint: `${MOD} Shift H`, run: () => state.openHistory() },
        { id: "settings", label: "Settings", group: "Actions", icon: <Settings size={14} />, hint: `${MOD} ,`, run: () => state.setDialog({ kind: "settings" }) },
        {
          id: "vim",
          label: state.settings.vim ? "Turn vim mode off" : "Turn vim mode on",
          group: "Actions",
          icon: <Keyboard size={14} />,
          run: () => state.setSettings({ vim: !state.settings.vim }),
        },
        { id: "sidebar", label: state.sidebarOpen ? "Hide sidebar" : "Show sidebar", group: "Actions", icon: <PanelLeft size={14} />, hint: `${MOD} B`, run: () => state.setSidebarOpen(!state.sidebarOpen) },
      );
      if (state.activeTabId)
        out.push({ id: "close-tab", label: "Close tab", group: "Actions", icon: <X size={14} />, hint: `${MOD} W`, run: () => state.closeTab(state.activeTabId!) });
      if (curConn && state.sessions[curConn.id]?.status === "connected")
        out.push(
          { id: "refresh", label: "Refresh schema", detail: curConn.name, group: "Actions", icon: <RefreshCw size={14} />, run: () => void state.refreshSchema(curConn.id) },
          { id: "disconnect", label: "Disconnect", detail: curConn.name, group: "Actions", icon: <Unplug size={14} />, run: () => void state.disconnect(curConn.id) },
        );
      for (const c of state.connections)
        if (state.sessions[c.id]?.status !== "connected")
          out.push({ id: `connect:${c.id}`, label: `Connect to ${c.name}`, detail: `${c.user}@${c.host}/${c.database}`, group: "Connections", icon: <Plug size={14} />, run: () => void state.connect(c.id) });
      for (const t of [{ id: SYSTEM_THEME_ID, name: "System (light / dark)" }, ...BUILT_IN_THEMES, ...state.settings.customThemes])
        out.push({
          id: `theme:${t.id}`,
          label: `Theme: ${t.name}`,
          group: "Themes",
          icon: <Palette size={14} />,
          hint: state.settings.themeId === t.id ? "current" : undefined,
          run: () => state.setSettings({ themeId: t.id }),
        });
    }
    for (const c of state.connections) {
      const schema = state.sessions[c.id]?.schema;
      for (const s of schema?.schemas ?? [])
        for (const r of s.relations)
          out.push({
            id: `rel:${c.id}:${s.name}:${r.name}`,
            label: `${s.name}.${r.name}`,
            detail: state.connections.length > 1 ? c.name : undefined,
            group: "Tables",
            icon: r.kind === "view" ? <Eye size={14} /> : r.kind === "materializedView" ? <Layers size={14} /> : <Table size={14} />,
            run: () => state.openTable(c.id, s.name, r.name, r.kind),
          });
    }
    return out;
    // the palette is short-lived; build once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) return (mode === "tables" ? items : items.filter((i) => i.group !== "Tables")).slice(0, MAX);
    return items
      .map((it) => {
        const s = fuzzyScore(q, it.label);
        const d = it.detail ? fuzzyScore(q, `${it.label} ${it.detail}`) : null;
        const best = s ?? (d === null ? null : d - 2);
        return { it, score: best };
      })
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score! - a.score!)
      .slice(0, MAX)
      .map((x) => x.it);
  }, [items, query, mode]);

  // back to where the user was (e.g. the grid) on close, unless the pick opened another tab
  const [prev] = useState(() => ({ el: document.activeElement as HTMLElement | null, tab: useApp.getState().activeTabId }));
  useEffect(() => {
    input.current?.focus();
    return () => {
      if (useApp.getState().activeTabId === prev.tab) prev.el?.focus?.({ preventScroll: true });
    };
  }, [prev]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  return createPortal(
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Search size={15} />
          <input
            ref={input}
            value={query}
            placeholder={mode === "tables" ? "Go to table…" : "Type a command, table or theme…"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const down = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"));
              const up = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"));
              if (down || up) {
                e.preventDefault();
                setActive((a) => (shown.length ? (a + (down ? 1 : -1) + shown.length) % shown.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(shown[active]);
              } else if (e.key === "Escape") {
                close();
              } else if (e.key === "Tab") {
                // nothing else to focus in here
                e.preventDefault();
              }
              e.stopPropagation();
            }}
            aria-label="Search commands"
          />
        </div>
        <div ref={list} className="palette-list" role="listbox">
          {!shown.length && (
            <div className="palette-empty">
              {mode === "tables" && !items.length ? "Connect to a database to search its tables" : "No matches"}
            </div>
          )}
          {shown.map((it, i) => (
            <div key={it.id}>
              {(i === 0 || shown[i - 1].group !== it.group) && <div className="palette-group">{it.group}</div>}
              <button
                type="button"
                data-i={i}
                role="option"
                aria-selected={i === active}
                className={`palette-item ${i === active ? "active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(it)}
              >
                <span className="palette-icon">{it.icon}</span>
                <span className="palette-label">{it.label}</span>
                {it.detail && <span className="palette-detail">{it.detail}</span>}
                {it.hint && <span className="palette-hint">{it.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

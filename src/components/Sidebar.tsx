/**
 * Connections and their schema tree. Keyboard: j/k or arrows move, l/→ expand,
 * h/← collapse or go to parent, Enter opens, s opens structure, / searches.
 */
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Ellipsis,
  Eye,
  Folder,
  Layers,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Table,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionConfig, RelationKind, RelationNode } from "../lib/api";
import { qualified } from "../lib/dialect";
import { fuzzyScore } from "../lib/format";
import { MOD, useApp } from "../lib/store";
import { Spinner, copyText, useMenu, type MenuItem } from "./ui";

type Row =
  | { kind: "conn"; key: string; depth: 0; conn: ConnectionConfig }
  | { kind: "schema"; key: string; depth: 1; connId: string; schema: string; count: number }
  | { kind: "rel"; key: string; depth: 2; connId: string; schema: string; rel: RelationNode }
  | { kind: "info"; key: string; depth: number; text: string };

const REL_ICON: Record<RelationKind, typeof Table> = {
  table: Table,
  view: Eye,
  materializedView: Layers,
  foreignTable: Table,
};

const KIND_ORDER: Record<RelationKind, number> = { table: 0, foreignTable: 1, view: 2, materializedView: 3 };

/** 1234567 -> "1.2M" */
function shortCount(n: number) {
  if (n < 0) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function Sidebar() {
  const connections = useApp((s) => s.connections);
  const loaded = useApp((s) => s.connectionsLoaded);
  const sessions = useApp((s) => s.sessions);
  const expanded = useApp((s) => s.expanded);
  const width = useApp((s) => s.settings.sidebarWidth);
  const activeTab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const app = useApp.getState();
  const [search, setSearch] = useState("");
  const [focus, setFocusState] = useState(0);
  // keys can arrive faster than renders: handlers read the ref
  const focusRef = useRef(0);
  const setFocus = (i: number) => {
    focusRef.current = i;
    setFocusState(i);
  };
  const tree = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menu = useMenu();
  const exp = useMemo(() => new Set(expanded), [expanded]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = search.trim();
    for (const conn of connections) {
      const s = sessions[conn.id];
      const connKey = `c:${conn.id}`;
      // while searching, only connected sessions with matches, fully expanded
      if (q && s?.status !== "connected") continue;
      const schemaRows: Row[] = [];
      for (const sch of s?.schema?.schemas ?? []) {
        const rels = sch.relations
          .map((rel) => ({ rel, score: q ? fuzzyScore(q, `${sch.name}.${rel.name}`) : 0 }))
          .filter((x) => x.score !== null)
          .sort((a, b) => (q ? b.score! - a.score! : KIND_ORDER[a.rel.kind] - KIND_ORDER[b.rel.kind] || a.rel.name.localeCompare(b.rel.name)));
        if (q && !rels.length) continue;
        const key = `s:${conn.id}:${sch.name}`;
        schemaRows.push({ kind: "schema", key, depth: 1, connId: conn.id, schema: sch.name, count: sch.relations.length });
        if (q || exp.has(key)) {
          for (const { rel } of rels)
            schemaRows.push({ kind: "rel", key: `r:${conn.id}:${sch.name}:${rel.name}`, depth: 2, connId: conn.id, schema: sch.name, rel });
          if (!rels.length) schemaRows.push({ kind: "info", key: `${key}:empty`, depth: 2, text: "No tables" });
        }
      }
      if (q && !schemaRows.length) continue;
      out.push({ kind: "conn", key: connKey, depth: 0, conn });
      if (q || exp.has(connKey)) {
        if (s?.status === "connected") out.push(...schemaRows);
        if (s?.status === "connected" && s.schema && !s.schema.schemas.length)
          out.push({ kind: "info", key: `${connKey}:none`, depth: 1, text: "No schemas" });
      }
    }
    return out;
  }, [connections, sessions, exp, search]);

  const focusIdx = Math.min(focus, Math.max(0, rows.length - 1));

  useEffect(() => {
    const onFocusTree = () => tree.current?.focus();
    window.addEventListener("dbotter:focus-sidebar", onFocusTree);
    return () => window.removeEventListener("dbotter:focus-sidebar", onFocusTree);
  }, []);

  useEffect(() => {
    tree.current?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusIdx]);

  const activate = (row: Row, view: "data" | "structure" = "data") => {
    if (row.kind === "conn") {
      const s = sessions[row.conn.id];
      if (!s || s.status === "error") void app.connect(row.conn.id);
      else app.toggleExpanded(row.key);
    } else if (row.kind === "schema") app.toggleExpanded(row.key);
    else if (row.kind === "rel") app.openTable(row.connId, row.schema, row.rel.name, row.rel.kind, view);
  };

  const connMenu = (conn: ConnectionConfig): (MenuItem | "divider")[] => {
    const connected = sessions[conn.id]?.status === "connected";
    return [
      { label: "New query", icon: <SquareTerminal size={14} />, hint: `${MOD} T`, onSelect: () => app.openQueryTab(conn.id) },
      ...(connected
        ? [
            { label: "Refresh schema", icon: <RefreshCw size={14} />, onSelect: () => void app.refreshSchema(conn.id) },
            { label: "Disconnect", icon: <Unplug size={14} />, onSelect: () => void app.disconnect(conn.id) },
          ]
        : [{ label: "Connect", icon: <Plug size={14} />, onSelect: () => void app.connect(conn.id) }]),
      "divider",
      { label: "Edit connection", icon: <Pencil size={14} />, onSelect: () => app.setDialog({ kind: "connection", conn }) },
      {
        label: "Delete connection",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () =>
          app.setDialog({
            kind: "confirm",
            title: `Delete "${conn.name}"?`,
            body: "The connection is removed, and its saved password is deleted from the system keychain.",
            action: "Delete",
            onConfirm: () => void app.deleteConnection(conn.id),
          }),
      },
    ];
  };

  const relMenu = (row: Extract<Row, { kind: "rel" }>): (MenuItem | "divider")[] => {
    const kind = connections.find((c) => c.id === row.connId)?.kind ?? "postgres";
    const name = qualified(kind, row.schema, row.rel.name);
    return [
      { label: "Open data", icon: <Table size={14} />, hint: "Enter", onSelect: () => activate(row, "data") },
      { label: "Structure", icon: <Columns3 size={14} />, hint: "s", onSelect: () => activate(row, "structure") },
      { label: "New query", icon: <SquareTerminal size={14} />, onSelect: () => app.openQueryTab(row.connId, `SELECT *\nFROM ${name}\nLIMIT 100;`) },
      "divider",
      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copyText(name, "Copied name") },
    ];
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // shortcuts with modifiers belong to the app; keys on a row's own button to the button
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("button")) return;
    const focusIdx = Math.min(focusRef.current, Math.max(0, rows.length - 1));
    const row = rows[focusIdx];
    const k = e.key;
    if (k === "ArrowDown" || k === "j") setFocus(Math.min(rows.length - 1, focusIdx + 1));
    else if (k === "ArrowUp" || k === "k") setFocus(Math.max(0, focusIdx - 1));
    else if (k === "Home" || k === "g") setFocus(0);
    else if (k === "End" || k === "G") setFocus(rows.length - 1);
    else if (k === "/") searchRef.current?.focus();
    else if (!row) return;
    else if (k === "Enter" || k === "o") activate(row);
    else if (k === "s" && row.kind === "rel") activate(row, "structure");
    else if (k === "ArrowRight" || k === "l") {
      if (row.kind === "rel" || row.kind === "info") return;
      if (row.kind === "conn" && !sessions[row.conn.id]) return void app.connect(row.conn.id);
      if (!exp.has(row.key)) app.toggleExpanded(row.key, true);
      else setFocus(Math.min(rows.length - 1, focusIdx + 1));
    } else if (k === "ArrowLeft" || k === "h") {
      if ((row.kind === "conn" || row.kind === "schema") && exp.has(row.key) && !search) app.toggleExpanded(row.key, false);
      else {
        // to the parent
        for (let i = focusIdx - 1; i >= 0; i--) if (rows[i].depth < row.depth) return setFocus(i);
      }
    } else if (k === "Escape" && search) setSearch("");
    else return;
    e.preventDefault();
  };

  const activeRel = activeTab?.kind === "table" ? `r:${activeTab.connId}:${activeTab.schema}:${activeTab.table}` : null;

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <span className="brand">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <circle cx="12" cy="12" r="10" fill="var(--accent)" />
            <circle cx="9" cy="10.5" r="1.4" fill="var(--accent-fg)" />
            <circle cx="15" cy="10.5" r="1.4" fill="var(--accent-fg)" />
            <ellipse cx="12" cy="14.2" rx="2.2" ry="1.5" fill="var(--accent-fg)" />
          </svg>
          DbOtter
        </span>
        <button type="button" className="icon-btn" title="New connection" onClick={() => app.setDialog({ kind: "connection" })}>
          <Plus size={16} />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={13} />
        <input
          ref={searchRef}
          value={search}
          placeholder="Search tables…"
          aria-label="Search tables"
          onChange={(e) => {
            setSearch(e.target.value);
            setFocus(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("");
              tree.current?.focus();
            } else if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              tree.current?.focus();
              const first = rows.findIndex((r) => r.kind === "rel");
              if (first >= 0) {
                setFocus(first);
                if (e.key === "Enter") activate(rows[first]);
              }
            }
          }}
        />
        {search && (
          <button type="button" className="icon-btn tiny" aria-label="Clear search" onClick={() => setSearch("")}>
            <X size={12} />
          </button>
        )}
      </div>

      <div ref={tree} className="tree" tabIndex={0} role="tree" aria-label="Connections" onKeyDown={onKeyDown}>
        {loaded && !connections.length && (
          <div className="tree-empty">
            <p>No connections yet.</p>
            <button type="button" className="btn primary" onClick={() => app.setDialog({ kind: "connection" })}>
              <Plus size={14} /> New connection
            </button>
          </div>
        )}
        {rows.map((row, i) => {
          const focused = i === focusIdx;
          const common = {
            "data-idx": i,
            className: `tree-row depth-${row.depth} ${focused ? "focused" : ""} ${row.key === activeRel ? "current" : ""}`,
            onMouseDown: () => setFocus(i),
          };
          if (row.kind === "info")
            return (
              <div key={row.key} {...common} className={`${common.className} info`}>
                {row.text}
              </div>
            );
          if (row.kind === "conn") {
            const s = sessions[row.conn.id];
            const open = !!search || exp.has(row.key);
            return (
              <div
                key={row.key}
                {...common}
                role="treeitem"
                aria-expanded={open}
                title={s?.status === "connected" ? undefined : "Double-click to connect"}
                // a stray click does nothing: connecting (or opening) takes a double-click
                onDoubleClick={() => activate(row)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  menu.open(e.clientX, e.clientY, connMenu(row.conn));
                }}
              >
                <span
                  className={`chev ${s?.status === "connected" ? "clickable" : ""}`}
                  // the arrow of a connected database opens it with one click
                  onClick={(e) => {
                    if (s?.status !== "connected") return;
                    e.stopPropagation();
                    app.toggleExpanded(row.key);
                  }}
                  onDoubleClick={(e) => s?.status === "connected" && e.stopPropagation()}
                >
                  {s?.status === "connected" ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
                </span>
                <span className="dot" style={{ background: row.conn.color ?? "var(--subtle)" }} />
                <span className="tree-label strong">{row.conn.name}</span>
                <span className="tree-status">
                  {s?.status === "connecting" || s?.schemaLoading ? (
                    <Spinner size={11} />
                  ) : s?.status === "connected" ? (
                    <span className="live" title={`Connected · ${s.info?.product} ${s.info?.serverVersion}`} />
                  ) : s?.status === "error" ? (
                    <span className="err" title={s.error?.message}>!</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="icon-btn tiny row-action"
                  aria-label="Connection actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    menu.open(r.left, r.bottom + 2, connMenu(row.conn));
                  }}
                >
                  <Ellipsis size={14} />
                </button>
              </div>
            );
          }
          if (row.kind === "schema") {
            const open = !!search || exp.has(row.key);
            return (
              <div key={row.key} {...common} role="treeitem" aria-expanded={open} onClick={() => activate(row)}>
                <span className="chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                <Folder size={13} className="tree-icon" />
                <span className="tree-label">{row.schema}</span>
                <span className="tree-count">{row.count}</span>
              </div>
            );
          }
          const Icon = REL_ICON[row.rel.kind];
          return (
            <div
              key={row.key}
              {...common}
              role="treeitem"
              title={`${row.schema}.${row.rel.name}`}
              onClick={() => activate(row)}
              onContextMenu={(e) => {
                e.preventDefault();
                menu.open(e.clientX, e.clientY, relMenu(row));
              }}
            >
              <span className="chev" />
              <Icon size={13} className={`tree-icon kind-${row.rel.kind}`} />
              <span className="tree-label">
                {search && <span className="muted">{row.schema}.</span>}
                {row.rel.name}
              </span>
              <span className="tree-count">{row.rel.kind === "table" || row.rel.kind === "materializedView" ? shortCount(row.rel.estimatedRows) : ""}</span>
            </div>
          );
        })}
      </div>
      <SidebarResizer />
      {menu.element}
    </aside>
  );
}

function SidebarResizer() {
  return (
    <div
      className="sidebar-resizer"
      onMouseDown={(e) => {
        e.preventDefault();
        const move = (ev: MouseEvent) =>
          useApp.getState().setSettings({ sidebarWidth: Math.max(180, Math.min(520, ev.clientX)) });
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.classList.remove("col-resize");
        };
        document.body.classList.add("col-resize");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}

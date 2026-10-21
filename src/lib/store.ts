import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  api,
  newId,
  toAppError,
  type AppError,
  type ConnectionConfig,
  type QueryOutput,
  type RelationKind,
  type SchemaTree,
  type TableQuery,
  type SessionInfo,
  type TxState,
} from "./api";
import { riskyStatements, type Risk } from "./risk";
import { SYSTEM_THEME_ID, type Theme } from "./themes";

export interface Settings {
  themeId: string;
  customThemes: Theme[];
  vim: boolean;
  fontSize: number;
  /** Interface font; empty: the default. */
  uiFont: string;
  /** Editor and grid font; empty: the default. */
  monoFont: string;
  /** Rows kept per query result; the rest are not fetched. */
  maxRows: number;
  pageSize: number;
  sidebarWidth: number;
}

export interface Session {
  status: "connecting" | "connected" | "error";
  info?: SessionInfo;
  schema?: SchemaTree;
  schemaLoading?: boolean;
  error?: AppError;
}

export interface QueryTab {
  id: string;
  kind: "query";
  title: string;
  connId: string | null;
  sql: string;
  /** Set while a query runs; `sent` once the SQL went to the server (before: still connecting). */
  running?: { queryId: string; startedAt: number; sent?: boolean };
  output?: QueryOutput;
  /** The SQL that produced `output` (for exporting a result). */
  outputSql?: string;
  /** `offset`: where the executed text started in the editor; `sql`: that text. */
  error?: AppError & { offset: number; sql: string };
  activeResult: number;
  editorHeight?: number;
  /** The tab's own session, after its last run. */
  tx?: TxState;
}

export interface TableTab {
  id: string;
  kind: "table";
  connId: string;
  schema: string;
  table: string;
  relKind: RelationKind;
  view: "data" | "structure";
}

export interface HistoryTab {
  id: string;
  kind: "history";
}

export type Tab = QueryTab | TableTab | HistoryTab;

export type DialogState =
  | { kind: "connection"; conn?: ConnectionConfig }
  | { kind: "password"; connId: string; error?: string }
  | { kind: "settings" }
  | { kind: "palette"; mode: "all" | "tables" }
  | { kind: "confirm"; title: string; body: string; action: string; onConfirm: () => void }
  | { kind: "risky"; connName: string; risks: Risk[]; onConfirm: () => void }
  | { kind: "export"; target: ExportTarget }
  | { kind: "review"; connId: string; title: string; statements: string[]; onSave: (queryId: string) => Promise<void> }
  | null;

/** What an export dialog writes: a table tab's rows (all pages, its filters and sort) or a
 * query tab's result, run again. */
export type ExportTarget =
  | { kind: "table"; connId: string; query: TableQuery }
  | { kind: "sql"; connId: string; sql: string; name: string; editor: string };

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "error";
  /** A button on the toast (it then stays longer and can be closed). */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

interface State {
  settings: Settings;
  connections: ConnectionConfig[];
  connectionsLoaded: boolean;
  sessions: Record<string, Session>;
  tabs: Tab[];
  activeTabId: string | null;
  /** Connection used for new query tabs when the active tab has none. */
  lastConnId: string | null;
  sidebarOpen: boolean;
  /** Expanded tree nodes: "c:<conn>", "s:<conn>:<schema>". */
  expanded: string[];
  dialog: DialogState;
  toasts: Toast[];
  /** Recently closed tabs, newest last (Ctrl/⌘ Shift T reopens). */
  closedTabs: Tab[];
  /** Edited cells not saved yet, per tab (closing such a tab asks first). */
  unsaved: Record<string, number>;
  setUnsaved: (tabId: string, n: number) => void;

  setSettings: (patch: Partial<Settings>) => void;
  loadConnections: () => Promise<void>;
  /** `waitSchema: false` returns once connected, loading the schema in the background. */
  connect: (id: string, password?: string, remember?: boolean, waitSchema?: boolean) => Promise<boolean>;
  /** One connect attempt (internal; use `connect`). */
  connectAttempt: (id: string, attempt: number, password?: string, remember?: boolean, waitSchema?: boolean) => Promise<boolean>;
  /** After a connection was edited: the backend dropped its session; reconnect if it was open. */
  connectionSaved: (id: string, connect: boolean) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  refreshSchema: (id: string) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  toggleExpanded: (key: string, open?: boolean) => void;

  openQueryTab: (connId?: string | null, sql?: string) => string;
  openTable: (connId: string, schema: string, table: string, relKind: RelationKind, view?: TableTab["view"]) => void;
  openHistory: () => void;
  /** Asks first when the tab has an open transaction (closing rolls it back), unless `force`. */
  closeTab: (id: string, force?: boolean) => void;
  /** Closes several tabs; `keep` (if given) becomes the active one. */
  closeTabs: (ids: string[], keep?: string, force?: boolean) => void;
  /** Asks the tab's session whether it is inside a transaction. */
  refreshTx: (tabId: string) => Promise<void>;
  /** COMMIT or ROLLBACK the tab's transaction, leaving its results as they are. */
  endTransaction: (tabId: string, statement: "COMMIT" | "ROLLBACK") => Promise<void>;
  reopenClosedTab: () => void;
  setActiveTab: (id: string) => void;
  cycleTab: (delta: 1 | -1) => void;
  updateTab: (id: string, patch: Partial<QueryTab> | Partial<TableTab>) => void;
  /** `confirmed`: the user already agreed to run risky statements on a production connection. */
  runQuery: (tabId: string, sql: string, offset: number, confirmed?: boolean) => Promise<void>;
  cancelQuery: (tabId: string) => Promise<void>;

  setDialog: (d: DialogState) => void;
  setSidebarOpen: (v: boolean) => void;
  toast: (text: string, kind?: Toast["kind"], action?: ToastAction) => void;
  dismissToast: (id: string) => void;
  currentConnId: () => string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  themeId: SYSTEM_THEME_ID,
  customThemes: [],
  vim: false,
  fontSize: 13,
  uiFont: "",
  monoFont: "",
  maxRows: 5000,
  pageSize: 100,
  sidebarWidth: 260,
};

/** Latest connect attempt per connection: answers from older attempts are ignored. */
const connectAttempts = new Map<string, number>();
/** The attempt in flight, shared by callers that bring no new password (e.g. two tabs running). */
const inFlight = new Map<string, Promise<boolean>>();
/** Disconnect / delete: an attempt still in flight must not bring the session back. */
const invalidateConnect = (id: string) => {
  connectAttempts.set(id, (connectAttempts.get(id) ?? 0) + 1);
  inFlight.delete(id);
};

const queryTitle = (tabs: Tab[]) => {
  const used = new Set(tabs.filter((t) => t.kind === "query").map((t) => (t as QueryTab).title));
  for (let i = 1; ; i++) if (!used.has(`Query ${i}`)) return `Query ${i}`;
};

export const useApp = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      connections: [],
      connectionsLoaded: false,
      sessions: {},
      tabs: [],
      activeTabId: null,
      lastConnId: null,
      sidebarOpen: true,
      expanded: [],
      dialog: null,
      toasts: [],
      closedTabs: [],
      unsaved: {},

      setSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

      loadConnections: async () => {
        try {
          const connections = await api.connections();
          set({ connections, connectionsLoaded: true });
        } catch (e) {
          set({ connectionsLoaded: true });
          get().toast(`Couldn't load connections: ${toAppError(e).message}`, "error");
        }
      },

      connect: (id, password, remember, waitSchema = true) => {
        // already connecting with the saved settings: wait for that instead of racing it
        const pending = inFlight.get(id);
        if (pending && password === undefined) return pending;
        const attempt = (connectAttempts.get(id) ?? 0) + 1;
        connectAttempts.set(id, attempt);
        const p = get().connectAttempt(id, attempt, password, remember, waitSchema);
        inFlight.set(id, p);
        void p.finally(() => inFlight.get(id) === p && inFlight.delete(id));
        return p;
      },

      connectAttempt: async (id, attempt, password, remember, waitSchema) => {
        const latest = () => connectAttempts.get(id) === attempt;
        // superseded: the caller gets the newer attempt's outcome (false if none, e.g. disconnected)
        const outcome = () => inFlight.get(id) ?? Promise.resolve(get().sessions[id]?.status === "connected");
        const patchSession = (s: Session) => set({ sessions: { ...get().sessions, [id]: s } });
        patchSession({ ...get().sessions[id], status: "connecting", error: undefined });
        try {
          const info = await api.connect(id, password, remember);
          if (!latest()) {
            // disconnected or deleted meanwhile: close what the backend just opened
            if (!inFlight.has(id) && !get().sessions[id]) void api.disconnect(id).catch(() => {});
            return outcome();
          }
          patchSession({ status: "connected", info });
          if (remember) void get().loadConnections();
          set({ lastConnId: id });
          get().toggleExpanded(`c:${id}`, true);
          if (waitSchema) await get().refreshSchema(id);
          else void get().refreshSchema(id);
          return true;
        } catch (e) {
          if (!latest()) return outcome();
          const error = toAppError(e);
          if (error.code === "password_required") {
            patchSession({ status: "error", error });
            set({ dialog: { kind: "password", connId: id, error: password ? error.message : undefined } });
            return false;
          }
          patchSession({ status: "error", error });
          get().toast(error.message, "error");
          return false;
        }
      },

      connectionSaved: async (id, connect) => {
        const was = get().sessions[id]?.status === "connected";
        // an attempt with the old settings must not win (or be joined)
        invalidateConnect(id);
        if (get().sessions[id]) {
          const sessions = { ...get().sessions };
          delete sessions[id];
          set({ sessions });
        }
        await get().loadConnections();
        if (connect || was) await get().connect(id);
      },

      disconnect: async (id) => {
        invalidateConnect(id);
        await api.disconnect(id).catch(() => {});
        const sessions = { ...get().sessions };
        delete sessions[id];
        set({ sessions });
      },

      refreshSchema: async (id) => {
        const s = get().sessions[id];
        if (!s || s.status !== "connected") return;
        set({ sessions: { ...get().sessions, [id]: { ...s, schemaLoading: true } } });
        // disconnected or deleted meanwhile: don't bring the session back
        const live = () => get().sessions[id]?.status === "connected";
        try {
          const schema = await api.schema(id);
          if (!live()) return;
          set({ sessions: { ...get().sessions, [id]: { ...get().sessions[id], schema, schemaLoading: false } } });
          // first time: open the "public" schema (or the only one)
          const exp = get().expanded;
          if (!exp.some((k) => k.startsWith(`s:${id}:`))) {
            // the connection's own schema (public, the MySQL database, main) when it has tables
            const home = get().sessions[id]?.info?.defaultSchema || "public";
            const first = schema.schemas.find((x) => x.name === home && x.relations.length) ?? schema.schemas[0];
            if (first) get().toggleExpanded(`s:${id}:${first.name}`, true);
          }
        } catch (e) {
          if (!live()) return;
          set({ sessions: { ...get().sessions, [id]: { ...get().sessions[id], schemaLoading: false } } });
          get().toast(`Couldn't load schema: ${toAppError(e).message}`, "error");
        }
      },

      deleteConnection: async (id) => {
        invalidateConnect(id);
        try {
          await api.deleteConnection(id);
        } catch (e) {
          get().toast(`Couldn't delete the connection: ${toAppError(e).message}`, "error");
          return;
        }
        const sessions = { ...get().sessions };
        delete sessions[id];
        set({
          sessions,
          tabs: get().tabs.map((t) => (t.kind === "query" && t.connId === id ? { ...t, connId: null } : t)).filter(
            (t) => t.kind !== "table" || t.connId !== id,
          ),
          lastConnId: get().lastConnId === id ? null : get().lastConnId,
          closedTabs: get().closedTabs.filter((t) => t.kind !== "table" || t.connId !== id),
        });
        if (!get().tabs.some((t) => t.id === get().activeTabId)) set({ activeTabId: get().tabs.at(-1)?.id ?? null });
        await get().loadConnections();
      },

      toggleExpanded: (key, open) => {
        const has = get().expanded.includes(key);
        const want = open ?? !has;
        if (want === has) return;
        set({ expanded: want ? [...get().expanded, key] : get().expanded.filter((k) => k !== key) });
      },

      openQueryTab: (connId, sql = "") => {
        const tab: QueryTab = {
          id: newId(),
          kind: "query",
          title: queryTitle(get().tabs),
          connId: connId === undefined ? get().currentConnId() : connId,
          sql,
          activeResult: 0,
        };
        set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
        return tab.id;
      },

      openTable: (connId, schema, table, relKind, view = "data") => {
        const existing = get().tabs.find(
          (t) => t.kind === "table" && t.connId === connId && t.schema === schema && t.table === table,
        ) as TableTab | undefined;
        if (existing) {
          set({
            activeTabId: existing.id,
            tabs: get().tabs.map((t) => (t.id === existing.id ? { ...existing, view } : t)),
          });
        } else {
          const tab: TableTab = { id: newId(), kind: "table", connId, schema, table, relKind, view };
          set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
        }
        set({ lastConnId: connId });
      },

      openHistory: () => {
        const existing = get().tabs.find((t) => t.kind === "history");
        if (existing) return set({ activeTabId: existing.id });
        const tab: HistoryTab = { id: newId(), kind: "history" };
        set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
      },

      closeTab: (id, force = false) => {
        const tabs = get().tabs;
        const i = tabs.findIndex((t) => t.id === id);
        if (i < 0) return;
        const open = tabs[i];
        const inTx = open.kind === "query" && (open.tx === "open" || open.tx === "aborted");
        const unsaved = get().unsaved[id] ?? 0;
        if (!force && (inTx || unsaved)) {
          const what = [inTx && "an open transaction (closing rolls it back)", unsaved && `${unsaved} unsaved changed value${unsaved === 1 ? "" : "s"}`].filter(Boolean);
          set({
            dialog: {
              kind: "confirm",
              title: `Close "${open.kind === "query" ? open.title : open.kind === "table" ? open.table : "History"}"?`,
              body: `It has ${what.join(" and ")}.`,
              action: inTx ? "Close and roll back" : "Close and discard",
              onConfirm: () => get().closeTab(id, true),
            },
          });
          return;
        }
        const tab = tabs[i];
        if (tab.kind === "query") {
          // a run still connecting just stops (runQuery sees the tab is gone)
          if (tab.running?.sent) void api.cancel(tab.running.queryId).catch(() => {});
          // its own connection (and any open transaction) goes away with it
          void api.releaseEditor(tab.id).catch(() => {});
        }
        const rest = tabs.filter((t) => t.id !== id);
        const activeTabId = get().activeTabId === id ? (rest[i] ?? rest[i - 1])?.id ?? null : get().activeTabId;
        const closed: Tab = tab.kind === "query" ? { ...tab, running: undefined, output: undefined, outputSql: undefined, error: undefined } : tab;
        set({ tabs: rest, activeTabId, closedTabs: [...get().closedTabs, closed].slice(-10) });
      },

      closeTabs: (ids, keep, force = false) => {
        const pending = get().tabs.filter((t) => ids.includes(t.id) && t.kind === "query" && (t.tx === "open" || t.tx === "aborted"));
        const edited = ids.filter((id) => get().unsaved[id]).length;
        if (!force && (pending.length || edited)) {
          const n = pending.length;
          const what = [
            n && `${n} ${n === 1 ? "has an open transaction" : "have open transactions"} (closing rolls ${n === 1 ? "it" : "them"} back)`,
            edited && `${edited} ${edited === 1 ? "has" : "have"} unsaved changes`,
          ].filter(Boolean);
          set({
            dialog: {
              kind: "confirm",
              title: `Close ${ids.length} tab${ids.length === 1 ? "" : "s"}?`,
              body: `Of them, ${what.join(" and ")}.`,
              action: n ? "Close and roll back" : "Close and discard",
              onConfirm: () => get().closeTabs(ids, keep, true),
            },
          });
          return;
        }
        for (const id of ids) get().closeTab(id, true);
        if (keep && get().tabs.some((t) => t.id === keep)) get().setActiveTab(keep);
      },

      reopenClosedTab: () => {
        const closed = [...get().closedTabs];
        const { tabs, connections } = get();
        for (let tab = closed.pop(); tab; tab = closed.pop()) {
          const t0 = tab;
          // already open again (history, the same table): just show it
          const open = tabs.find(
            (t) =>
              t.id === t0.id ||
              (t.kind === "history" && t0.kind === "history") ||
              (t.kind === "table" && t0.kind === "table" && t.connId === t0.connId && t.schema === t0.schema && t.table === t0.table),
          );
          if (open) return set({ activeTabId: open.id, closedTabs: closed });
          if (t0.kind === "table" && !connections.some((c) => c.id === t0.connId)) continue; // connection deleted
          let restored: Tab = t0;
          if (t0.kind === "query") {
            const taken = tabs.some((t) => t.kind === "query" && t.title === t0.title);
            restored = { ...t0, title: taken ? queryTitle(tabs) : t0.title, connId: connections.some((c) => c.id === t0.connId) ? t0.connId : null };
          }
          return set({ tabs: [...tabs, restored], activeTabId: restored.id, closedTabs: closed });
        }
        set({ closedTabs: closed });
      },

      setActiveTab: (id) => {
        const tab = get().tabs.find((t) => t.id === id);
        set({ activeTabId: id });
        if (tab && "connId" in tab && tab.connId) set({ lastConnId: tab.connId });
      },

      cycleTab: (delta) => {
        const { tabs, activeTabId } = get();
        if (!tabs.length) return;
        const i = tabs.findIndex((t) => t.id === activeTabId);
        get().setActiveTab(tabs[(i + delta + tabs.length) % tabs.length].id);
      },

      updateTab: (id, patch) =>
        set({ tabs: get().tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }),

      runQuery: async (tabId, sql, offset, confirmed = false) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind !== "query" || !sql.trim()) return;
        if (tab.running) return get().toast("A query is already running in this tab (cancel it first)", "error");
        if (!tab.connId) return get().toast("Pick a connection for this tab first", "error");
        const connId = tab.connId;
        const conn = get().connections.find((c) => c.id === connId);
        // production: UPDATE / DELETE without WHERE, DROP, TRUNCATE wait for a yes
        if (conn?.production && !confirmed) {
          const risks = riskyStatements(sql);
          if (risks.length) {
            set({ dialog: { kind: "risky", connName: conn.name, risks, onConfirm: () => void get().runQuery(tabId, sql, offset, true) } });
            return;
          }
        }
        const queryId = newId();
        const startedAt = Date.now();
        // still this tab's current run? (cancelled, closed or replaced meanwhile: drop it)
        const current = () => {
          const t = get().tabs.find((x) => x.id === tabId);
          return t?.kind === "query" && t.running?.queryId === queryId;
        };
        // marked running before connecting, so a second run can't slip in meanwhile
        get().updateTab(tabId, { running: { queryId, startedAt }, error: undefined });
        if (get().sessions[connId]?.status !== "connected") {
          const ok = await get().connect(connId, undefined, false, false);
          if (!current()) return;
          if (!ok) return get().updateTab(tabId, { running: undefined });
        }
        get().updateTab(tabId, { running: { queryId, startedAt, sent: true } });
        try {
          const output = await api.run(connId, queryId, sql, get().settings.maxRows, tabId);
          if (!current()) return;
          // show the last result that has rows (or the last statement's count)
          const withRows = output.results.map((r, i) => (r.hasRows ? i : -1)).filter((i) => i >= 0);
          const activeResult = withRows.length ? withRows.at(-1)! : Math.max(0, output.results.length - 1);
          get().updateTab(tabId, { running: undefined, output, outputSql: sql, activeResult });
          void get().refreshTx(tabId);
          // DDL changes what the sidebar and autocomplete should show
          if (/\b(create|alter|drop|rename|truncate|comment)\b/i.test(sql)) void get().refreshSchema(connId);
        } catch (e) {
          if (!current()) return;
          const error = toAppError(e);
          get().updateTab(tabId, { running: undefined, error: { ...error, offset, sql } });
          void get().refreshTx(tabId);
          if (error.code === "not_connected") {
            const sessions = { ...get().sessions };
            delete sessions[connId];
            set({ sessions });
          }
        }
      },

      refreshTx: async (tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab?.kind !== "query" || !tab.connId) return;
        const tx = await api.transactionStatus(tab.connId, tabId).catch((): TxState => "unknown");
        if (get().tabs.some((t) => t.id === tabId)) get().updateTab(tabId, { tx });
      },

      endTransaction: async (tabId, statement) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab?.kind !== "query" || !tab.connId || tab.running) return;
        try {
          await api.run(tab.connId, newId(), statement, 1, tabId);
          get().toast(statement === "COMMIT" ? "Committed" : "Rolled back");
        } catch (e) {
          get().toast(toAppError(e).message, "error");
        }
        await get().refreshTx(tabId);
      },

      cancelQuery: async (tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab?.kind !== "query" || !tab.running) return;
        // still connecting: nothing reached the server yet, so stop it here
        if (!tab.running.sent) {
          get().updateTab(tabId, { running: undefined });
          return get().toast("Cancelled before it started");
        }
        await api.cancel(tab.running.queryId).catch((e) => get().toast(toAppError(e).message, "error"));
      },

      setDialog: (dialog) => set({ dialog }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

      toast: (text, kind = "info", action) => {
        const t: Toast = { id: newId(), text, kind, action };
        set({ toasts: [...get().toasts, t].slice(-4) });
        // time to read it and reach for the button
        setTimeout(() => get().dismissToast(t.id), action ? 10000 : kind === "error" ? 6000 : 2200);
      },
      setUnsaved: (tabId, n) => {
        if ((get().unsaved[tabId] ?? 0) === n) return;
        const unsaved = { ...get().unsaved };
        if (n) unsaved[tabId] = n;
        else delete unsaved[tabId];
        set({ unsaved });
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),

      currentConnId: () => {
        const { tabs, activeTabId, lastConnId, connections } = get();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (tab && "connId" in tab && tab.connId) return tab.connId;
        if (lastConnId && connections.some((c) => c.id === lastConnId)) return lastConnId;
        return connections.length === 1 ? connections[0].id : null;
      },
    }),
    {
      name: "dbotter",
      version: 2,
      // v1's default page size was 200; settings saved with it move to the new default
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as { settings?: Settings };
        if (version < 2 && p.settings?.pageSize === 200) p.settings = { ...p.settings, pageSize: 100 };
        // merge() below fills in anything missing
        return p as never;
      },
      // results and live state are not kept across restarts
      partialize: (s) => ({
        settings: s.settings,
        tabs: s.tabs.map((t) =>
          t.kind === "query" ? { ...t, running: undefined, output: undefined, outputSql: undefined, error: undefined, tx: undefined } : t,
        ),
        activeTabId: s.activeTabId,
        lastConnId: s.lastConnId,
        sidebarOpen: s.sidebarOpen,
        expanded: s.expanded,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return { ...current, ...p, settings: { ...DEFAULT_SETTINGS, ...p.settings } };
      },
    },
  ),
);

/** Platform modifier: ⌘ on macOS, Ctrl elsewhere. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (e: KeyboardEvent | ReactKeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
export const MOD = isMac ? "⌘" : "Ctrl";

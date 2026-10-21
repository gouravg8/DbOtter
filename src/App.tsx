import { Plus, SquareTerminal } from "lucide-react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { Kbd } from "./components/ui";
import { StatusBar, TabBar, Toasts } from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { ReviewDialog } from "./components/Edits";
import { ExportDialog } from "./components/ExportDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { ConfirmDialog, ConnectionDialog, PasswordPrompt, RiskyDialog } from "./components/ConnectionDialog";
import { HistoryTab } from "./components/HistoryTab";
import { QueryTab } from "./components/QueryTab";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TableTab } from "./components/TableTab";
import { MOD, isMac, modKey, useApp } from "./lib/store";
import { fontStack } from "./lib/fonts";
import { applyTheme, resolveTheme } from "./lib/themes";
import { checkForUpdate } from "./lib/updates";

const DARK = "(prefers-color-scheme: dark)";

function useTheme() {
  const themeId = useApp((s) => s.settings.themeId);
  const custom = useApp((s) => s.settings.customThemes);
  const fontSize = useApp((s) => s.settings.fontSize);
  const uiFont = useApp((s) => s.settings.uiFont);
  const monoFont = useApp((s) => s.settings.monoFont);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia(DARK).matches);
  useEffect(() => {
    const mq = window.matchMedia(DARK);
    const on = () => setPrefersDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => applyTheme(resolveTheme(themeId, custom, prefersDark)), [themeId, custom, prefersDark]);
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
    document.documentElement.style.setProperty("--grid-font-size", `${Math.max(10, fontSize - 0.5)}px`);
  }, [fontSize]);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--ui", fontStack(uiFont, "--ui-default"));
    root.setProperty("--mono", fontStack(monoFont, "--mono-default"));
  }, [uiFont, monoFont]);
}

/** Keys vim uses in the editor (Ctrl+W delete word, Ctrl+R redo, Ctrl+B/F page…): with vim
 * mode on and the editor focused they go to vim, not to the app. */
const VIM_KEYS = new Set(["w", "b", "e", "r", "f", "g"]);

/** App-wide shortcuts. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const mod = modKey(e);
      const k = e.key.toLowerCase();
      if (s.dialog && s.dialog.kind !== "palette") return;
      const inEditor = !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
      if (inEditor && s.settings.vim && e.ctrlKey && !e.shiftKey && VIM_KEYS.has(k)) return;
      // the palette moves its selection with Ctrl+K / Ctrl+P (Ctrl+N / Ctrl+J too)
      if (s.dialog?.kind === "palette" && e.ctrlKey && !e.shiftKey && !isMac && (k === "k" || k === "p")) return;

      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        return s.cycleTab(e.shiftKey ? -1 : 1);
      }
      if (!mod) return;
      if (k === "p" && e.shiftKey) s.setDialog(s.dialog?.kind === "palette" ? null : { kind: "palette", mode: "all" });
      else if (k === "p") s.setDialog({ kind: "palette", mode: "tables" });
      else if (s.dialog) return;
      else if (k === "t" && e.shiftKey) s.reopenClosedTab();
      else if (k === "t") s.openQueryTab();
      else if (k === "w") s.activeTabId && s.closeTab(s.activeTabId);
      else if (k === "b") s.setSidebarOpen(!s.sidebarOpen);
      else if (k === ",") s.setDialog({ kind: "settings" });
      else if (k === "r") window.dispatchEvent(new Event("dbotter:refresh"));
      else if (k === "h" && e.shiftKey) s.openHistory();
      else if (k === "e" && e.shiftKey) {
        const focus = () => window.dispatchEvent(new Event("dbotter:focus-sidebar"));
        // focus right away so the next key lands in the tree; wait a render if it was hidden
        if (s.sidebarOpen) focus();
        else {
          s.setSidebarOpen(true);
          setTimeout(focus, 0);
        }
      } else if (k === "e") window.dispatchEvent(new Event("dbotter:focus-main"));
      else if ((e.key === "]" || e.key === "}") && e.shiftKey) s.cycleTab(1);
      else if ((e.key === "[" || e.key === "{") && e.shiftKey) s.cycleTab(-1);
      else if (/^[1-9]$/.test(e.key)) {
        const t = e.key === "9" ? s.tabs.at(-1) : s.tabs[Number(e.key) - 1];
        if (t) s.setActiveTab(t.id);
      } else return;
      e.preventDefault();
    };
    // the webview's own reload / print / find (Ctrl/⌘ R P F G, F5)
    const isBrowserKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      return (modKey(e) && k.length === 1 && "rpfg".includes(k)) || e.key === "F5";
    };
    // dialogs, menus and inputs that stop key events from bubbling: block here, early
    const guardOverlays = (e: KeyboardEvent) => {
      if (isBrowserKey(e) && (e.target as HTMLElement | null)?.closest?.(".modal, .menu, .palette, .tab-rename")) e.preventDefault();
    };
    // everywhere else: after the editor (search, vim redo) had its chance (bubble phase)
    const blockDefaults = (e: KeyboardEvent) => {
      if (!isBrowserKey(e)) return;
      const free = !e.defaultPrevented;
      if (free) e.preventDefault();
      if (free && e.key === "F5" && !useApp.getState().dialog) window.dispatchEvent(new Event("dbotter:refresh"));
    };
    // a key aimed at a tab that was just hidden (switching tabs, then typing at once) must
    // not act on it: app shortcuts still work, anything else is dropped
    const guardHiddenTabs = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && (e.target as HTMLElement | null)?.closest?.(".tab-pane[hidden]")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // capture: runs before the editor swallows Ctrl+Shift+P etc.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keydown", guardHiddenTabs, true);
    window.addEventListener("keydown", guardOverlays, true);
    window.addEventListener("keydown", blockDefaults);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keydown", guardHiddenTabs, true);
      window.removeEventListener("keydown", guardOverlays, true);
      window.removeEventListener("keydown", blockDefaults);
    };
  }, []);
}

/** Looks for an update a little after start (not to slow it down), then every 6 hours. */
function useUpdateCheck() {
  useEffect(() => {
    const run = async () => {
      const found = await checkForUpdate(true);
      if (found.status !== "available") return;
      const { toast, setDialog } = useApp.getState();
      toast(`DbOtter ${found.version} is available`, "info", { label: "View", run: () => setDialog({ kind: "update" }) });
    };
    const first = setTimeout(run, 5000);
    const every = setInterval(run, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
}

/** Shows render errors instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome" role="alert">
        <h1>Something went wrong</h1>
        <pre className="crash">{this.state.error.message}</pre>
        <div className="welcome-actions">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Reload DbOtter
          </button>
        </div>
      </div>
    );
  }
}

function Welcome() {
  const hasConnections = useApp((s) => s.connections.length > 0);
  const { openQueryTab, setDialog } = useApp.getState();
  return (
    <div className="welcome">
      <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden>
        <circle cx="12" cy="12" r="10" fill="var(--accent)" />
        <circle cx="9" cy="10.5" r="1.4" fill="var(--accent-fg)" />
        <circle cx="15" cy="10.5" r="1.4" fill="var(--accent-fg)" />
        <ellipse cx="12" cy="14.2" rx="2.2" ry="1.5" fill="var(--accent-fg)" />
      </svg>
      <h1>DbOtter</h1>
      <p className="muted">A fast, keyboard-first client for PostgreSQL, MySQL / MariaDB and SQLite.</p>
      <div className="welcome-actions">
        {hasConnections ? (
          <button type="button" className="btn primary" onClick={() => openQueryTab()}>
            <SquareTerminal size={14} /> New query
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => setDialog({ kind: "connection" })}>
            <Plus size={14} /> Add a connection
          </button>
        )}
      </div>
      <div className="welcome-keys">
        <span><Kbd>{MOD}</Kbd> <Kbd>Shift</Kbd> <Kbd>P</Kbd> commands</span>
        <span><Kbd>{MOD}</Kbd> <Kbd>P</Kbd> go to table</span>
        <span><Kbd>{MOD}</Kbd> <Kbd>T</Kbd> new query</span>
      </div>
    </div>
  );
}

export default function App() {
  useTheme();
  useShortcuts();
  useUpdateCheck();
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const dialog = useApp((s) => s.dialog);

  useEffect(() => {
    void useApp.getState().loadConnections();
  }, []);

  return (
    <ErrorBoundary>
    <div className="app">
      <div className="app-main">
        {sidebarOpen && <Sidebar />}
        <main className="workspace">
          <TabBar />
          <div className="tab-content">
            {!tabs.length && <Welcome />}
            {tabs.map((t) => (
              // tabs stay mounted so the editor, scroll and results survive switching
              <div key={t.id} data-tab={t.id} className="tab-pane" hidden={t.id !== activeId}>
                {t.kind === "query" && <QueryTab tab={t} active={t.id === activeId} />}
                {t.kind === "table" && <TableTab tab={t} active={t.id === activeId} />}
                {t.kind === "history" && <HistoryTab active={t.id === activeId} />}
              </div>
            ))}
          </div>
        </main>
      </div>
      <StatusBar />
      {dialog?.kind === "connection" && <ConnectionDialog conn={dialog.conn} />}
      {dialog?.kind === "password" && <PasswordPrompt connId={dialog.connId} error={dialog.error} />}
      {dialog?.kind === "settings" && <SettingsDialog section={dialog.section} />}
      {dialog?.kind === "palette" && <CommandPalette mode={dialog.mode} />}
      {dialog?.kind === "confirm" && <ConfirmDialog {...dialog} />}
      {dialog?.kind === "risky" && <RiskyDialog {...dialog} />}
      {dialog?.kind === "export" && <ExportDialog target={dialog.target} />}
      {dialog?.kind === "review" && <ReviewDialog {...dialog} />}
      {dialog?.kind === "update" && <UpdateDialog />}
      <Toasts />
    </div>
    </ErrorBoundary>
  );
}

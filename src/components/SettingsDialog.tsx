import { Check, Copy, Database, ExternalLink, Heart, Info, Keyboard, Palette, SquareTerminal, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import logo from "../assets/logo.png";
import { ABOUT } from "../lib/about";
import { checkForUpdate, useUpdates } from "../lib/updates";
import { api, toAppError } from "../lib/api";
import { MONO_FONTS, UI_FONTS, fontStack } from "../lib/fonts";
import { MOD, useApp, type SettingsTab } from "../lib/store";
import { BUILT_IN_THEMES, SYSTEM_THEME_ID, parseTheme, resolveTheme, themeToJson, type Theme } from "../lib/themes";
import { Kbd, Modal, copyText } from "./ui";

const SHORTCUTS: [string, string][] = [
  [`${MOD} Shift P`, "Command palette"],
  [`${MOD} P`, "Go to table"],
  [`${MOD} T`, "New query tab"],
  [`${MOD} W`, "Close tab"],
  [`Ctrl Tab`, "Next tab (Shift: previous)"],
  [`${MOD} 1…9`, "Go to tab"],
  [`${MOD} Enter`, "Run statement / selection"],
  [`${MOD} Shift Enter`, "Run everything"],
  [`${MOD} R`, "Refresh table"],
  [`${MOD} F`, "Filter table rows"],
  [`[  ]`, "Previous / next page"],
  [`${MOD} B`, "Toggle sidebar"],
  [`${MOD} Shift E`, "Focus sidebar"],
  [`${MOD} E`, "Focus editor / grid"],
  [`${MOD} Shift H`, "Query history"],
  [`${MOD} ,`, "Settings"],
];

/** A font name with suggestions, applied as you type, and a preview in that font. */
function FontField({
  label,
  value,
  options,
  fallback,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  fallback: "--ui-default" | "--mono-default";
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const list = `fonts-${fallback}`;
  return (
    <div className="font-field">
      <label className="field inline">
        <span>{label}</span>
        <span className="font-input">
          <input value={value} list={list} placeholder={placeholder} spellCheck={false} aria-label={`${label} font`} onChange={(e) => onChange(e.target.value)} />
          {value && (
            <button type="button" className="btn ghost small" onClick={() => onChange("")}>
              Default
            </button>
          )}
        </span>
        <datalist id={list}>
          {options.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <div className="font-preview" style={{ fontFamily: fontStack(value, fallback) }}>
        select user_id, created_at from login_audit — 0O 1lI {"{}"} =&gt; _
      </div>
    </div>
  );
}

/** Typed freely; clamped and saved on blur or Enter (clamping per keystroke blocks typing "14"). */
function NumberField({ value, min, max, step, onCommit }: { value: number; min: number; max: number; step?: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parse = (d: string) => {
    const n = Number(d);
    return Number.isFinite(n) && d.trim() !== "" ? Math.max(min, Math.min(max, Math.round(n))) : value;
  };
  const commit = () => {
    const v = parse(draft);
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  // closing the dialog (Escape, backdrop) still keeps what was typed
  const latest = useRef({ draft, value, onCommit, parse });
  latest.current = { draft, value, onCommit, parse };
  useEffect(
    () => () => {
      const { draft, value, onCommit, parse } = latest.current;
      const v = parse(draft);
      if (v !== value) onCommit(v);
    },
    [],
  );
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function ThemeCard({ theme, selected, onPick, onDelete }: { theme: Theme; selected: boolean; onPick: () => void; onDelete?: () => void }) {
  const c = theme.colors;
  return (
    <div className={`theme-card ${selected ? "selected" : ""}`}>
      <button type="button" className="theme-pick" onClick={onPick} aria-pressed={selected}>
        <span className="theme-preview" style={{ background: c.bg, borderColor: c.border }}>
          <span className="tp-side" style={{ background: c.panel }} />
          <span className="tp-main" style={{ background: c.surface }}>
            <span style={{ color: c.synKeyword }}>select</span> <span style={{ color: c.fg }}>name</span>{" "}
            <span style={{ color: c.synKeyword }}>from</span> <span style={{ color: c.synString }}>'otters'</span>
            <span className="tp-bar" style={{ background: c.accent }} />
          </span>
        </span>
        <span className="theme-name">
          {selected && <Check size={12} />} {theme.name}
        </span>
      </button>
      {onDelete && (
        <button type="button" className="icon-btn tiny theme-delete" aria-label={`Delete ${theme.name}`} onClick={onDelete}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/** A link that opens in the browser, not inside the app. */
function ExtLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a
      href={url}
      className="ext-link"
      onClick={(e) => {
        e.preventDefault();
        void api.openUrl(url).catch((err) => useApp.getState().toast(toAppError(err).message, "error"));
      }}
    >
      {children} <ExternalLink size={11} />
    </a>
  );
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "editor", label: "Editor", icon: <SquareTerminal size={15} /> },
  { id: "data", label: "Data", icon: <Database size={15} /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={15} /> },
  { id: "about", label: "About", icon: <Info size={15} /> },
];

/** Check for updates, and what came of it. */
function UpdateCheck() {
  const state = useUpdates((s) => s.state);
  const { setDialog } = useApp.getState();
  return (
    <div className="about-update">
      {state.status === "available" || state.status === "downloading" || state.status === "installing" ? (
        <button type="button" className="btn primary small" onClick={() => setDialog({ kind: "update" })}>
          Update to {state.version}
        </button>
      ) : (
        <button type="button" className="btn small" disabled={state.status === "checking"} onClick={() => void checkForUpdate()}>
          {state.status === "checking" ? "Checking…" : "Check for updates"}
        </button>
      )}
      {state.status === "none" && <span className="muted small">You have the latest version.</span>}
      {state.status === "error" && <span className="danger-text small">{state.message}</span>}
    </div>
  );
}

/** One setting: what it is on the left, its control on the right. */
function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function SettingsDialog({ section }: { section?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(section ?? "appearance");
  useEffect(() => {
    if (section) setTab(section);
  }, [section]);
  const settings = useApp((s) => s.settings);
  const { setSettings, setDialog, toast } = useApp.getState();
  const file = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const current = resolveTheme(settings.themeId, settings.customThemes, prefersDark);

  const importTheme = async (f: File) => {
    try {
      const t = parseTheme(await f.text());
      setSettings({ customThemes: [...settings.customThemes.filter((x) => x.id !== t.id), t], themeId: t.id });
      setImportError(null);
      toast(`Theme "${t.name}" added`);
    } catch (e) {
      setImportError(`${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <Modal title="Settings" onClose={() => setDialog(null)} width={820} className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="Settings" aria-orientation="vertical">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane" role="tabpanel">
          {tab === "appearance" && (
            <>
              <h3>Theme</h3>
              <div className="theme-grid">
                <button
                  type="button"
                  className={`theme-card system ${settings.themeId === SYSTEM_THEME_ID ? "selected" : ""}`}
                  onClick={() => setSettings({ themeId: SYSTEM_THEME_ID })}
                  aria-pressed={settings.themeId === SYSTEM_THEME_ID}
                >
                  <span className="theme-preview split">
                    <span style={{ background: BUILT_IN_THEMES[0].colors.surface }} />
                    <span style={{ background: BUILT_IN_THEMES[1].colors.surface }} />
                  </span>
                  <span className="theme-name">
                    {settings.themeId === SYSTEM_THEME_ID && <Check size={12} />} System
                  </span>
                </button>
                {[...BUILT_IN_THEMES, ...settings.customThemes].map((t) => (
                  <ThemeCard
                    key={t.id}
                    theme={t}
                    selected={settings.themeId === t.id}
                    onPick={() => setSettings({ themeId: t.id })}
                    onDelete={
                      t.custom
                        ? () =>
                            setSettings({
                              customThemes: settings.customThemes.filter((x) => x.id !== t.id),
                              themeId: settings.themeId === t.id ? SYSTEM_THEME_ID : settings.themeId,
                            })
                        : undefined
                    }
                  />
                ))}
              </div>
              <div className="row-actions">
                <button type="button" className="btn small" onClick={() => file.current?.click()}>
                  <Upload size={13} /> Import theme (.json)
                </button>
                <button type="button" className="btn ghost small" onClick={() => copyText(themeToJson(current), "Theme JSON copied: edit it, save as .json, import")}>
                  <Copy size={13} /> Copy "{current.name}" as JSON
                </button>
                <input
                  ref={file}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importTheme(f);
                    e.target.value = "";
                  }}
                />
              </div>
              {importError && <div className="test-result bad">{importError}</div>}
              <p className="muted small">
                A theme file is <code>{"{ \"name\", \"appearance\": \"dark\" | \"light\", \"colors\": { … } }"}</code>. Colors you leave out
                come from Otter Light or Dark.
              </p>

              <h3>Fonts</h3>
              <FontField
                label="Interface"
                value={settings.uiFont}
                options={UI_FONTS}
                fallback="--ui-default"
                placeholder="Default (system font)"
                onChange={(uiFont) => setSettings({ uiFont })}
              />
              <FontField
                label="Editor and grid"
                value={settings.monoFont}
                options={MONO_FONTS}
                fallback="--mono-default"
                placeholder="Default (JetBrains Mono, Fira Code…)"
                onChange={(monoFont) => setSettings({ monoFont })}
              />
              <Row title="Editor and grid size" desc="Text size in the SQL editor and result grids.">
                <NumberField value={settings.fontSize} min={10} max={22} onCommit={(fontSize) => setSettings({ fontSize })} />
              </Row>
              <p className="muted small">Type the name of any font installed on your computer. One that isn't installed falls back to the default.</p>
            </>
          )}

          {tab === "editor" && (
            <>
              <h3>Editor</h3>
              <Row title="Vim mode" desc="Vim keys in the SQL editor, plus h j k l, gg, G and y in grids and the sidebar.">
                <input type="checkbox" className="switch" checked={settings.vim} aria-label="Vim mode" onChange={(e) => setSettings({ vim: e.target.checked })} />
              </Row>
            </>
          )}

          {tab === "data" && (
            <>
              <h3>Data</h3>
              <Row title="Max rows per query result" desc="Rows kept from a query; the rest aren't fetched. Exports always get every row.">
                <NumberField value={settings.maxRows} min={100} max={1_000_000} step={1000} onCommit={(maxRows) => setSettings({ maxRows })} />
              </Row>
              <Row title="Rows per table page" desc="How many rows a table tab loads at a time.">
                <select value={settings.pageSize} onChange={(e) => setSettings({ pageSize: Number(e.target.value) })} aria-label="Rows per table page">
                  {[50, 100, 200, 500, 1000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}

          {tab === "shortcuts" && (
            <>
              <h3>Keyboard shortcuts</h3>
              <div className="shortcuts">
                {SHORTCUTS.map(([k, v]) => (
                  <div key={k} className="shortcut">
                    <span>{v}</span>
                    <span>
                      {k.split(" ").map((p, i) => (
                        <Kbd key={i}>{p}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "about" && (
            <div className="about">
              <img src={logo} alt="" className="about-logo" width={64} height={64} />
              <h2 className="about-name">DbOtter</h2>
              <div className="muted">Version {ABOUT.version}</div>
              <UpdateCheck />
              <p className="about-tagline">A fast, keyboard-first client for PostgreSQL, MySQL / MariaDB and SQLite.</p>
              <dl className="about-list">
                <dt>Made by</dt>
                <dd>{ABOUT.author}</dd>
                <dt>X (Twitter)</dt>
                <dd>
                  <ExtLink url={ABOUT.x.url}>@{ABOUT.x.handle}</ExtLink>
                </dd>
                <dt>Source</dt>
                <dd>
                  <ExtLink url={ABOUT.repo.url}>{ABOUT.repo.name}</ExtLink>
                </dd>
              </dl>
              <p className="about-made-with">
                Made with <Heart size={12} className="heart" fill="currentColor" /> by {ABOUT.author}
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

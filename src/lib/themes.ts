/**
 * Themes are sets of CSS variables on :root. The editor and grid read the same
 * variables, so one theme colors the whole app.
 */

export const THEME_KEYS = [
  "bg", // window background, tab bar
  "panel", // sidebar, toolbars
  "surface", // editor, grid
  "elevated", // dialogs, menus, palette
  "border",
  "fg",
  "muted",
  "subtle",
  "accent",
  "accentFg", // text on accent
  "selection",
  "hover",
  "rowAlt", // zebra stripe
  "danger",
  "warning",
  "success",
  "null", // NULL cells
  "synKeyword",
  "synString",
  "synNumber",
  "synComment",
  "synFunction",
  "synOperator",
  "synType",
] as const;

export type ThemeKey = (typeof THEME_KEYS)[number];
export type ThemeColors = Record<ThemeKey, string>;

export interface Theme {
  id: string;
  name: string;
  appearance: "light" | "dark";
  colors: ThemeColors;
  custom?: boolean;
}

const otterLight: ThemeColors = {
  bg: "#f4f4f5",
  panel: "#fafafa",
  surface: "#ffffff",
  elevated: "#ffffff",
  border: "#e4e4e7",
  fg: "#18181b",
  muted: "#52525b",
  subtle: "#a1a1aa",
  accent: "#0d9488",
  accentFg: "#ffffff",
  selection: "#ccfbf1",
  hover: "#f4f4f5",
  rowAlt: "#fafafa",
  danger: "#dc2626",
  warning: "#b45309",
  success: "#15803d",
  null: "#a1a1aa",
  synKeyword: "#7c3aed",
  synString: "#15803d",
  synNumber: "#c2410c",
  synComment: "#a1a1aa",
  synFunction: "#0369a1",
  synOperator: "#52525b",
  synType: "#b45309",
};

const otterDark: ThemeColors = {
  bg: "#111113",
  panel: "#161618",
  surface: "#1b1b1e",
  elevated: "#232327",
  border: "#2c2c31",
  fg: "#e4e4e7",
  muted: "#a1a1aa",
  subtle: "#6b6b74",
  accent: "#2dd4bf",
  accentFg: "#042f2e",
  selection: "#134e4a",
  hover: "#26262b",
  rowAlt: "#1e1e22",
  danger: "#f87171",
  warning: "#fbbf24",
  success: "#4ade80",
  null: "#6b6b74",
  synKeyword: "#c4b5fd",
  synString: "#86efac",
  synNumber: "#fdba74",
  synComment: "#6b6b74",
  synFunction: "#7dd3fc",
  synOperator: "#a1a1aa",
  synType: "#fcd34d",
};

export const BUILT_IN_THEMES: Theme[] = [
  { id: "otter-light", name: "Otter Light", appearance: "light", colors: otterLight },
  { id: "otter-dark", name: "Otter Dark", appearance: "dark", colors: otterDark },
  {
    id: "one-dark",
    name: "One Dark",
    appearance: "dark",
    colors: {
      bg: "#21252b",
      panel: "#21252b",
      surface: "#282c34",
      elevated: "#2c313a",
      border: "#3a3f4b",
      fg: "#abb2bf",
      muted: "#9da5b4",
      subtle: "#636d83",
      accent: "#61afef",
      accentFg: "#1b1f27",
      selection: "#3e4451",
      hover: "#2c313a",
      rowAlt: "#2b2f37",
      danger: "#e06c75",
      warning: "#e5c07b",
      success: "#98c379",
      null: "#636d83",
      synKeyword: "#c678dd",
      synString: "#98c379",
      synNumber: "#d19a66",
      synComment: "#5c6370",
      synFunction: "#61afef",
      synOperator: "#56b6c2",
      synType: "#e5c07b",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    appearance: "dark",
    colors: {
      bg: "#1d2021",
      panel: "#1d2021",
      surface: "#282828",
      elevated: "#32302f",
      border: "#3c3836",
      fg: "#ebdbb2",
      muted: "#d5c4a1",
      subtle: "#928374",
      accent: "#fabd2f",
      accentFg: "#282828",
      selection: "#504945",
      hover: "#32302f",
      rowAlt: "#2c2b2a",
      danger: "#fb4934",
      warning: "#fe8019",
      success: "#b8bb26",
      null: "#928374",
      synKeyword: "#fb4934",
      synString: "#b8bb26",
      synNumber: "#d3869b",
      synComment: "#928374",
      synFunction: "#8ec07c",
      synOperator: "#fe8019",
      synType: "#fabd2f",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      bg: "#11111b",
      panel: "#181825",
      surface: "#1e1e2e",
      elevated: "#313244",
      border: "#313244",
      fg: "#cdd6f4",
      muted: "#bac2de",
      subtle: "#7f849c",
      accent: "#cba6f7",
      accentFg: "#1e1e2e",
      selection: "#45475a",
      hover: "#313244",
      rowAlt: "#232334",
      danger: "#f38ba8",
      warning: "#fab387",
      success: "#a6e3a1",
      null: "#7f849c",
      synKeyword: "#cba6f7",
      synString: "#a6e3a1",
      synNumber: "#fab387",
      synComment: "#7f849c",
      synFunction: "#89b4fa",
      synOperator: "#89dceb",
      synType: "#f9e2af",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    appearance: "light",
    colors: {
      bg: "#dce0e8",
      panel: "#e6e9ef",
      surface: "#eff1f5",
      elevated: "#eff1f5",
      border: "#ccd0da",
      fg: "#4c4f69",
      muted: "#5c5f77",
      subtle: "#8c8fa1",
      accent: "#8839ef",
      accentFg: "#eff1f5",
      selection: "#ccd0da",
      hover: "#e6e9ef",
      rowAlt: "#e9ebf1",
      danger: "#d20f39",
      // darker than stock Latte so text stays readable on its pale background
      warning: "#a35c00",
      success: "#2b7a1e",
      null: "#7c7f93",
      synKeyword: "#8839ef",
      synString: "#2b7a1e",
      synNumber: "#c74a00",
      synComment: "#8c8fa1",
      synFunction: "#1e66f5",
      synOperator: "#0270a0",
      synType: "#a35c00",
    },
  },
  {
    id: "nord",
    name: "Nord",
    appearance: "dark",
    colors: {
      bg: "#272c36",
      panel: "#2b303b",
      surface: "#2e3440",
      elevated: "#3b4252",
      border: "#3b4252",
      fg: "#d8dee9",
      muted: "#c0c8d6",
      subtle: "#7b88a1",
      accent: "#88c0d0",
      accentFg: "#2e3440",
      selection: "#434c5e",
      hover: "#3b4252",
      rowAlt: "#323845",
      danger: "#bf616a",
      warning: "#ebcb8b",
      success: "#a3be8c",
      null: "#7b88a1",
      synKeyword: "#81a1c1",
      synString: "#a3be8c",
      synNumber: "#b48ead",
      synComment: "#616e88",
      synFunction: "#88c0d0",
      synOperator: "#81a1c1",
      synType: "#8fbcbb",
    },
  },
];

/** "system" follows the OS light/dark setting with the two Otter themes. */
export const SYSTEM_THEME_ID = "system";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const camelToKebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export function resolveTheme(id: string, custom: Theme[], prefersDark: boolean): Theme {
  if (id === SYSTEM_THEME_ID) return BUILT_IN_THEMES[prefersDark ? 1 : 0];
  return [...BUILT_IN_THEMES, ...custom].find((t) => t.id === id) ?? BUILT_IN_THEMES[prefersDark ? 1 : 0];
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const k of THEME_KEYS) root.style.setProperty(`--${camelToKebab(k)}`, theme.colors[k]);
  root.dataset.appearance = theme.appearance;
  root.style.colorScheme = theme.appearance;
}

/**
 * Validates a user theme file. Missing colors fall back to Otter Light / Dark (by
 * `appearance`), so a theme can override just a few keys.
 */
export function parseTheme(json: string): Theme {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Not valid JSON");
  }
  const t = raw as { name?: unknown; appearance?: unknown; colors?: unknown };
  if (!t || typeof t !== "object") throw new Error("Expected a JSON object");
  if (typeof t.name !== "string" || !t.name.trim()) throw new Error('Missing "name"');
  if (t.appearance !== "light" && t.appearance !== "dark") throw new Error('"appearance" must be "light" or "dark"');
  if (!t.colors || typeof t.colors !== "object") throw new Error('Missing "colors" object');
  const colors = { ...(t.appearance === "dark" ? otterDark : otterLight) };
  for (const [k, v] of Object.entries(t.colors as Record<string, unknown>)) {
    if (!(THEME_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown color "${k}"`);
    if (typeof v !== "string" || !HEX.test(v)) throw new Error(`"${k}" must be a hex color like #1e1e2e`);
    colors[k as ThemeKey] = v;
  }
  const slug = t.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { id: `custom-${slug}`, name: t.name.trim(), appearance: t.appearance, colors, custom: true };
}

/** The JSON a user can save, edit and import. */
export function themeToJson(theme: Theme) {
  return JSON.stringify({ name: `${theme.name} (custom)`, appearance: theme.appearance, colors: theme.colors }, null, 2);
}

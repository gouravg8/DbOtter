/** Fonts chosen in Settings: put in front of the default stacks, so a font that isn't
 * installed falls back to them. */

/** Suggestions only: any installed font can be typed. */
export const UI_FONTS = ["Inter", "Ubuntu", "Noto Sans", "Cantarell", "Roboto", "Open Sans", "Fira Sans", "Segoe UI", "SF Pro Text", "Helvetica Neue", "Arial"];
export const MONO_FONTS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "Hack",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Noto Sans Mono",
  "IBM Plex Mono",
  "Iosevka",
  "SF Mono",
  "Menlo",
  "Consolas",
];

/** `My "Font"` -> `"My Font", var(--ui-default)`; empty: just the default. */
export function fontStack(name: string, fallbackVar: "--ui-default" | "--mono-default") {
  const clean = name.replace(/["\\;{}]/g, "").trim();
  return clean ? `"${clean}", var(${fallbackVar})` : `var(${fallbackVar})`;
}

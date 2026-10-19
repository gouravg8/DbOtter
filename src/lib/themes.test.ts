import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT_IN_THEMES, THEME_KEYS, parseTheme, resolveTheme, themeToJson } from "./themes.ts";

test("built-in themes define every color", () => {
  for (const t of BUILT_IN_THEMES) for (const k of THEME_KEYS) assert.match(t.colors[k], /^#[0-9a-f]{6}$/i, `${t.id}.${k}`);
});

test("custom theme: partial colors fall back to the base", () => {
  const t = parseTheme(JSON.stringify({ name: "Ocean", appearance: "dark", colors: { accent: "#00aaff" } }));
  assert.equal(t.id, "custom-ocean");
  assert.equal(t.colors.accent, "#00aaff");
  assert.equal(t.colors.bg, BUILT_IN_THEMES[1].colors.bg);
  assert.equal(t.custom, true);
});

test("custom theme: invalid input is explained", () => {
  assert.throws(() => parseTheme("{"), /valid JSON/);
  assert.throws(() => parseTheme(JSON.stringify({ appearance: "dark", colors: {} })), /name/);
  assert.throws(() => parseTheme(JSON.stringify({ name: "x", appearance: "dim", colors: {} })), /appearance/);
  assert.throws(() => parseTheme(JSON.stringify({ name: "x", appearance: "dark", colors: { bogus: "#fff" } })), /Unknown color "bogus"/);
  assert.throws(() => parseTheme(JSON.stringify({ name: "x", appearance: "dark", colors: { bg: "red" } })), /hex/);
});

test("exported JSON imports back", () => {
  const t = parseTheme(themeToJson(BUILT_IN_THEMES[3]));
  assert.deepEqual(t.colors, BUILT_IN_THEMES[3].colors);
});

test("system theme follows the OS", () => {
  assert.equal(resolveTheme("system", [], true).id, "otter-dark");
  assert.equal(resolveTheme("system", [], false).id, "otter-light");
  assert.equal(resolveTheme("missing", [], false).id, "otter-light");
});

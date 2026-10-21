import assert from "node:assert/strict";
import { test } from "node:test";
import { fontStack } from "./fonts.ts";

test("a chosen font goes in front of the default stack", () => {
  assert.equal(fontStack("Fira Code", "--mono-default"), '"Fira Code", var(--mono-default)');
  assert.equal(fontStack("  ", "--ui-default"), "var(--ui-default)");
  // can't break out of the CSS value
  assert.equal(fontStack('Evil"; color: red; {', "--ui-default"), '"Evil color: red", var(--ui-default)');
});

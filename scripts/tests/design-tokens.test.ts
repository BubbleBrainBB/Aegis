import assert from "node:assert/strict";
import { preferToken, readBoardTokens, tokenReference } from "../../src/shared/design-tokens";

const html = `<html><head><style>
/* Quiet product UI */
:root { --bg: #eff1f4; --accent: #4f5bd5; --space-2: 8px; }
.card { --local: red; color: var(--accent); }
html, body { --text: #2f3244 }
</style><style>:root{--accent:#5a66e0}</style></head><body></body></html>`;
assert.deepEqual(readBoardTokens(html), [
  { name: "--bg", value: "#eff1f4" },
  { name: "--accent", value: "#5a66e0" },
  { name: "--space-2", value: "8px" },
  { name: "--text", value: "#2f3244" },
]);
assert.deepEqual(readBoardTokens("<main>No styles</main>"), []);
assert.equal(tokenReference("var(--accent)"), "--accent");
assert.equal(tokenReference(" var( --accent , #000 ) "), "--accent");
assert.equal(tokenReference("--accent"), "--accent");
assert.equal(tokenReference("#4f5bd5"), undefined);
const tokens = readBoardTokens(html);
const sameHex = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
assert.equal(preferToken("#2F3244", tokens, sameHex), "var(--text)", "a token's exact value becomes a reference");
assert.equal(preferToken("--bg", tokens, sameHex), "var(--bg)", "a named token");
assert.equal(preferToken("--missing", tokens, sameHex), "--missing", "an unknown name is left as typed");
assert.equal(preferToken("#123456", tokens, sameHex), "#123456", "other values stay literal");
console.log("design-tokens: root tokens, references and preferring tokens passed");

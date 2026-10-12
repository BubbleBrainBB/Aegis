import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInlineCss, inlineCssText, formatInlineCss } from "./design-css";
import { replaceDesignLayerStyle } from "../../../shared/design-layers";

test("parses strings/functions/comments without splitting quoted semicolons", () => {
  const css = 'content: "a;b:c"; background: url("data:image/png;base64,a"); /* note */ --MyColor: var(--brand, red); color: blue !important;';
  const result = parseInlineCss(css);
  assert.equal(result.length, 4);
  assert.deepEqual(result[0], { property: "content", value: '"a;b:c"', important: false });
  assert.equal(result[2].property, "--MyColor");
  assert.equal(result[3].important, true);
  assert.deepEqual(parseInlineCss(inlineCssText(result)), result);
});
test("invalid rule syntax and unfinished CSS are refused, empty source removes overrides", () => {
  for (const css of ['.x {color:red}', '@import "x";', 'color red', 'color:', 'font-family: "x', 'color: var(--x', 'color: red /*', 'color: red)']) assert.throws(() => parseInlineCss(css));
  assert.deepEqual(parseInlineCss(" \n /* empty */ "), []);
  assert.equal(formatInlineCss('color: red; padding: 4px'), 'color: red;\npadding: 4px;');
});
test("inline replacement leaves authored stylesheet intact and does not promote it to inline", () => {
  const html = '<html><head><style>.title{font-size:24px;color:red}</style></head><body><h1 class="title" data-aegis-node-id="n" style="color: blue">Hi</h1></body></html>';
  const result = replaceDesignLayerStyle(html, 'n', inlineCssText(parseInlineCss('color: green;')));
  assert.match(result, /<style>\.title\{font-size:24px;color:red\}<\/style>/);
  assert.match(result, /style="color: green;"/);
  assert.equal(/style="[^"]*font-size/.test(result), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeDesignHtml } from "../../../electron/design/html";
import { findDesignLayer, readDesignLayers } from "../../../shared/design-layers";
import { applyDesignTweaks, readDesignTweaks } from "./design-tweaks";

const controls = [
  { name: "Color", editor: "color", target: { kind: "style", nodeId: "title", property: "color" } },
  { name: "Title", editor: "text", target: { kind: "text", nodeId: "title" } },
  { name: "Gap", editor: "range", min: 0, max: 64, unit: "px", target: { kind: "style", nodeId: "row", property: "gap" } },
  { name: "Visible", editor: "boolean", target: { kind: "style", nodeId: "title", property: "display", on: "block", off: "none" } },
  { name: "Alignment", editor: "enum", options: ["left", "center", "right"], target: { kind: "style", nodeId: "title", property: "text-align" } },
];
const board = (spec = controls) => `<html><head><style>h1{color:red}</style></head><body data-aegis-tweaks='${JSON.stringify({ version: 1, controls: spec })}'><div data-aegis-node-id="row" style="gap: 8px"><h1 data-aegis-node-id="title" style="color: #112233; display: block">Hello</h1></div></body></html>`;

test("explicit controls survive sanitizer; executable scripts do not", () => {
  const html = sanitizeDesignHtml(board() + '<script>throw "never"</script>');
  assert.equal(html.includes('<script>'), false);
  const source = readDesignTweaks(html);
  assert.equal(source.status, "ready");
  assert.equal(source.controls.length, 5);
  assert.equal(source.controls[0].value, "#112233");
  assert.equal(source.controls[2].value, 8);
  assert.equal(source.controls[3].value, true);
});
test("tweaks change only declared targets, retaining stylesheet and unrelated inline values", () => {
  const html = applyDesignTweaks(board(), { Color: "#abcdef", Gap: 20, Title: '<b>& safe', Visible: false });
  const title = findDesignLayer(readDesignLayers(html), "title")!;
  assert.equal(title.text, '<b>& safe');
  assert.match(title.styles.cssText, /color: #abcdef !important/);
  assert.match(title.styles.cssText, /display: none !important/);
  assert.match(findDesignLayer(readDesignLayers(html), "row")!.styles.cssText, /gap: 20px !important/);
  assert.match(html, /<style>h1\{color:red\}<\/style>/);
  assert.equal(readDesignTweaks(sanitizeDesignHtml(html)).controls[2].value, 20);
});
test("invalid choices, injection, new targets and out-of-range values do not write", () => {
  for (const values of [{ Gap: 100 }, { Gap: Number.NaN }, { Visible: "false" }, { Alignment: "justify" }, { unknown: "x" }, { Color: "red; position:fixed" }, { Color: "url(https://example.test)" }])
    assert.throws(() => applyDesignTweaks(board(), values as never));
  assert.throws(() => applyDesignTweaks(board(), { Color: "nonsense" }, () => false), /Invalid color/);
  assert.equal(readDesignTweaks(board([{ ...controls[0], target: { kind: "style", nodeId: "title", property: "behavior" } }])).status, "invalid");
});
test("locked ancestors and nonleaf text refuse edits", () => {
  const locked = board().replace('data-aegis-node-id="row"', 'data-aegis-node-id="row" data-aegis-locked="true"');
  assert.throws(() => applyDesignTweaks(locked, { Color: "blue" }), /Unlock/);
  const nonleaf = board().replace('>Hello</h1>', '><span>Nested</span></h1>');
  assert.throws(() => applyDesignTweaks(nonleaf, { Title: "no" }), /child layers/);
});
test("absent metadata never invents controls; unsupported versions and duplicate names fail", () => {
  assert.equal(readDesignTweaks('<body><p style="color:red">Hi</p></body>').status, "absent");
  assert.equal(readDesignTweaks(board().replace('"version":1', '"version":2')).status, "invalid");
  assert.equal(readDesignTweaks(board([controls[0], controls[0]])).status, "invalid");
});
test("Claude runtime props do not become nonfunctional Aegis controls", () => {
  const html = `<x-dc><h1>{{Title}}</h1></x-dc><script type="text/dc" data-dc-script data-props='{ "Title": {"editor":"text","default":"Hello"}}'>class Component {}</script>`;
  assert.equal(readDesignTweaks(html).status, "absent");
  assert.equal(readDesignTweaks(sanitizeDesignHtml(html)).status, "absent");
});

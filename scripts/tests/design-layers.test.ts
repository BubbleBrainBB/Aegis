import assert from "node:assert/strict";
import {
  normalizeDesignLayers,
  readDesignLayers,
  editDesignLayer,
  replaceDesignLayerStyle,
  moveDesignLayer,
  insertDesignLayer,
  inferAutoLayout,
  setAutoLayout,
  wrapInAutoLayout,
  readLayerHtml,
  replaceLayerHtml,
  type DesignLayer,
} from "../../src/shared/design-layers";
import { sanitizeDesignHtml } from "../../src/electron/design/html";
const flat = (nodes: DesignLayer[]): DesignLayer[] =>
  nodes.flatMap((n) => [n, ...flat(n.children)]);
const source =
  '<style>p{color:red}</style><main><h1 data-aegis-node-id="hero">Hello</h1><section><p data-aegis-node-id="hero">World</p><p>Last</p></section></main>';
let html = sanitizeDesignHtml(source);
let layers = flat(readDesignLayers(html));
assert.equal(layers.length, 5);
assert.equal(
  new Set(layers.map((n) => n.id)).size,
  5,
  "duplicate IDs get repaired",
);
assert.equal(normalizeDesignLayers(html), html, "normalization is idempotent");
const [group, title, section, paragraph, last] = layers;
html = editDesignLayer(html, paragraph.id, {
  type: "text",
  value: "<b>Literal text & symbols</b>",
});
assert(html.includes("&lt;b&gt;Literal text &amp; symbols&lt;/b&gt;"));
assert.deepEqual(
  flat(readDesignLayers(html)).map((n) => n.id),
  layers.map((n) => n.id),
  "content changes preserve identity",
);
assert.throws(
  () =>
    editDesignLayer(html, group.id, {
      type: "text",
      value: "destroy children",
    }),
  /group/,
);
html = editDesignLayer(html, paragraph.id, {
  type: "name",
  value: "Annotation",
});
html = editDesignLayer(html, paragraph.id, { type: "hidden", value: true });
html = replaceDesignLayerStyle(
  html,
  paragraph.id,
  "color: blue !important; width: 140px",
);
html = sanitizeDesignHtml(html);
assert.equal(
  flat(readDesignLayers(html)).find((n) => n.id === paragraph.id)?.name,
  "Annotation",
);
assert(flat(readDesignLayers(html)).find((n) => n.id === paragraph.id)?.hidden);
html = editDesignLayer(html, section.id, { type: "locked", value: true });
assert.throws(
  () => editDesignLayer(html, paragraph.id, { type: "remove" }),
  /Unlock/,
);
assert.throws(
  () => replaceDesignLayerStyle(html, paragraph.id, "color:green"),
  /Unlock/,
);
assert.throws(
  () => editDesignLayer(html, paragraph.id, { type: "locked", value: false }),
  /Unlock/,
);
html = editDesignLayer(html, section.id, { type: "locked", value: false });
html = editDesignLayer(html, section.id, { type: "duplicate" });
layers = flat(readDesignLayers(html));
assert.equal(layers.length, 8, "duplicates an entire subtree");
assert.equal(
  new Set(layers.map((n) => n.id)).size,
  8,
  "duplicates receive distinct IDs",
);
assert.equal(
  layers.find((n) => n.id === title.id)?.text,
  "Hello",
  "unrelated siblings preserved",
);
html = editDesignLayer(html, last.id, { type: "up" });
assert.equal(
  flat(readDesignLayers(html)).find((n) => n.id === section.id)?.children[0].id,
  last.id,
);
html = editDesignLayer(html, paragraph.id, { type: "remove" });
assert(!flat(readDesignLayers(html)).some((n) => n.id === paragraph.id));
assert.throws(
  () => editDesignLayer(html, "stale-id", { type: "text", value: "x" }),
  /no longer exists/,
);
{
  const row = '<div data-aegis-node-id="row" style="display:flex"><a data-aegis-node-id="a">A</a> <a data-aegis-node-id="b">B</a> <a data-aegis-node-id="c">C</a></div><div data-aegis-node-id="other"><i data-aegis-node-id="i">I</i></div>';
  const order = (h: string, id: string) =>
    flat(readDesignLayers(h)).find((n) => n.id === id)!.children.map((n) => n.id);
  let moved = moveDesignLayer(row, "c", "row", 0);
  assert.deepEqual(order(moved, "row"), ["c", "a", "b"], "drag to the front");
  moved = moveDesignLayer(row, "a", "row", 2);
  assert.deepEqual(order(moved, "row"), ["b", "c", "a"], "drag to the end");
  moved = moveDesignLayer(row, "b", "other", 1);
  assert.deepEqual(order(moved, "row"), ["a", "c"]);
  assert.deepEqual(order(moved, "other"), ["i", "b"], "move into another container");
  assert.throws(() => moveDesignLayer(row, "row", "row", 0), /itself/);
  const locked = row.replace('data-aegis-node-id="other"', 'data-aegis-node-id="other" data-aegis-locked="true"');
  assert.throws(() => moveDesignLayer(locked, "a", "other", 0), /Unlock/);
}
{
  // Text and Frame tools insert a new layer among the element children.
  const row = '<div data-aegis-node-id="row" style="display:flex"><a data-aegis-node-id="a">A</a> <a data-aegis-node-id="b">B</a></div><p>Loose</p>';
  const kids = (h: string, id: string) =>
    flat(readDesignLayers(h)).find((n) => n.id === id)!.children.map((n) => n.text || n.id);
  const text = insertDesignLayer(row, "row", 1, { tag: "span", text: "New\nline" });
  assert.deepEqual(kids(text.html, "row"), ["A", "New\nline", "B"], "inserted between, with a line break");
  assert(text.html.includes(`<span data-aegis-node-id="${text.nodeId}">New<br>line</span>`));
  const end = insertDesignLayer(row, "row", 99, { tag: "div", name: "Frame", style: "width: 200px" });
  const frame = flat(readDesignLayers(end.html)).find((n) => n.id === end.nodeId)!;
  assert.equal(frame.name, "Frame");
  assert.equal(kids(end.html, "row").at(-1), end.nodeId, "past the end appends");
  const body = insertDesignLayer(row, undefined, 99, { tag: "div" });
  assert.equal(readDesignLayers(body.html).at(-1)!.id, body.nodeId, "the page body without a parent");
  // Existing ids are persisted, so later layers keep theirs after an insert.
  const loose = readDesignLayers(row).find((n) => n.tag === "p")!.id;
  assert(readDesignLayers(insertDesignLayer(row, undefined, 0, { tag: "p" }).html).some((n) => n.id === loose));
  assert.throws(() => insertDesignLayer(row, "row", 0, { tag: "script" }), /cannot be inserted/);
  const locked = row.replace('data-aegis-node-id="row"', 'data-aegis-node-id="row" data-aegis-locked="true"');
  assert.throws(() => insertDesignLayer(locked, "row", 0, { tag: "p" }), /Unlock/);
  // Nesting the HTML parser would rewrite is refused rather than saved as a moved or extra layer.
  const para = '<p data-aegis-node-id="para"><a data-aegis-node-id="link" href="#x">link</a></p>';
  assert.throws(() => insertDesignLayer(para, "para", 1, { tag: "p", text: "New" }), /can't be added here/);
  assert.throws(() => insertDesignLayer(para, "para", 1, { tag: "div" }), /can't be added here/);
  const table = '<table data-aegis-node-id="t"><tbody data-aegis-node-id="tb"><tr data-aegis-node-id="tr"><td data-aegis-node-id="td">x</td></tr></tbody></table>';
  assert.throws(() => insertDesignLayer(table, "tr", 1, { tag: "p", text: "New" }), /can't be added here/);
  assert.equal(readDesignLayers(insertDesignLayer(table, "td", 1, { tag: "span", text: "ok" }).html).length, 1, "a cell takes content");
}
console.log(
  "Design layers: hierarchy, identity, text safety, properties, locks, subtree duplication, ordering, moving, inserting and removal passed",
);

// Auto layout: infer the arrangement, set it on a container, or wrap a layer in one.
{
  const r = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });
  assert.deepEqual(inferAutoLayout([r(0, 0), r(120, 4), r(240, 2)]), { direction: "row", columns: 3 });
  assert.deepEqual(inferAutoLayout([r(0, 0), r(0, 60), r(4, 120)]), { direction: "column", columns: 1 });
  assert.deepEqual(inferAutoLayout([r(0, 0), r(120, 0), r(0, 60), r(120, 60), r(240, 60)]).columns, 3);
  assert.deepEqual(inferAutoLayout([r(0, 0)]), { direction: "column", columns: 1 });

  const page =
    '<div data-aegis-node-id="box" style="padding: 8px; display: block; gap: 20px"><p data-aegis-node-id="a" style="position: absolute; left: 4px; top: 9px; color: red">A</p><p data-aegis-node-id="b">B</p></div>';
  const row = setAutoLayout(page, "box", { kind: "row" });
  assert.match(row, /data-aegis-node-id="box" style="padding: 8px; display: flex !important; flex-direction: row !important; gap: 20px"/, row);
  assert.match(row, /data-aegis-node-id="a" style="color: red"/, "children lose their inline positioning");
  const grid = setAutoLayout(row, "box", { kind: "grid", columns: 3 });
  assert.match(grid, /display: grid !important; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) !important; gap: 20px/);
  assert.doesNotMatch(grid, /flex-direction/, "switching to grid drops the flex direction");
  assert.match(setAutoLayout('<div data-aegis-node-id="x"><span>1</span></div>', "x", { kind: "column" }), /gap: 12px !important/, "12px gap by default");
  assert.throws(() => setAutoLayout('<div data-aegis-node-id="x" data-aegis-locked="true"></div>', "x", { kind: "row" }), /Unlock/);

  const wrapped = wrapInAutoLayout(
    '<main data-aegis-node-id="m"><h1 data-aegis-node-id="h" style="position: absolute; top: 10px; color: blue">Hi</h1><p data-aegis-node-id="p">P</p></main>',
    "h",
    { kind: "column" },
  );
  assert.match(wrapped.html, new RegExp(`<div data-aegis-node-id="${wrapped.nodeId}" data-aegis-layer-name="Auto layout" style="position: absolute; top: 10px; display: flex !important; flex-direction: column !important; gap: 12px !important"><h1 data-aegis-node-id="h" style="color: blue">Hi</h1></div><p`), wrapped.html);
  assert.throws(() => wrapInAutoLayout('<p data-aegis-node-id="p"><span data-aegis-node-id="s">x</span></p>', "s", { kind: "row" }), /can't be wrapped here/);
  console.log("Design layers: auto layout inference, set and wrap passed");
}

// One layer's markup: read it, replace it keeping its id, refuse what can't fit.
{
  const page = '<main data-aegis-node-id="m"><h1 data-aegis-node-id="h" style="font-size: 48px">Notes</h1><p data-aegis-node-id="p">Body</p></main>';
  assert.equal(readLayerHtml(page, "h"), '<h1 data-aegis-node-id="h" style="font-size: 48px">Notes</h1>');
  const smaller = replaceLayerHtml(page, "h", '<h1 style="font-size: 36px">Notes</h1>');
  assert.match(smaller, /<h1 style="font-size: 36px" data-aegis-node-id="h">Notes<\/h1><p data-aegis-node-id="p">/);
  const nested = replaceLayerHtml(page, "h", '<div class="hero"><h1>Notes</h1><span>New</span></div>');
  assert.match(nested, /<div class="hero" data-aegis-node-id="h"><h1 data-aegis-node-id="aegis-layer-\d+">Notes<\/h1>/, "new children get ids");
  assert.throws(() => replaceLayerHtml(page, "h", "<h1>A</h1><h2>B</h2>"), /exactly one element/);
  assert.throws(() => replaceLayerHtml(page, "h", "just text"), /exactly one element/);
  assert.throws(() => replaceLayerHtml('<p data-aegis-node-id="p"><span data-aegis-node-id="s">x</span></p>', "s", "<div>block</div>"), /can't go here/);
  assert.throws(() => readLayerHtml(page, "missing"), /no longer exists/);
  console.log("Design layers: reading and replacing one layer's markup passed");
}

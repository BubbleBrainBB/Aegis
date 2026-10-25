import assert from "node:assert/strict";
import {
  designPropsOf,
  designTextSource,
  editDesignText,
  setDesignProps,
} from "../../src/shared/design-component";
import { editDesignLayer } from "../../src/shared/design-layers";
import { sanitizeDesignHtml } from "../../src/shared/design-html";

// Text edits land where the text comes from: markup, a prop, a list item, or refused.
const board = sanitizeDesignHtml(`<!doctype html><html><head></head><body>
<h1 data-aegis-node-id="title">{{ heading }}</h1>
<p data-aegis-node-id="lede">Plain words</p>
<ul data-aegis-node-id="list"><li data-aegis-node-id="item" data-aegis-for="(plan, i) in plans">{{ plan.name }}</li></ul>
<span data-aegis-node-id="tag" data-aegis-for="t in tags">{{ t }}</span>
<b data-aegis-node-id="price">{{ price }}</b>
<em data-aegis-node-id="total">{{ count * 2 }}</em>
<i data-aegis-node-id="greeting">Hello {{ name }}</i>
<small data-aegis-node-id="state">{{ picked }}</small>
</body></html>`);
const withProps = setDesignProps(board, {
  heading: { type: "string", default: "Plans" },
  plans: { type: "list", default: [{ name: "Monthly" }, { name: "Yearly" }] },
  tags: { type: "list", default: ["new", "hot"] },
  price: { type: "number", default: 12 },
  name: { type: "string", default: "Ana" },
  $preview: { heading: "Preview plans" },
});
const text = (html: string, id: string, value: string, instance?: string) =>
  editDesignText(html, id, value, instance, (h) => editDesignLayer(h, id, { type: "text", value }));

assert.deepEqual(designTextSource(withProps, "lede"), { kind: "template" });
assert.match(text(withProps, "lede", "New words"), />New words</, "plain text edits the markup");

assert.deepEqual(designTextSource(withProps, "title"), { kind: "prop", prop: "heading", path: [] });
let next = text(withProps, "title", "Pick a plan");
assert.equal(designPropsOf(next)!.$preview!.heading, "Pick a plan", "a $preview value is what the canvas shows, so it is what changes");
assert.equal((designPropsOf(next)!.heading as { default: string }).default, "Plans");
assert.match(next, /\{\{ heading \}\}/, "the binding stays");

assert.deepEqual(designTextSource(withProps, "item", "1"), { kind: "prop", prop: "plans", path: [1, "name"] });
next = text(withProps, "item", "Annual", "1");
assert.deepEqual((designPropsOf(next)!.plans as { default: unknown }).default, [{ name: "Monthly" }, { name: "Annual" }], "a loop item edits its list entry");
next = text(withProps, "tag", "sale", "0");
assert.deepEqual((designPropsOf(next)!.tags as { default: unknown }).default, ["sale", "hot"]);
next = text(withProps, "price", "19");
assert.equal((designPropsOf(next)!.price as { default: unknown }).default, 19, "a number prop stays a number");

assert.equal(designTextSource(withProps, "item").kind, "logic", "without a rendered copy the item is unknown");
assert.throws(() => text(withProps, "total", "9"), /comes from the board's logic/);
assert.throws(() => text(withProps, "state", "x"), /comes from the board's logic/, "state is logic, not a prop");
assert.throws(() => text(withProps, "greeting", "Hi"), /mixes words and template values/);
console.log("design-component: text sources, prop and $preview edits, list items, numbers and refusals passed");

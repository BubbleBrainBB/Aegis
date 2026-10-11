import assert from "node:assert/strict";
import { diffDesignSnapshots, type DesignNodeSnapshot } from "../../src/shared/design-diff";

const node = (id: string, over: Partial<DesignNodeSnapshot> = {}): DesignNodeSnapshot => ({
  id,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  text: "",
  styles: { "font-size": "16px", color: "rgb(0, 0, 0)" },
  ...over,
});
const before = [
  node("main", { rect: { x: 0, y: 0, width: 1280, height: 600 } }),
  node("hero", { parent: "main", name: "Hero headline", rect: { x: 72, y: 226, width: 900, height: 216 }, text: "Some places", styles: { "font-size": "108px", color: "rgb(0, 0, 0)" } }),
  node("intro", { parent: "main", rect: { x: 72, y: 470, width: 600, height: 40 } }),
  node("old", { parent: "main" }),
];
const after = [
  node("main", { rect: { x: 0, y: 0, width: 1280, height: 536 } }),
  node("hero", { parent: "main", name: "Hero headline", rect: { x: 72, y: 226, width: 760, height: 152 }, text: "Some places", styles: { "font-size": "76px", color: "rgb(0, 0, 0)" } }),
  // Reflowed below the edit: moved but otherwise unchanged.
  node("intro", { parent: "main", rect: { x: 72, y: 406, width: 600, height: 40 } }),
  node("new", { parent: "main", rect: { x: 10, y: 10, width: 10, height: 10 } }),
];
const d = diffDesignSnapshots(before, after);
assert.equal(d.wholeBoard, false);
assert.deepEqual(d.changed.map((c) => c.id), ["hero"], "reflow and parent resize are not changes");
assert.deepEqual(
  d.changed[0].props.map((p) => [p.property, p.before, p.after]),
  [["font-size", "108px", "76px"], ["width", "900", "760"], ["height", "216", "152"]],
);
assert.deepEqual(d.added, ["new"]);
assert.deepEqual(d.removed, ["old"]);
assert.deepEqual(d.region, { x: 10, y: 10, width: 822, height: 368 });
const replaced = diffDesignSnapshots([node("a")], [node("b")]);
assert.equal(replaced.wholeBoard, true);
assert.equal(diffDesignSnapshots(before, before).changed.length, 0);
console.log("Design diff: property changes, reflow filtering, added/removed and fallback passed");

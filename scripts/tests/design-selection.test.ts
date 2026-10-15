import assert from "node:assert/strict";
import { sameDesignSelection, sanitizeDesignSelectionRef } from "../../src/shared/design-selection";
import { useComposerQueueStore } from "../../src/ui/store/useComposerQueueStore";

// The renderer's snapshot is validated before it is used or stored.
assert.equal(sanitizeDesignSelectionRef(null), undefined);
assert.equal(sanitizeDesignSelectionRef({ documentId: "des_1", boardIds: [] }), undefined, "no board, no selection");
assert.equal(sanitizeDesignSelectionRef({ documentId: "bad id", boardIds: ["brd_1"] }), undefined);
assert.deepEqual(
  sanitizeDesignSelectionRef({ documentId: "des_1", boardIds: ["brd_1"], nodeId: "hero", label: " Hero\n· Home ", contentRevision: 4, extra: 1 }),
  { documentId: "des_1", boardIds: ["brd_1"], nodeId: "hero", label: "Hero · Home", contentRevision: 4 },
);
assert.deepEqual(
  sanitizeDesignSelectionRef({ documentId: "des_1", boardIds: ["a", "b", "a", "<x>", 3], nodeId: "hero", contentRevision: 2 }),
  { documentId: "des_1", boardIds: ["a", "b"], label: "2 boards" },
  "several boards drop the layer and revision, and dedupe",
);
assert.equal(sanitizeDesignSelectionRef({ documentId: "des_1", boardIds: ["a"], contentRevision: -1 })?.contentRevision, undefined);

const home = { documentId: "des_1", boardIds: ["home"], label: "Home", contentRevision: 1 };
const pricing = { documentId: "des_1", boardIds: ["pricing"], label: "Pricing", contentRevision: 1 };
assert(sameDesignSelection(home, { ...home, boardIds: ["home"] }));
assert(!sameDesignSelection(home, pricing));
assert(!sameDesignSelection(home, undefined));
assert(sameDesignSelection(undefined, undefined));

// Queued messages batch into one turn only while they share a selection.
const queue = useComposerQueueStore.getState();
const item = (id: string, designSelection?: typeof home) => ({ id, displayPrompt: id, effectivePrompt: id, attachments: [], references: {}, ...(designSelection ? { designSelection } : {}) });
queue.enqueue("s", item("a", home));
queue.enqueue("s", item("b", home));
queue.enqueue("s", item("c", pricing));
queue.enqueue("s", item("d"));
queue.enqueue("s", item("e"));
const ids = () => useComposerQueueStore.getState().takeNextBatch("s").map((i) => i.id).join(",");
assert.equal(ids(), "a,b");
assert.equal(ids(), "c");
assert.equal(ids(), "d,e");
assert.equal(ids(), "");

console.log("Design selection: sanitize, compare and queue batching passed.");

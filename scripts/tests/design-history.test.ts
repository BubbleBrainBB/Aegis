import assert from "node:assert/strict";
import { summarizeOperations } from "../../src/shared/design-history";

const before = {
  title: "Fieldnotes",
  boards: [
    { id: "a", name: "Home" },
    { id: "b", name: "Journal" },
  ] as never[],
};
const s = (ops: unknown[]) => summarizeOperations(ops as never, before);
assert.equal(s([{ type: "add", name: "Mobile" }]), "Added Mobile");
assert.equal(s([{ type: "content", boardId: "a", expectedRevision: 1, html: "" }]), "Edited Home");
assert.equal(s([{ type: "placement", boardId: "b", expectedRevision: 1, x: 3 }]), "Moved Journal");
assert.equal(
  s([
    { type: "placement", boardId: "a", expectedRevision: 1, x: 3 },
    { type: "placement", boardId: "b", expectedRevision: 1, y: 3 },
  ]),
  "Moved Home, Journal",
);
assert.equal(s([{ type: "placement", boardId: "a", expectedRevision: 1, width: 390 }]), "Resized Home");
assert.equal(s([{ type: "placement", boardId: "a", expectedRevision: 1, name: "Landing" }]), "Renamed Home to Landing");
assert.equal(s([{ type: "remove", boardId: "b", expectedRevision: 1 }]), "Deleted Journal");
assert.equal(
  s([
    { type: "add", name: "One" },
    { type: "add", name: "Two" },
    { type: "add", name: "Three" },
  ]),
  "Added One · Added Two and 1 more",
);
console.log("Design history: operation summaries passed");

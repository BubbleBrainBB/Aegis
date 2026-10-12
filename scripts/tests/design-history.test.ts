import assert from "node:assert/strict";
import { groupDesignVersions, summarizeOperations } from "../../src/shared/design-history";

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

// Versions as the user thinks of them: one per request, one per stretch of hand edits, one per restore.
{
  const min = 60_000;
  const agent = { kind: "agent" as const, name: "Claude Code" };
  const me = { kind: "user" as const, name: "Me" };
  const save = (revision: number, at: number, extra: Record<string, unknown>) => ({
    revision, createdAt: at * min, author: agent, summary: `Save ${revision}`, commentId: null, boardIds: [`b${revision % 3}`], ...extra,
  });
  const history = [
    save(1, 0, { requestId: "m1", prompt: "Design an AI podcast app", summary: "Created Podcast" }),
    save(2, 1, { requestId: "m1", prompt: "Design an AI podcast app" }),
    save(3, 2, { requestId: "m1", prompt: "Design an AI podcast app" }),
    save(4, 10, { author: me, summary: "Moved Home" }),
    save(5, 11, { author: me, summary: "Edited text of h1 on Home" }),
    save(6, 30, { author: me, summary: "Resized Home" }),
    save(7, 31, { requestId: "m2", prompt: "Make the player calmer" }),
    save(8, 40, { author: me, summary: "Restored v3" }),
    save(9, 41, { requestId: "m2", prompt: "Make the player calmer" }),
  ].reverse();
  const groups = groupDesignVersions(history);
  assert.deepEqual(
    groups.map((g) => [g.kind, g.first, g.last, g.title]),
    [
      ["request", 9, 9, "Make the player calmer"],
      ["restore", 8, 8, "Restored v3"],
      ["request", 7, 7, "Make the player calmer"],
      ["edits", 6, 6, "Resized Home"],
      ["edits", 4, 5, "Edited by hand · 2 changes"],
      ["request", 1, 3, "Design an AI podcast app"],
    ],
  );
  assert.deepEqual(groups.at(-1)!.revisions.map((r) => r.revision), [3, 2, 1], "saves newest first");
  assert.deepEqual(groups.at(-1)!.boardIds.sort(), ["b0", "b1", "b2"]);
  // Older agent saves without a request still fold while they keep coming.
  const legacy = groupDesignVersions([save(3, 2, {}), save(2, 1, {}), save(1, 0, {})]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].title, "Save 3 and more");
  console.log("Design history: versions grouped by request, hand edits and restores passed");
}

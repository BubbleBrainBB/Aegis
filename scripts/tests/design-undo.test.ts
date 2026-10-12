import assert from "node:assert/strict";
import { blockedBy, DesignUndo, touchedBoards, type UndoEntry } from "../../src/ui/components/design/design-undo";
import type { DesignRevisionInfo } from "../../src/shared/design-types";

const entry: UndoEntry = { from: 3, to: 4, boardIds: [], title: false, canvas: true, summary: "Added page" };
const version = (revision: number, boardIds: string[], canvasChanged = false): DesignRevisionInfo => ({ revision, boardIds, canvasChanged, createdAt: 1, author: { kind: "agent", name: "Agent" }, summary: null, commentId: null });
assert.equal(blockedBy(entry, [version(5, ["unrelated-board"])]), false, "canvas-only undo does not overwrite a later agent HTML edit");
assert.equal(blockedBy(entry, [version(5, [], true)]), true, "a later page or annotation change must not be overwritten");
assert.equal(blockedBy(entry, [version(5, ["new-board"], true)]), true, "new page membership is a canvas conflict");
assert.equal(blockedBy(entry, [version(4, [], true)]), false, "the original write is not a later conflict");
assert.equal(blockedBy({ ...entry, boardIds: ["removed"] }, [version(5, ["removed"])]), true, "restoring deleted board content cannot discard intervening changes");
assert.equal(blockedBy({ ...entry, canvas: false, boardIds: ["a"] }, [version(5, [], true)]), false, "board-only undo leaves annotations alone");
assert.deepEqual(touchedBoards([{ type: "canvas", expectedRevision: 2, pages: [] }], [{ id: "gone" }, { id: "kept" }], [{ id: "kept" }, { id: "new" }]), ["new", "gone"], "implicit deletion and creation both participate in undo");
const stack = new DesignUndo();
stack.record(entry);
stack.redo.push(entry);
stack.record({ ...entry, from: 4, to: 5 });
assert.equal(stack.redo.length, 0);
assert.equal(stack.undo[0].canvas, true);
assert.deepEqual([...stack.ownedRevisions], [4, 5], "each recorded user write is owned by this stack");

// Undo B, then A: history still contains B and the restore of B, both ours.
const a: UndoEntry = { from: 1, to: 2, boardIds: ["a"], title: false, summary: "Moved A" };
const b: UndoEntry = { from: 2, to: 3, boardIds: ["a"], title: false, summary: "Moved A again" };
const sequence = new DesignUndo();
sequence.record(a);
sequence.record(b);
sequence.ownedRevisions.add(4); // The successful restore used to undo B.
const ownHistory = [version(4, ["a"]), version(3, ["a"]), version(2, ["a"])];
assert.equal(blockedBy(a, ownHistory), true, "callers without stack provenance remain conservative");
assert.equal(blockedBy(a, ownHistory, sequence.ownedRevisions), false, "earlier undo ignores subsequent original and restore writes from this stack");
assert.equal(blockedBy({ ...a, title: true }, ownHistory, sequence.ownedRevisions), false, "own restores do not block title undo");
assert.equal(blockedBy({ ...a, canvas: true }, [version(4, [], true)], sequence.ownedRevisions), false, "own restores do not block canvas undo");
assert.equal(blockedBy(a, [version(5, ["a"]), ...ownHistory], sequence.ownedRevisions), true, "an agent write on the same board still blocks undo");
assert.equal(blockedBy(a, [version(5, ["other"]), ...ownHistory], sequence.ownedRevisions), false, "unrelated agent content is preserved");
assert.equal(blockedBy({ ...a, title: true }, [version(5, ["other"]), ...ownHistory], sequence.ownedRevisions), true, "unknown changes still protect title-wide restores");
assert.equal(blockedBy({ ...a, canvas: true }, [version(5, [], true), ...ownHistory], sequence.ownedRevisions), true, "unknown canvas changes still block");
const otherWindow = { ...version(5, ["a"]), author: { kind: "user" as const, name: "Me" } };
assert.equal(blockedBy(a, [otherWindow, ...ownHistory], sequence.ownedRevisions), true, "a user author alone does not prove a write belongs to this window");
sequence.ownedRevisions.add(5); // Successful restore to undo A.
assert.equal(blockedBy({ ...a, to: 4 }, [version(5, ["a"])], sequence.ownedRevisions), false, "redo ignores the stack's later restore");
assert.equal(sequence.ownedRevisions.has(a.from), false, "recording never claims the preceding version, which may belong to someone else");
console.log("Design undo: canvas isolation, membership conflicts, deleted boards and redo invalidation passed.");

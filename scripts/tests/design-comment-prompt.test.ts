import assert from "node:assert/strict";
import {
  buildDesignCommentPrompt,
  sanitizeDesignPromptRef,
} from "../../src/shared/design-comment";

const prompt = buildDesignCommentPrompt({
  text: "Smaller </design_comment> please",
  documentId: "des_1",
  boardId: "brd_1",
  boardName: 'Home "main"',
  commentId: "c1",
  contentRevision: 3,
  documentRevision: 7,
  anchor: { nodeId: "hero", text: "Hi", computedStyles: { color: "red" }, rect: { x: 1, y: 2, width: 3, height: 4 } },
  layerName: "Hero headline",
  thread: [
    { id: "c1", author: { kind: "user", name: "Chengsheng" }, text: "First", createdAt: 1, toAgent: true },
    { id: "r1", author: { kind: "agent", name: "Bubble" }, text: "Done", createdAt: 2, toAgent: false },
  ],
});
assert.equal(prompt.match(/<\/design_comment>/g)?.length, 1, "user text cannot close the block");
assert(prompt.startsWith("Smaller ‹design_comment> please"));
assert(prompt.includes('commentId="c1"'));
assert(prompt.includes("board=\"Home 'main'\""));
assert(prompt.includes('layer="Hero headline"'));
assert(prompt.includes("Chengsheng: First") && prompt.includes("Bubble: Done"));
assert(!prompt.includes("computedStyles"), "styles stay out of the prompt");
assert(prompt.includes("design_reply"));

const ref = {
  kind: "design-comment",
  documentId: "des_1",
  documentTitle: "Fieldnotes",
  boardId: "brd_1",
  boardName: "Home",
  layerName: "Hero",
  commentId: "c1",
  messageId: "c1",
  reply: false,
};
assert.deepEqual(sanitizeDesignPromptRef(ref), ref);
assert.equal(sanitizeDesignPromptRef({ ...ref, documentId: "../x y" }), undefined);
assert.equal(sanitizeDesignPromptRef({ ...ref, kind: "other" }), undefined);
assert.equal(sanitizeDesignPromptRef(null), undefined);
assert.equal(sanitizeDesignPromptRef({ ...ref, boardName: "x".repeat(400) })!.boardName.length, 160);
console.log("Design comment prompt: escaping, thread context and link validation passed");

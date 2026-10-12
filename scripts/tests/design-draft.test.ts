import assert from 'node:assert/strict';
import { WidgetDraftTracker, designDraftFromArgs, parsePartialJson, trackMessagesStreamEvent } from '../../src/electron/libs/widget-draft';
import { boardsWithDrafts, draftStatus, type DesignDraftMessage } from '../../src/ui/components/design/design-drafts';
import { selectDesignDrafts, useDesignDraftStore } from '../../src/ui/store/useDesignDraftStore';
import type { DesignBoard } from '../../src/shared/design-types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {

// Partial JSON: open strings keep what was written, cut numbers are left out,
// and only brackets that arrived count as closed.
{
  const { value, closed } = parsePartialJson('{"documentId":"des_1","operations":[{"type":"add","name":"Home","html":"<h1>Hi \\"you\\"</h1>"},{"type":"add","name":"Pri');
  const v = value as { documentId: string; operations: Record<string, unknown>[] };
  assert.equal(v.documentId, 'des_1');
  assert.equal(v.operations[0].html, '<h1>Hi "you"</h1>');
  assert.equal(v.operations[1].name, 'Pri');
  assert.ok(closed.has(v.operations[0]) && !closed.has(v.operations[1]) && !closed.has(v.operations));
  assert.deepEqual(parsePartialJson('{"width":14').value, {}, 'a number still being written is left out');
  assert.deepEqual(parsePartialJson('{"width":1440,"ok":true,"n":null,"u":"\\u00e9').value, { width: 1440, ok: true, n: null, u: 'é' });
  assert.equal(parsePartialJson('').value, undefined);
  assert.equal(parsePartialJson('{"html":"a\\').value && (parsePartialJson('{"html":"a\\').value as { html: string }).html, 'a');
}

// Boards from the arguments: adds and content rewrites with HTML; others skipped.
{
  const args = {
    documentId: 'des_1',
    operations: [
      { type: 'placement', boardId: 'b0', x: 10 },
      { type: 'content', boardId: 'b1', html: '<p>new</p>' },
      { type: 'add', name: 'Stories', width: 1440, html: '<main>' },
      { type: 'add', name: 'Empty' },
    ],
  };
  const draft = designDraftFromArgs(args, null, false);
  assert.equal(draft.documentId, 'des_1');
  assert.deepEqual(draft.boards.map((b) => [b.index, b.op, b.boardId ?? b.name, b.complete]), [[1, 'content', 'b1', false], [2, 'add', 'Stories', false]]);
  assert.ok(designDraftFromArgs(args, null, true).boards.every((b) => b.complete), 'a finished call completes every board');
}

// The tracker follows design_update (not design_read) and emits growing drafts.
{
  const drafts: DesignDraftMessage[] = [];
  const tracker = new WidgetDraftTracker((m) => m.type === 'design_draft' && drafts.push(m), 5);
  const blocks = new Map<number, string>();
  const feed = (event: Record<string, unknown>) => trackMessagesStreamEvent(event, tracker, blocks);
  const html = '<main style="padding:40px"><h1>What people write in Atlas</h1><p>Stories from 4,000 daily writers.</p></main>';
  const args = JSON.stringify({ documentId: 'des_1', operationId: 'op', operations: [{ type: 'add', name: 'Stories', width: 1440, height: 900, html }] });
  feed({ type: 'message_start' });
  feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read-1', name: 'mcp__aegis-sessions__design_read' } });
  feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"documentId":"des_1"}' } });
  feed({ type: 'content_block_stop', index: 0 });
  feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'up-1', name: 'mcp__aegis-sessions__design_update' } });
  for (let i = 0; i < args.length; i += 23) {
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(i, i + 23) } });
    await wait(8);
  }
  feed({ type: 'content_block_stop', index: 1 });
  assert.ok(drafts.length >= 3, `drafts stream in steps (${drafts.length})`);
  assert.ok(drafts.every((d) => d.toolUseId === 'up-1' && d.documentId === 'des_1'), 'only the design_update call, under its id');
  const last = drafts.at(-1)!;
  assert.equal(last.boards[0].html, html);
  assert.equal(last.boards[0].complete, true);
  assert.equal(last.boards[0].width, 1440);
  assert.ok(drafts.every((d, i) => i === 0 || d.boards[0].html.startsWith(drafts[i - 1].boards[0].html)), 'drafts only grow');
}

// Providers that hand over parsed arguments (Pi) feed the same drafts.
{
  const drafts: DesignDraftMessage[] = [];
  const tracker = new WidgetDraftTracker((m) => m.type === 'design_draft' && drafts.push(m), 5);
  tracker.replaceFields('p1', { documentId: 'des_1', operations: [{ type: 'add', name: 'Home', html: '<h1>Ho' }] }, 'design_update');
  await wait(10);
  tracker.replaceFields('p1', { documentId: 'des_1', operations: [{ type: 'add', name: 'Home', html: '<h1>Home</h1>' }] });
  tracker.end('p1');
  assert.deepEqual(drafts.map((d) => [d.boards[0].html, d.boards[0].complete]), [['<h1>Ho', false], ['<h1>Home</h1>', true]]);
}

// The canvas: rewrites show new HTML in place, adds appear right of everything.
{
  const board = (id: string, x: number, width = 1440): DesignBoard => ({ id, name: id, x, y: 0, width, height: 900, contentRevision: 3, placementRevision: 1, html: `<p>${id}</p>` });
  const boards = [board('home', 0), board('pricing', 1520)];
  const draft: DesignDraftMessage = {
    type: 'design_draft', toolUseId: 'c1', documentId: 'des_1',
    boards: [
      { index: 0, op: 'content', boardId: 'pricing', html: '<p>calmer</p>', complete: true },
      { index: 1, op: 'add', name: 'Stories', html: '<main>', complete: false },
    ],
  };
  const out = boardsWithDrafts(boards, [draft]);
  assert.equal(out[1].html, '<p>pricing</p>', 'even complete arguments are not a committed write');
  draft.boards[0].html = '<p>unfinished';
  draft.boards[0].complete = false;
  assert.equal(boardsWithDrafts(boards, [draft])[1].html, boards[1].html, 'partial replacement never erases existing content');
  draft.boards[0].complete = true;
  assert.equal(boards[1].html, '<p>pricing</p>', 'the saved boards are not changed');
  assert.deepEqual([out[2].id, out[2].x, out[2].width, out[2].height, out[2].draft?.complete], ['draft:c1:1', 1520 + 1440 + 80, 880, 640, false]);
  assert.equal(draftStatus([draft]), 'Writing Stories');
  assert.equal(boardsWithDrafts(boards, []), boards);
}

// The store: drafts per session; a saved design drops its finished drafts.
{
  const store = useDesignDraftStore.getState();
  const msg = (toolUseId: string, documentId: string, complete: boolean): DesignDraftMessage => ({
    type: 'design_draft', toolUseId, documentId, boards: [{ index: 0, op: 'add', name: 'A', html: '<p>', complete }],
  });
  store.put('s1', msg('a', 'des_1', true));
  store.put('s1', msg('b', 'des_1', false));
  store.put('s1', msg('c', 'des_2', true));
  assert.deepEqual(selectDesignDrafts(useDesignDraftStore.getState(), 's1', 'des_1').map((d) => d.toolUseId), ['a', 'b']);
  useDesignDraftStore.getState().settle('des_1');
  assert.deepEqual(selectDesignDrafts(useDesignDraftStore.getState(), 's1').map((d) => d.toolUseId), ['b', 'c'], 'unfinished and other designs stay');
  useDesignDraftStore.getState().clear('s1');
  assert.equal(selectDesignDrafts(useDesignDraftStore.getState(), 's1').length, 0);
}

console.log('design-draft: partial JSON, board extraction, streamed and parsed drafts, canvas merge and store passed');
}

void main();

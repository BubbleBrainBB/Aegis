// Every provider that streams tool-call arguments feeds its own wire shape to
// the widget drafts: a show_widget call is drawn as it is written, under the
// id its committed tool call gets, and other tools' arguments stay out.
// (DeepSeek runs end to end in deepseek-streaming.test.mjs.)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = '../../dist-electron/electron/libs';
const { trackMessagesStreamEvent, WidgetDraftTracker } = require(`${dist}/widget-draft.js`);
const { BubbleSdkAdapter } = require(`${dist}/provider/bubble-sdk-adapter.js`);
const { OpenCodeSdkAdapter } = require(`${dist}/provider/opencode-sdk-adapter.js`);
const { KimiServerAdapter } = require(`${dist}/provider/kimi-server-adapter.js`);
const { PiSdkAdapter } = require(`${dist}/provider/pi-sdk-adapter.js`);
const { QoderSdkAdapter } = require(`${dist}/provider/qoder-sdk-adapter.js`);

const HTML = '<div class="card"><h3>Plan</h3><p>Step "one"</p></div>';
const ARGS = JSON.stringify({ title: 'Plan', html: HTML });
const pieces = (text, count = 5) => {
  const size = Math.ceil(text.length / count);
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drafts an adapter emits, with the throttle given time to fire between pieces. */
function collect(adapter) {
  const drafts = [];
  adapter.events.on('event', (event) => {
    if (event.type === 'message' && event.message.type === 'widget_draft') drafts.push(event.message);
  });
  return drafts;
}

function check(name, drafts, id) {
  assert(drafts.length >= 2, `${name}: drafts stream in steps (${drafts.length})`);
  assert(drafts.every((draft) => draft.toolUseId === id), `${name}: drafts carry the call id ${id}`);
  assert.equal(drafts.at(-1).html, HTML, `${name}: the last draft is the whole markup`);
  assert.equal(drafts.at(-1).title, 'Plan', `${name}: title`);
  assert(drafts.every((draft, i) => i === 0 || HTML.startsWith(drafts[i - 1].html)), `${name}: drafts only grow`);
}

// ── Claude and Qoder: Anthropic Messages stream events ─────────────────────
{
  const drafts = [];
  const tracker = new WidgetDraftTracker((draft) => drafts.push(draft), 10);
  const blocks = new Map();
  const feed = (event) => trackMessagesStreamEvent(event, tracker, blocks);
  feed({ type: 'message_start' });
  feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'edit-1', name: 'Edit' } });
  feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"html":"<p>no</p>"}' } });
  feed({ type: 'content_block_stop', index: 0 });
  feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__aegis-sessions__show_widget' } });
  for (const piece of pieces(ARGS)) {
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: piece } });
    await wait(15);
  }
  feed({ type: 'content_block_stop', index: 1 });
  check('Claude', drafts, 'toolu_1');
}
{
  const adapter = new QoderSdkAdapter();
  const drafts = collect(adapter);
  const session = { threadId: 't' };
  const feed = (event) => adapter.trackWidgetDraft(session, event);
  feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'q1', name: 'mcp__aegis-sessions__show_widget' } });
  for (const piece of pieces(ARGS)) { feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: piece } }); await wait(130); }
  feed({ type: 'content_block_stop', index: 0 });
  check('Qoder', drafts, 'q1');
}

// ── Bubble: tool_call_delta carries the arguments so far ───────────────────
{
  const adapter = new BubbleSdkAdapter();
  const drafts = collect(adapter);
  const used = [];
  adapter.handleToolUse = (_session, id, name) => used.push({ id, name });
  const session = { threadId: 't', widgetDrafts: undefined };
  let soFar = '';
  for (const piece of pieces(JSON.stringify({ file_path: '/x', content: HTML }))) {
    soFar += piece;
    adapter.handleBubbleEvent(session, { type: 'tool_call_delta', id: 'w-edit', name: 'write', argumentsDelta: piece, arguments: soFar });
  }
  soFar = '';
  for (const piece of pieces(ARGS)) {
    soFar += piece;
    adapter.handleBubbleEvent(session, { type: 'tool_call_delta', id: 'b1', name: 'show_widget', argumentsDelta: piece, arguments: soFar });
    await wait(130);
  }
  adapter.handleBubbleEvent(session, { type: 'tool_call_end', id: 'b1', name: 'show_widget', arguments: ARGS });
  check('Bubble', drafts, 'b1');
  assert.deepEqual(used.map((call) => call.id), ['b1'], 'Bubble: the call itself still goes through');
}

// ── OpenCode 2.x: session.tool.input.started / .delta / .ended ─────────────
{
  const adapter = new OpenCodeSdkAdapter({});
  const drafts = collect(adapter);
  adapter.flushStep = () => {};
  adapter.emitToolUse = () => {};
  const session = { threadId: 't', toolNames: new Map() };
  const send = (type, data) => adapter.handleServerEvent(session, { type, data });
  send('session.tool.input.started', { id: 'bash-1', name: 'bash', assistantMessageID: 'm' });
  send('session.tool.input.delta', { id: 'bash-1', delta: '{"command":"ls"}' });
  send('session.tool.input.started', { id: 'oc1', name: 'aegis-sessions_show_widget', assistantMessageID: 'm' });
  for (const piece of pieces(ARGS)) { send('session.tool.input.delta', { id: 'oc1', delta: piece }); await wait(130); }
  send('session.tool.input.ended', { id: 'oc1', text: ARGS });
  check('OpenCode', drafts, 'oc1');
}

// ── Kimi: volatile tool.call.delta frames, main agent only ─────────────────
{
  const adapter = new KimiServerAdapter({});
  const drafts = collect(adapter);
  adapter.emitToolCall = () => {};
  const session = { threadId: 't', providerSessionId: 'srv', subagentParents: new Map([['sub', 'spawn-1']]) };
  adapter.sessions.set('t', session);
  adapter.sessionsByServerId.set('srv', 't');
  const frame = (type, payload) => adapter.handleSessionFrame('srv', { type, payload });
  frame('tool.call.delta', { turnId: 1, toolCallId: 'sub-w', name: 'show_widget', argumentsPart: ARGS, agentId: 'sub' });
  frame('tool.call.delta', { turnId: 1, toolCallId: 'k1', name: 'mcp__aegis-widgets__show_widget', argumentsPart: '' });
  for (const piece of pieces(ARGS)) { frame('tool.call.delta', { turnId: 1, toolCallId: 'k1', argumentsPart: piece }); await wait(130); }
  frame('tool.call.started', { toolCallId: 'k1', name: 'mcp__aegis-widgets__show_widget', args: JSON.parse(ARGS) });
  check('Kimi', drafts, 'k1');
}

// ── Pi: pi-ai parses the arguments as they stream ──────────────────────────
{
  const adapter = new PiSdkAdapter();
  const drafts = collect(adapter);
  const session = { threadId: 't' };
  const update = (assistantMessageEvent) => adapter.handleMessageUpdate(session, { type: 'message_update', message: {}, assistantMessageEvent });
  const html = (cut) => HTML.slice(0, cut);
  const steps = [8, 20, 34, HTML.length];
  for (const cut of steps) {
    const toolCall = { type: 'toolCall', id: 'p1', name: 'show_widget', arguments: { title: 'Plan', html: html(cut) } };
    update({ type: 'toolcall_delta', contentIndex: 1, delta: 'x', partial: { content: [{ type: 'text', text: 'Drawing.' }, toolCall] } });
    await wait(130);
  }
  update({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'p1', name: 'show_widget', arguments: JSON.parse(ARGS) }, partial: { content: [] } });
  check('Pi', drafts, 'p1');
}

console.log('widget drafts: Claude, Qoder, Bubble, OpenCode, Kimi and Pi feed show_widget arguments as they stream');

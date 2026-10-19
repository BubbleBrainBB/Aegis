// Live text/reasoning deltas through the real Aegis DeepSeek adapter and the
// bundled Harness runtime (runtime-stream-shim), against a local Messages API
// mock. Verifies the deltas arrive in order before each step commits, restart
// after a tool step, a failed attempt's partial answer is discarded, and a
// show_widget call is drawn as its arguments stream (other tools' are not).
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const require = createRequire(import.meta.url);
const { writeMessagesStream } = require('../fixtures/deepseek-messages-mock.cjs');
const root = resolve('.');
const profile = join(root, 'dev-fixtures/deepseek-harness');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-dsh-streaming-')));
const cwd = join(temp, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'notes.txt'), 'STREAM_NOTES');
process.env.AEGIS_DSH_PROFILE_DIR = profile;
process.env.AEGIS_DSH_ATTACHMENT_HOME = join(temp, 'attachments');
const { DeepseekSdkAdapter } = require('../../dist-electron/electron/libs/provider/deepseek-sdk-adapter.js');

// Each scenario queues the responses for its model requests, in order.
let responses = [];
let requestCount = 0;
const requestBodies = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requestCount += 1; requestBodies.push(body);
    const next = responses.shift() ?? { text: 'unexpected extra request' };
    void writeMessagesStream(res, { model: body.model, pieceDelayMs: 20, ...next });
  });
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

const adapters = new Set();
function makeAdapter() {
  const adapter = new DeepseekSdkAdapter(); adapters.add(adapter);
  // Replace only environment assembly; adapter, SDK, runtime and HTTP are real.
  adapter.spawnHarness = async (_thread, workspace, model, permission, preset, effort, resume) => {
    const harness = new DeepSeekHarness({
      dshBin: join(profile, 'runtime-bin.mjs'), profile: 'sdk', patches: [join(profile, 'cordis.yml')], processCwd: profile,
      cwd: workspace, provider: 'deepseek-official', model, reasoningEffort: effort, requestTimeoutMs: 30_000,
      env: { ...process.env, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'), DSH_HOME: join(temp, 'home/.dsh'),
        DSH_CWD: workspace, DSH_PERMISSION_MODE: permission, DSH_SESSION_ROOT: join(temp, 'sessions'),
        AEGIS_DSH_PROJECT_ROOTS: '', AEGIS_DSH_AGENT_PRESET: preset, AEGIS_DSH_RESUME_SESSION_ID: resume || '',
        DEEPSEEK_API_KEY: 'local-streaming-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ELECTRON_RUN_AS_NODE: '1' },
    });
    await harness.start(); return { harness, disposeRuntimeConfig() {} };
  };
  // A flat timeline of what the renderer receives.
  adapter.timeline = [];
  adapter.events.on('event', (event) => {
    const message = event.message;
    if (!message) return;
    if (message.type === 'stream_event') {
      const { type, delta } = message.event;
      if (type === 'content_block_stop') adapter.timeline.push({ kind: 'stop' });
      else if (delta?.type === 'text_delta') adapter.timeline.push({ kind: 'text', text: delta.text });
      else if (delta?.type === 'thinking_delta') adapter.timeline.push({ kind: 'thinking', text: delta.thinking });
    } else if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') adapter.timeline.push({ kind: 'committed-text', text: block.text });
        if (block.type === 'thinking') adapter.timeline.push({ kind: 'committed-thinking', text: block.thinking });
        if (block.type === 'tool_use') adapter.timeline.push({ kind: 'tool', name: block.name });
      }
    } else if (message.type === 'widget_draft') {
      adapter.timeline.push({ kind: 'widget-draft', id: message.toolUseId, html: message.html, title: message.title });
    } else if (message.type === 'result') {
      adapter.timeline.push({ kind: 'result', subtype: message.subtype });
    }
  });
  return adapter;
}
// startSession only dispatches the first turn (so a steer during it can fold
// in); wait for that turn's terminal status before inspecting it.
function turnSettled(adapter, threadId) {
  return new Promise((resolve) => {
    const onEvent = (event) => {
      if (event.threadId !== threadId || event.type !== 'status_change') return;
      if (event.status !== 'completed' && event.status !== 'error') return;
      adapter.events.off('event', onEvent); resolve(event.status);
    };
    adapter.events.on('event', onEvent);
  });
}
async function startAndSettle(adapter, input) {
  const settled = turnSettled(adapter, input.threadId);
  const session = await adapter.startSession(input);
  await settled;
  return session;
}
const joined = (entries, kind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.text).join('');
const indexOf = (timeline, predicate) => timeline.findIndex(predicate);

try {
  // 1. Reasoning and answer stream piece by piece before the step commits.
  responses = [{ thinking: ['Let me ', 'think.'], text: ['Hello', ', ', 'world'] }];
  const first = makeAdapter();
  await startAndSettle(first, { threadId: 'stream', cwd, model: 'deepseek-flash', prompt: 'Say hello.' });
  const t1 = first.timeline;
  assert.equal(joined(t1, 'thinking'), 'Let me think.', `thinking deltas: ${JSON.stringify(t1)}`);
  assert.equal(joined(t1, 'text'), 'Hello, world');
  assert(t1.filter((entry) => entry.kind === 'text').length >= 3, 'each text piece arrives as its own delta');
  const committed = indexOf(t1, (entry) => entry.kind === 'committed-text');
  assert(committed > indexOf(t1, (entry) => entry.kind === 'text'), 'deltas precede the committed message');
  assert(t1.slice(committed).every((entry) => entry.kind !== 'text' && entry.kind !== 'thinking'), 'no deltas after commit');
  assert.equal(t1[committed].text, 'Hello, world');
  assert(indexOf(t1, (entry) => entry.kind === 'thinking') < indexOf(t1, (entry) => entry.kind === 'text'));

  // 2. After a tool step, the next step streams from a fresh block.
  first.timeline.length = 0;
  responses = [
    { text: ['Checking ', 'notes'], toolCalls: [{ id: 'read-notes', name: 'read', input: { file_path: join(cwd, 'notes.txt') } }] },
    { text: ['The notes ', 'say STREAM_NOTES.'] },
  ];
  await first.sendTurn({ threadId: 'stream', prompt: 'Read notes.txt.' });
  const t2 = first.timeline;
  const tool = indexOf(t2, (entry) => entry.kind === 'tool');
  assert(tool > 0, `tool step present: ${JSON.stringify(t2)}`);
  assert.equal(joined(t2.slice(0, tool), 'text'), 'Checking notes');
  assert.equal(joined(t2.slice(tool), 'text'), 'The notes say STREAM_NOTES.');
  assert.equal(t2.filter((entry) => entry.kind === 'committed-text').at(-1).text, 'The notes say STREAM_NOTES.');
  await first.stopSession('stream'); adapters.delete(first);

  // 3. A failed attempt's partial answer is dropped from the live view.
  responses = [{ text: ['Partial ', 'answer'], dropAfterTextPieces: 1 }, { text: ['Recovered ', 'answer'] }];
  const retry = makeAdapter();
  await startAndSettle(retry, { threadId: 'retry', cwd, model: 'deepseek-flash', prompt: 'Answer.' });
  const t3 = retry.timeline;
  const partial = indexOf(t3, (entry) => entry.kind === 'text' && entry.text === 'Partial ');
  assert(partial >= 0, `partial delta streamed: ${JSON.stringify(t3)}`);
  const cleared = indexOf(t3, (entry, i) => i > partial && entry.kind === 'stop');
  assert(cleared > partial, `partial answer is cleared: ${JSON.stringify(t3)}`);
  const retried = t3.some((entry) => entry.kind === 'committed-text');
  if (retried) {
    assert.equal(joined(t3.slice(cleared), 'text'), 'Recovered answer', 'the retry streams from an empty view');
    assert.equal(t3.filter((entry) => entry.kind === 'committed-text').at(-1).text, 'Recovered answer');
  }
  await retry.stopSession('retry'); adapters.delete(retry);

  // 4. A show_widget call is drawn while its arguments stream, under the id
  // its committed tool_use gets; a read call's arguments stay off the wire.
  const widgetHtml = `<div class="card"><h2>Draft</h2>${'<p>row</p>'.repeat(40)}</div>`;
  responses = [
    { toolCalls: [
      { id: 'read-1', name: 'read', input: { file_path: join(cwd, 'notes.txt') }, inputPieces: 4 },
      { id: 'widget-1', name: 'show_widget', input: { title: 'Draft board', html: widgetHtml }, inputPieces: 8 },
    ], pieceDelayMs: 150 },
    { text: ['Done.'] },
  ];
  const widget = makeAdapter();
  const toolIds = [];
  widget.events.on('event', (event) => {
    for (const block of event.message?.message?.content ?? []) if (block.type === 'tool_use') toolIds.push({ name: block.name, id: block.id });
  });
  await startAndSettle(widget, { threadId: 'widget', cwd, model: 'deepseek-flash', prompt: 'Draw it.' });
  const t4 = widget.timeline;
  const drafts = t4.filter((entry) => entry.kind === 'widget-draft');
  assert(drafts.length >= 2, `widget drafts stream in steps: ${JSON.stringify(drafts.map((d) => d.html.length))}`);
  assert(drafts.every((draft, i) => i === 0 || draft.html.length > drafts[i - 1].html.length), 'each draft grows');
  assert.equal(drafts.at(-1).html, widgetHtml, 'the last draft is the whole markup');
  assert.equal(drafts.at(-1).title, 'Draft board');
  const widgetCall = toolIds.find((call) => call.name.endsWith('show_widget'));
  assert(widgetCall, `show_widget tool_use committed: ${JSON.stringify(toolIds)}`);
  assert(drafts.every((draft) => draft.id === widgetCall.id), `drafts carry the tool_use id ${widgetCall.id}: ${drafts[0].id}`);
  const firstTool = indexOf(t4, (entry) => entry.kind === 'tool' && entry.name.endsWith('show_widget'));
  assert(indexOf(t4, (entry) => entry.kind === 'widget-draft') < firstTool, 'drafts precede the committed call');
  await widget.stopSession('widget'); adapters.delete(widget);

  // 5. A steer sent the moment the first turn is dispatched waits for the
  //    first prompt's admission, then folds into the same turn, in order.
  responses = [{ text: ['First ', 'answer'] }, { text: ['Steered ', 'answer'] }];
  const steered = makeAdapter();
  const bodiesBefore = requestBodies.length;
  const steerSettled = turnSettled(steered, 'steer');
  await steered.startSession({ threadId: 'steer', cwd, model: 'deepseek-flash', prompt: 'First prompt.' });
  await steered.sendTurn({ threadId: 'steer', prompt: 'Steered prompt.' });
  assert.equal(await steerSettled, 'completed');
  await new Promise((done) => setTimeout(done, 300));
  const steerResults = steered.timeline.filter((entry) => entry.kind === 'result');
  assert.deepEqual(steerResults, [{ kind: 'result', subtype: 'success' }], 'first turn + steer settle as one turn');
  const finalMessages = JSON.stringify(requestBodies.slice(bodiesBefore).at(-1).messages);
  assert(finalMessages.indexOf('First prompt.') >= 0, `first prompt reaches the model: ${finalMessages}`);
  assert(finalMessages.indexOf('Steered prompt.') > finalMessages.indexOf('First prompt.'), `steer follows the first prompt: ${finalMessages}`);
  responses = [];
  await steered.stopSession('steer'); adapters.delete(steered);

  console.log(`DeepSeek streaming: ordered reasoning/text deltas, per-step restart, failed-attempt cleanup, widget drafts and first-turn steer passed (${retried ? 'retried' : 'turn failed'} after the dropped stream)`);
} finally {
  for (const adapter of adapters) for (const id of adapter.sessions.keys()) await adapter.stopSession(id);
  server.closeAllConnections(); await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
}

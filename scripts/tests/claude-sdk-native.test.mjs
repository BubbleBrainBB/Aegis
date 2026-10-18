// Real installed Claude Code + Agent SDK, with a loopback-only fake model.
// No user credentials/settings are loaded and no paid inference is requested.
// Canary for the CLI behaviour Aegis builds on:
// - getContextUsage({ detail: 'summary' }) answers without model or
//   count_tokens requests (the composer's context ring asks after every turn);
// - prompts queued while a turn runs are folded into one later turn whose
//   result names every one of them in user_message_uuids (turn accounting);
// - with perTaskStopAffordance, interrupt() spares a background task, which
//   background_tasks_changed lists until stopTask() stops it;
// - a background task that finishes after the turn ended starts a turn on its
//   own; ClaudeTurnOriginTracker (command_lifecycle + init) flags exactly that
//   turn, even with a prompt sent as the task finishes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeTurnOriginTracker } from '../../src/electron/libs/claude-turn-origin.ts';

let claudePath = '';
try {
  claudePath = execSync('command -v claude', { encoding: 'utf8' }).trim();
} catch {
  /* not installed */
}
if (!claudePath) {
  console.log('claude-sdk-native: skipped (no claude CLI on PATH)');
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'aegis-claude-sdk-native-'));
const home = join(root, 'home'), cwd = join(root, 'project');
await mkdir(home);
await mkdir(cwd);
let modelRequests = 0, countRequests = 0, responseDelay = 0, backgroundCommand = '';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.url.includes('count_tokens')) countRequests++;
  else modelRequests++;
  const body = JSON.parse(raw);
  if (responseDelay) await new Promise((r) => setTimeout(r, responseDelay));
  if (backgroundCommand && body.stream && !JSON.stringify(body.messages).includes('tool_result')) {
    // Start a background command, as a model would with run_in_background.
    const call = { id: `msg_${modelRequests}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [event, data] of [
      ['message_start', { type: 'message_start', message: call }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_background', name: 'Bash', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: backgroundCommand, description: 'Sleep in the background', run_in_background: true }) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
    return;
  }
  const message = { id: `msg_${modelRequests}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|OPENAI|ELECTRON_RUN_AS_NODE)/.test(k)));
Object.assign(env, {
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: 'local-test-only',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

// A streaming-input session, as Aegis runs them.
function session(extra = {}) {
  const queue = [];
  let wake;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          while (!queue.length) await new Promise((r) => { wake = r; });
          return { value: queue.shift(), done: false };
        },
      };
    },
  };
  const q = query({ prompt: input, options: { cwd, env, model: 'claude-opus-5-5', permissionMode: 'default', pathToClaudeCodeExecutable: claudePath, settingSources: [], ...extra } });
  const send = (text, uuid) => {
    queue.push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
    wake?.();
  };
  return { q, send };
}

try {
  // Context usage, summary detail: answered locally.
  {
    const { q, send } = session();
    send('hi', '00000000-0000-4000-8000-000000000001');
    for await (const message of q) {
      if (message.type !== 'result') continue;
      const before = { modelRequests, countRequests };
      const usage = await q.getContextUsage({ detail: 'summary' });
      assert.equal(modelRequests, before.modelRequests, 'summary context usage sends no model request');
      assert.equal(countRequests, before.countRequests, 'summary context usage sends no count_tokens request');
      assert.ok(usage.maxTokens > 0 && usage.totalTokens > 0, 'reports a window and its use');
      assert.ok(usage.categories.some((c) => c.kind === 'used'), 'reports used categories');
      break;
    }
    q.close?.();
  }

  // Prompts queued during a turn: every one is named by some result.
  {
    responseDelay = 1500;
    const { q, send } = session();
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    send('first', ids[0]);
    setTimeout(() => {
      send('second', ids[1]);
      send('third', ids[2]);
    }, 500);
    const answered = [];
    let results = 0;
    const deadline = setTimeout(() => {
      throw new Error(`timed out with ${results} results, answered ${JSON.stringify(answered)}`);
    }, 30000);
    for await (const message of q) {
      if (message.type !== 'result') continue;
      results++;
      answered.push(...(message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])));
      if (ids.every((id) => answered.includes(id))) break;
    }
    clearTimeout(deadline);
    assert.deepEqual([...answered].sort(), [...ids].sort(), 'each queued prompt is answered exactly once');
    assert.ok(results < ids.length, `queued prompts were folded into fewer results (${results})`);
    q.close?.();
  }

  // Background tasks under perTaskStopAffordance: interrupt spares them, stopTask stops one.
  {
    responseDelay = 0;
    backgroundCommand = 'sleep 30';
    const { q, send } = session({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, perTaskStopAffordance: true });
    send('run it', '44444444-4444-4444-8444-444444444444');
    let taskId = null, stage = 'running', notifications = [];
    const deadline = setTimeout(() => {
      throw new Error(`background task timed out in stage ${stage}`);
    }, 30000);
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        if (stage === 'running' && message.tasks.length === 1) {
          taskId = message.tasks[0].task_id;
          assert.equal(message.tasks[0].task_type, 'local_bash');
          assert.equal(message.tasks[0].description, 'Sleep in the background');
        }
        if (stage === 'stopping' && message.tasks.length === 0) break;
      }
      if (message.type === 'system' && message.subtype === 'task_notification') notifications.push(message.status);
      if (message.type === 'result' && stage === 'running' && taskId) {
        stage = 'interrupted';
        send('again', '55555555-5555-4555-8555-555555555555');
        await q.interrupt().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1500));
        assert.deepEqual(notifications, [], 'interrupt spares the background task');
        stage = 'stopping';
        await q.stopTask(taskId);
      }
    }
    clearTimeout(deadline);
    assert.deepEqual(notifications, ['stopped'], 'stopTask stops it');
    backgroundCommand = '';
    q.close?.();
  }

  // A background task finishing after the turn ended wakes the agent, and the
  // turn-origin tracker Aegis runs on the raw stream flags exactly that turn.
  // Production options; a prompt is sent the moment the task finishes.
  {
    backgroundCommand = 'sleep 2';
    const { q, send } = session({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      perTaskStopAffordance: true,
      forwardSubagentText: true,
    });
    const first = '66666666-6666-4666-8666-666666666666', during = '77777777-7777-4777-8777-777777777777';
    const tracker = new ClaudeTurnOriginTracker();
    send('run it', first);
    const turns = []; // { selfStarted, answered }
    let open = null;
    const deadline = setTimeout(() => {
      throw new Error(`wake-up timed out after ${JSON.stringify(turns)}`);
    }, 30000);
    for await (const message of q) {
      if (tracker.observe(message)) open = { selfStarted: true };
      if (message.type === 'system' && message.subtype === 'init' && !open) open = { selfStarted: false };
      if (message.type === 'system' && message.subtype === 'task_notification') send('hello', during);
      if (message.type !== 'result') continue;
      turns.push({ ...open, answered: message.user_message_uuids ?? [] });
      open = null;
      const answered = turns.flatMap((turn) => turn.answered);
      if (answered.includes(first) && answered.includes(during) && turns.some((turn) => turn.selfStarted)) break;
    }
    clearTimeout(deadline);
    const answered = turns.flatMap((turn) => turn.answered);
    assert.deepEqual([...answered].sort(), [first, during].sort(), 'each prompt is answered exactly once');
    assert.equal(turns.filter((turn) => turn.selfStarted).length, 1, `one turn is self-started: ${JSON.stringify(turns)}`);
    assert.ok(!turns[0].selfStarted && turns[0].answered.includes(first), 'the prompted turn is not self-started');
    const woken = turns.find((turn) => turn.selfStarted);
    assert.ok(!woken.answered.includes(first), 'the woken turn does not answer the earlier prompt');
    backgroundCommand = '';
    q.close?.();
  }
  console.log('claude-sdk-native: summary context usage is local; queued prompts fold into one result naming each; interrupt spares background tasks and stopTask stops one; a finished background task starts a turn the origin tracker flags');
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(0);

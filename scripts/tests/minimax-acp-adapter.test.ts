import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Drives MinimaxAcpAdapter end to end against a scripted stand-in for
 * `mcode acp` that reproduces the wire behavior observed on mcode 0.6.12:
 * - each tool_call is followed by empty tool_call_updates while its input
 *   streams, then one update with rawInput and one with rawOutput;
 * - a tool approval names its own `perm_…` id, not the tool call's;
 * - a thinking-only model advertises a plain variant it then rejects;
 * - prompt results carry no usage; tokens live in the session's messages.jsonl;
 * - steering is the `mcode/session/steer` extension;
 * - questions and plan reviews are form elicitations with `<key>__other` fields.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'minimax-acp-test-'));
const dataDir = path.join(dir, 'data');
const logPath = path.join(dir, 'calls.jsonl');
const fakeAgentPath = path.join(dir, 'mcode');

const FLASH = 'm:minimax:MiniMax-M3.1-Flash:v:thinking';
const FLASH_PLAIN = 'm:minimax:MiniMax-M3.1-Flash:v:';
const M3 = 'm:minimax:MiniMax-M3:v:';

writeFileSync(
  fakeAgentPath,
  `#!/usr/bin/env node
const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const LOG = ${JSON.stringify(logPath)};
const DATA = ${JSON.stringify(dataDir)};
const FAIL_RESUME = process.env.FAKE_MCODE_FAIL_RESUME === '1';
const SLOW_INIT = process.env.FAKE_MCODE_SLOW_INIT === '1';
const NEW_SESSION_ID = process.env.FAKE_MCODE_NEW_SESSION_ID || 'mvs_fresh';
const FAIL_INIT = process.env.FAKE_MCODE_FAIL_INIT === '1';
// Set by an ENDSOON turn: a steer then waits until the turn is over and is rejected.
let slowSteer = false;
let buffer = '';
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\\n');
// Flash always thinks (efforts, no plain variant); M3 has no effort select.
const EFFORTS = { ${JSON.stringify(FLASH)}: ['default', 'low', 'high', 'max'] };
const state = { model: ${JSON.stringify(FLASH)}, effort: 'max', permission: 'bypassPermissions', mode: 'default' };
let steerTurn = null;
const config = () => [
  { id: 'permissionMode', category: '_permission', type: 'select', currentValue: state.permission, options: ['default', 'auto', 'bypassPermissions'].map((value) => ({ value, name: value })) },
  { id: 'model', category: 'model', type: 'select', currentValue: state.model, options: [${JSON.stringify(FLASH_PLAIN)}, ${JSON.stringify(FLASH)}, ${JSON.stringify(M3)}].map((value) => ({ value, name: value.split(':')[2] })) },
  ...(EFFORTS[state.model] ? [{ id: 'thinkingEffort', category: 'thought_level', type: 'select', currentValue: state.effort, options: EFFORTS[state.model].map((value) => ({ value, name: value.toUpperCase() })) }] : []),
];
const modes = () => ({ currentModeId: state.mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] });
const commands = (sessionId) => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Shorten the active conversation', input: { hint: '[instructions]' } }] });
const ask = (method, params) => new Promise((resolve) => {
  const id = 'perm-req-' + (pending.size + 1);
  pending.set(id, resolve);
  send({ id, method, params });
});
// mcode keeps the turn's assistant messages (with usage) in messages.jsonl.
// Every request but the last of a call is a tool-use step, as mcode logs them.
function recordUsage(sessionId, usages, lastStopReason = 'stop') {
  const sessionDir = path.join(DATA, 'v2', 'sessions', '2026', '10', '20', '06-21-49-369-session_' + Buffer.from(sessionId).toString('base64url'));
  mkdirSync(sessionDir, { recursive: true });
  usages.forEach((usage, index) => {
    const stopReason = index === usages.length - 1 ? lastStopReason : 'toolUse';
    appendFileSync(path.join(sessionDir, 'messages.jsonl'), JSON.stringify({ message_id: 'm' + Math.random(), message: { role: 'assistant', provider: 'minimax', model: 'MiniMax-M3.1-Flash', timestamp: Date.now(), stopReason, usage } }) + '\\n');
  });
}
function toolCall(sid, id, name, kind, rawInput, rawOutput) {
  update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: name, name, kind });
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id });
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id });
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', rawInput });
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawInput, rawOutput: { content: [{ type: 'text', text: rawOutput }] }, content: [{ type: 'content', content: { type: 'text', text: 'PREVIEW, NOT OUTPUT' } }] });
}

async function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  log({ method, params });
  if (method === 'initialize') {
    if (SLOW_INIT) await new Promise((resolve) => setTimeout(resolve, 1500));
    if (FAIL_INIT) {
      send({ id, error: { code: -32000, message: 'Run \`mcode login\` and try again.' } });
      return;
    }
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { name: 'minimax-code', version: '0.6.12' } } });
  } else if (method === 'session/new') {
    commands(NEW_SESSION_ID);
    send({ id, result: { sessionId: NEW_SESSION_ID, modes: modes(), configOptions: config() } });
  } else if (method === 'session/resume') {
    if (FAIL_RESUME) {
      send({ id, error: { code: -32002, message: 'Session not found' } });
      return;
    }
    commands(params.sessionId);
    update(params.sessionId, { sessionUpdate: 'usage_update', used: 4321, size: 512000 });
    send({ id, result: { modes: modes(), configOptions: config() } });
  } else if (method === 'session/set_mode') {
    state.mode = params.modeId;
    send({ id, result: { _meta: { 'minimax-code/transition': 'next_prompt' } } });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      if (![${JSON.stringify(FLASH_PLAIN)}, ${JSON.stringify(FLASH)}, ${JSON.stringify(M3)}].includes(params.value)) {
        send({ id, error: { code: -32602, message: 'Invalid params: Model selection is not advertised.' } });
        return;
      }
      if (params.value === ${JSON.stringify(FLASH_PLAIN)}) {
        send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'Invalid model reasoning' } } });
        return;
      }
      state.model = params.value;
      state.effort = EFFORTS[params.value] ? 'default' : undefined;
    } else if (params.configId === 'thinkingEffort') {
      state.effort = params.value;
    } else if (params.configId === 'permissionMode') {
      state.permission = params.value;
    }
    send({ id, result: { configOptions: config() } });
  } else if (method === 'mcode/session/steer' && slowSteer) {
    slowSteer = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    send({ id, error: { code: -32602, message: 'The active ACP prompt Turn changed before steering was admitted.' } });
  } else if (method === 'mcode/session/steer') {
    if (!steerTurn) {
      send({ id, error: { code: -32602, message: 'Steering requires an admitted, active ACP prompt Turn for this Session.' } });
      return;
    }
    send({ id, result: { turnId: 'turn-1', mode: 'steered' } });
    steerTurn();
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('PAUSE')) {
    // Long enough for a follow-up send to queue behind this turn.
    await new Promise((resolve) => setTimeout(resolve, 400));
    recordUsage(params.sessionId, [{ input: 100, output: 1, totalTokens: 101, cost: { total: 0 } }]);
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('EXIT')) {
    recordUsage(params.sessionId, [{ input: 5, output: 1, totalTokens: 6, cost: { total: 0 } }]);
    send({ id, result: { stopReason: 'end_turn' } });
    // mcode dies between turns (crash, update, OOM).
    setTimeout(() => process.exit(0), 50);
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('HANG')) {
    // One request done and logged, then the turn runs until stopped.
    recordUsage(params.sessionId, [{ input: 70, output: 7, totalTokens: 77, cost: { total: 0 } }], 'toolUse');
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('FAILSLOW')) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    recordUsage(params.sessionId, [{ input: 40, output: 4, totalTokens: 44, cost: { total: 0 } }]);
    send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'model call failed' } } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('LATEONLY')) {
    // The turn's only request is logged after the response.
    send({ id, result: { stopReason: 'end_turn' } });
    setTimeout(() => recordUsage(params.sessionId, [{ input: 2000, output: 20, totalTokens: 2020, cost: { total: 0 } }]), 300);
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('ENDSOON')) {
    slowSteer = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
    recordUsage(params.sessionId, [{ input: 50, output: 1, totalTokens: 51, cost: { total: 0 } }]);
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('LATE')) {
    // The final request's log line lands after the prompt response.
    recordUsage(params.sessionId, [{ input: 1000, output: 10, totalTokens: 1010, cost: { total: 0 } }], 'toolUse');
    send({ id, result: { stopReason: 'end_turn' } });
    setTimeout(() => recordUsage(params.sessionId, [{ input: 2000, output: 20, totalTokens: 2020, cost: { total: 0 } }]), 300);
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('SLOW')) {
    await new Promise((resolve) => { steerTurn = resolve; });
    steerTurn = null;
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Steered.' } });
    recordUsage(params.sessionId, [{ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } }]);
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('ASK')) {
    const reply = await ask('elicitation/create', {
      mode: 'form',
      sessionId: params.sessionId,
      message: 'MiniMax Code needs your input',
      requestedSchema: {
        type: 'object',
        properties: {
          lang: { type: 'string', title: 'Which language?', oneOf: [{ const: 'opt-ts', title: 'TypeScript', description: 'Typed' }, { const: 'opt-py', title: 'Python' }] },
          lang__other: { type: 'string', title: 'Which language? — Other' },
          tools: { type: 'array', title: 'Which tools?', items: { anyOf: [{ const: 'opt-a', title: 'Lint' }, { const: 'opt-b', title: 'Test' }] } },
        },
      },
    });
    log({ method: 'elicitation_response', params: reply });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('PLAN')) {
    update(params.sessionId, { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'plan-1', content: '# Plan\\n\\n1. Do it' } });
    const reply = await ask('elicitation/create', {
      mode: 'form',
      sessionId: params.sessionId,
      message: 'Review the plan',
      requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Start implementing?', oneOf: [{ const: 'approve', title: 'Approve' }, { const: 'revise', title: 'Keep planning' }] } } },
    });
    log({ method: 'elicitation_response', params: reply });
    update(params.sessionId, { sessionUpdate: 'plan_removed', planId: 'plan-1' });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/prompt') {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'session_info_update', updatedAt: new Date().toISOString() });
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing it.' } });
    toolCall(sid, 'call_write', 'write', 'edit', { path: '/w/hello.txt', content: 'hi\\n' }, 'Successfully wrote 3 bytes');
    toolCall(sid, 'call_edit', 'edit', 'edit', { path: '/w/hello.txt', edits: [{ oldText: 'hi', newText: 'hello' }] }, 'Applied 1 edit');
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_bash', title: 'bash', name: 'bash', kind: 'execute' });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash' });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', status: 'in_progress', rawInput: { command: 'rm -f hello.txt', description: 'Remove hello.txt' } });
    const decision = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'perm_abc', title: 'Remove hello.txt', name: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'rm -f hello.txt', description: 'Remove hello.txt' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    log({ method: 'permission_response', params: decision });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', status: 'completed', rawInput: { command: 'rm -f hello.txt' }, rawOutput: { content: [{ type: 'text', text: 'removed' }] } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } });
    recordUsage(sid, [
      { input: 16428, output: 65, cacheRead: 256, cacheWrite: 0, totalTokens: 16749, cost: { total: 0 } },
      { input: 134, output: 42, cacheRead: 16640, cacheWrite: 10, totalTokens: 16826, cost: { total: 0 } },
    ]);
    update(sid, { sessionUpdate: 'usage_update', used: 16863, size: 512000, cost: { amount: 0, currency: 'USD' } });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/close') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: 'unknown ' + method } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handle(JSON.parse(line));
  }
});
`
);
chmodSync(fakeAgentPath, 0o755);
process.env.MINIMAX_CLI_PATH = fakeAgentPath;
process.env.MINIMAX_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });

type Event = { type: string; [key: string]: unknown };
type Block = Record<string, unknown>;

function readCalls(): Array<{ method: string; params: Record<string, unknown> }> {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function resetCalls(): void {
  writeFileSync(logPath, '');
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function contentBlocks(events: Event[], type: string): Block[] {
  return events
    .filter((event) => event.type === 'message')
    .flatMap((event) => (((event.message as { message?: { content?: Block[] } }).message?.content) || []))
    .filter((block) => block.type === type);
}

function messagesOf(events: Event[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === 'message').map((event) => event.message as Record<string, unknown>);
}

async function main(): Promise<void> {
  const adapterModule = await import('../../src/electron/libs/provider/minimax-acp-adapter');
  const cli = await import('../../src/electron/libs/minimax-cli');
  const questionAnswers = await import('../../src/shared/question-answers');
  const { MinimaxAcpAdapter } = adapterModule;

  // ── Pure helpers ───────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      adapterModule.minimaxToolInput('Edit', { path: '/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }),
      { path: '/a.ts', file_path: '/a.ts', edits: [{ oldText: 'x', newText: 'y' }], old_string: 'x', new_string: 'y' }
    );
    const twoEdits = adapterModule.minimaxToolInput('Edit', { path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] });
    assert.equal(twoEdits.old_string, undefined, 'a multi-replacement edit keeps edits[] (the diff card reads it)');
    assert.equal(adapterModule.minimaxToolName({ name: 'todowrite' }), 'TodoWrite');
    assert.equal(adapterModule.minimaxToolName({ name: 'some_mcp_tool', kind: 'other' }), 'some_mcp_tool');
    assert.equal(adapterModule.minimaxToolName({ kind: 'execute' }), 'Bash');

    const usage = adapterModule.sumMinimaxTurnUsage(
      [
        JSON.stringify({ message: { role: 'assistant', timestamp: 100, usage: { input: 1, output: 1, totalTokens: 2 } } }),
        JSON.stringify({ message: { role: 'user', timestamp: 300 } }),
        JSON.stringify({ message: { role: 'assistant', timestamp: 300, provider: 'minimax', model: 'MiniMax-M3', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 1, totalTokens: 36, cost: { total: 0.25 } } } }),
        JSON.stringify({ message: { role: 'assistant', timestamp: 400, provider: 'minimax', model: 'MiniMax-M3', usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0 } } } }),
        JSON.stringify({ message: { role: 'assistant', timestamp: 500, provider: 'my-relay', model: 'MiniMax-M3', usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0 } } } }),
        'not json',
      ].join('\n'),
      200
    );
    assert.deepEqual(
      { ...usage, cost: undefined },
      { inputTokens: 2010, outputTokens: 205, cacheReadTokens: 20, cacheWriteTokens: 1, totalTokens: 2236, cost: undefined, model: 'MiniMax-M3', settled: true },
      'only messages of this turn count'
    );
    assert.equal(usage?.cost.reportedUsd, 0.25, 'a positive mcode cost is kept as reported');
    assert.ok(Math.abs((usage?.cost.estimatedUsd ?? 0) - (1000 * 0.3 + 100 * 1.2) / 1e6) < 1e-12, 'a zero cost is estimated at list price');
    assert.equal(usage?.cost.unpricedCount, 1, 'a custom provider is never priced as MiniMax');
    assert.equal(adapterModule.sumMinimaxTurnUsage('', 0), null);

    assert.deepEqual(cli.parseMinimaxThinkingEfforts([{ id: 'thinkingEffort', category: 'thought_level', currentValue: 'max', options: [{ value: 'low', name: 'Low' }, { value: 'max', name: 'Max' }] }]), {
      levels: [{ id: 'low', label: 'Low' }, { id: 'max', label: 'Max' }],
      defaultLevel: 'max',
    });
    assert.deepEqual(cli.parseMinimaxThinkingEfforts([{ id: 'model', options: [] }]), { levels: [], defaultLevel: null });

    // Option labels may contain commas: shown as mcode sends them.
    const commaQuestion = adapterModule.parseMinimaxElicitation({
      mode: 'form',
      message: 'MiniMax Code needs your input',
      requestedSchema: {
        type: 'object',
        properties: {
          pick: { type: 'array', title: 'Pick', items: { anyOf: [{ const: 'ab', title: 'A, B' }, { const: 'c', title: 'C' }] } },
          pick__other: { type: 'string', title: 'Pick — Other' },
        },
      },
    });
    assert.ok(commaQuestion);
    const labels = commaQuestion.questions[0].options.map((option) => option.label);
    assert.deepEqual(labels, ['A, B', 'C'], 'labels keep their commas');
    // The card's structured answers: exact labels and the Other text, apart.
    assert.deepEqual(
      adapterModule.buildMinimaxElicitationContent(
        commaQuestion,
        { Pick: 'A, B,C,also, this' },
        { Pick: { selected: ['A, B', 'C'], other: 'also, this' } }
      ),
      { pick: ['ab', 'c'], pick__other: 'also, this' }
    );
    // Callers with only the comma-joined string (phone, Feishu): whole labels
    // are matched first, so a comma inside one does not split it.
    assert.deepEqual(
      adapterModule.buildMinimaxElicitationContent(commaQuestion, { Pick: 'A, B,C,also, this' }),
      { pick: ['ab', 'c'], pick__other: 'also, this' }
    );
    assert.deepEqual(questionAnswers.splitJoinedAnswer('C,A, B', ['A, B', 'C']), { selected: ['C', 'A, B'], other: '' });
    assert.deepEqual(questionAnswers.splitJoinedAnswer('A, Bx', ['A, B', 'C']), { selected: [], other: 'A, Bx' }, 'a label must end at a comma');
    assert.deepEqual(questionAnswers.splitJoinedAnswer('', ['A, B']), { selected: [], other: '' });
  }

  // ── New session + one turn ────────────────────────────────────────────────
  const adapter = new MinimaxAcpAdapter();
  const events: Event[] = [];
  let answer: (event: Event) => void = () => {};
  adapter.events.on('event', (event: Event) => {
    events.push(event);
    if (event.type === 'permission_request') answer(event);
  });

  {
    resetCalls();
    const session = await adapter.startSession({
      threadId: 't1',
      cwd: dir,
      prompt: '',
      model: M3,
      minimaxPermissionMode: 'default',
    } as never);
    assert.equal(session.providerSessionId, 'mvs_fresh');
    assert.equal(session.model, M3, 'start applies the requested model via set_config_option');

    const calls = readCalls();
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.configId ?? call.params.modeId ?? '']),
      [['initialize', ''], ['session/new', ''], ['session/set_config_option', 'model'], ['session/set_config_option', 'permissionMode']],
      'already in the default mode: no set_mode; M3 has no effort select'
    );
    assert.deepEqual(calls[0].params.clientCapabilities, { elicitation: { form: {} }, plan: {} }, 'no fs/terminal; forms for questions; plan markdown');
    const mcpServers = calls[1].params.mcpServers as Array<{ type: string; name: string }>;
    assert.equal(mcpServers[0]?.name, 'aegis-sessions', 'chat sessions get the Aegis session MCP server');
    assert.equal(mcpServers[0]?.type, 'http');
    assert.equal(
      events.filter((event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'available_commands_update').length,
      1,
      'startup command list is emitted once, after binding'
    );

    events.length = 0;
    resetCalls();
    answer = (event) => void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'go', model: M3, minimaxPermissionMode: 'default' } as never), 'turn with a permission request');

    assert.deepEqual(readCalls().map((call) => call.method), ['session/prompt', 'permission_response'], 'unchanged config is not re-sent');
    assert.deepEqual(readCalls()[1].params, { outcome: { outcome: 'selected', optionId: 'allow-once' } });

    const toolUses = contentBlocks(events, 'tool_use');
    const lastInput = (id: string) => toolUses.filter((block) => block.id === id).at(-1)?.input as Record<string, unknown>;
    assert.equal(toolUses.filter((block) => block.id === 'call_write').length, 2, 'empty input-streaming updates are dropped; the rawInput update re-emits once');
    assert.equal(toolUses.find((block) => block.id === 'call_write')?.name, 'Write');
    assert.equal(lastInput('call_write').file_path, '/w/hello.txt');
    assert.equal(lastInput('call_edit').old_string, 'hi');
    assert.equal(lastInput('call_edit').new_string, 'hello');
    assert.equal(toolUses.find((block) => block.id === 'call_bash')?.name, 'Bash');

    const results = contentBlocks(events, 'tool_result');
    assert.deepEqual(
      results.map((block) => [block.tool_use_id, block.content]),
      [['call_write', 'Successfully wrote 3 bytes'], ['call_edit', 'Applied 1 edit'], ['call_bash', 'removed']],
      'results come from rawOutput, not the content preview'
    );

    const permission = events.find((event) => event.type === 'permission_request');
    const permissionInput = permission?.input as { provider: string; title: string; question: string; toolName: string; toolCall: { rawInput: { command: string } } };
    assert.equal(permissionInput.provider, 'minimax');
    assert.equal(permissionInput.toolName, 'Bash', 'the perm_ request is self-contained: its name, not a tool-call lookup');
    assert.equal(permissionInput.question, 'rm -f hello.txt');
    assert.equal(permissionInput.title, 'Remove hello.txt');

    const messages = messagesOf(events);
    const context = messages.find((message) => message.subtype === 'token_usage') as { provider: string; usage: { totalTokens: number; contextWindow: number } } | undefined;
    assert.equal(context?.provider, 'minimax');
    assert.equal(context?.usage.totalTokens, 16863);
    assert.equal(context?.usage.contextWindow, 512000);

    const texts = contentBlocks(events, 'text').map((block) => block.text);
    assert.deepEqual(texts, ['Writing it.', ' Done.'], 'a tool call closes the narration block');
    assert.deepEqual(contentBlocks(events, 'thinking').map((block) => block.thinking), ['thinking']);

    const result = messages.find((message) => message.type === 'result') as
      | { subtype: string; total_cost_usd: number; costSource: string; usage: Record<string, number> }
      | undefined;
    assert.equal(result?.subtype, 'success');
    assert.deepEqual(
      result?.usage,
      { input_tokens: 16562, output_tokens: 107, cache_read_input_tokens: 16896, cache_creation_input_tokens: 10, total_tokens: 33575 },
      'per-turn usage sums every assistant message in messages.jsonl'
    );
    const flashUsd = (16428 * 0.15 + 256 * 0.015 + 65 * 0.6 + (134 + 10) * 0.15 + 16640 * 0.015 + 42 * 0.6) / 1e6;
    assert.ok(Math.abs((result?.total_cost_usd ?? 0) - flashUsd) < 1e-12, 'each request is priced at MiniMax-M3.1-Flash list rates');
    assert.equal(result?.costSource, 'estimated', "mcode's zero cost is replaced by an estimate");
  }

  // ── Live config: effort per model, a rejected model, plan mode ───────────
  {
    resetCalls();
    answer = (event) => void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'deny' });
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'go', model: FLASH, minimaxThinkingEffort: 'high', minimaxPermissionMode: 'auto' } as never),
      'turn after a model/effort/permission switch'
    );
    const calls = readCalls();
    assert.deepEqual(
      calls.slice(0, 4).map((call) => [call.method, call.params.configId, call.params.value]),
      [
        ['session/set_config_option', 'model', FLASH],
        ['session/set_config_option', 'thinkingEffort', 'high'],
        ['session/set_config_option', 'permissionMode', 'auto'],
        ['session/prompt', undefined, undefined],
      ],
      'effort applies after the model switch reset it'
    );
    assert.deepEqual(calls.find((call) => call.method === 'permission_response')?.params, { outcome: { outcome: 'selected', optionId: 'deny' } });

    resetCalls();
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 2; i += 1) {
        await withTimeout(
          adapter.sendTurn({ threadId: 't1', prompt: 'go', model: FLASH_PLAIN, minimaxThinkingEffort: 'high', minimaxPermissionMode: 'plan' } as never),
          'turn with a rejected model'
        );
      }
    } finally {
      console.warn = warn;
    }
    const rejected = readCalls().filter((call) => call.method === 'session/set_config_option' && call.params.configId === 'model');
    assert.equal(rejected.length, 1, 'an advertised-but-rejected model is tried once, not every turn');
    const modeCalls = readCalls().filter((call) => call.method === 'session/set_mode');
    assert.deepEqual(modeCalls.map((call) => call.params.modeId), ['plan'], 'plan is the session mode, set once');
    assert.equal(
      readCalls().filter((call) => call.method === 'session/set_config_option' && call.params.configId === 'permissionMode').length,
      0,
      'plan keeps the permission mode in force'
    );
  }

  // ── Steer ─────────────────────────────────────────────────────────────────
  {
    events.length = 0;
    resetCalls();
    const first = adapter.sendTurn({ threadId: 't1', prompt: 'SLOW start', minimaxPermissionMode: 'default' } as never);
    // Wait until the prompt is on the wire, then steer.
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'slow prompt dispatch'
    );
    const second = adapter.sendTurn({ threadId: 't1', prompt: 'also do this' } as never);
    await withTimeout(Promise.all([first, second]), 'steered turn');
    const steer = readCalls().find((call) => call.method === 'mcode/session/steer');
    assert.equal(steer?.params.text, 'also do this');
    assert.equal(steer?.params.sessionId, 'mvs_fresh');
    assert.equal(readCalls().filter((call) => call.method === 'session/prompt').length, 1, 'a steer is not a second prompt');
    assert.equal(messagesOf(events).filter((message) => message.type === 'result').length, 1, 'one result for the steered turn');
  }

  // ── Questions and plan review ─────────────────────────────────────────────
  {
    events.length = 0;
    resetCalls();
    answer = (event) => {
      assert.equal(event.toolName, 'AskUserQuestion');
      const input = event.input as { questions: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
      assert.deepEqual(input.questions.map((question) => question.question), ['Which language?', 'Which tools?'], 'the __other field is folded into its question');
      assert.deepEqual(input.questions[0].options, [{ label: 'TypeScript', description: 'Typed' }, { label: 'Python' }]);
      assert.equal(input.questions[1].multiSelect, true);
      void adapter.respondToRequest('t1', event.requestId as string, {
        behavior: 'allow',
        // The joined string disagrees on purpose: the structured answer must win.
        updatedInput: { answers: { 'Which language?': 'Rust, maybe', 'Which tools?': 'Lint' } },
        questionAnswers: { 'Which language?': { selected: [], other: 'Rust, maybe' }, 'Which tools?': { selected: ['Lint', 'Test'] } },
      });
    };
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'ASK me' } as never), 'question turn');
    assert.deepEqual(readCalls().find((call) => call.method === 'elicitation_response')?.params, {
      action: 'accept',
      content: { lang__other: 'Rust, maybe', tools: ['opt-a', 'opt-b'] },
    }, 'labels map back to option ids; free text goes to the __other field');

    resetCalls();
    events.length = 0;
    answer = (event) => {
      // The plan is in the transcript before the approval is asked.
      const plans = messagesOf(events).filter((message) => message.type === 'proposed_plan');
      assert.deepEqual(plans.map((plan) => plan.planMarkdown), ['# Plan\n\n1. Do it'], 'the plan card precedes its review');
      assert.equal(event.toolName, 'AskUserQuestion', 'the review is a question card under the plan');
      assert.equal((event.input as { questions: Array<{ header?: string }> }).questions[0].header, 'Review the plan', "mcode's own review message heads the card");
      void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: { answers: { 'Start implementing?': 'Approve' } } });
    };
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'PLAN it' } as never), 'plan review turn');
    assert.deepEqual(readCalls().find((call) => call.method === 'elicitation_response')?.params, { action: 'accept', content: { decision: 'approve' } });
  }

  // ── A send queued behind a turn keeps one result for the batch ───────────
  {
    events.length = 0;
    resetCalls();
    answer = (event) => void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    const image = path.join(dir, 'shot.png');
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    const first = adapter.sendTurn({ threadId: 't1', prompt: 'PAUSE first' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'paused prompt dispatch'
    );
    // Images cannot be steered: this one queues as the next turn.
    const second = adapter.sendTurn({ threadId: 't1', prompt: 'look', attachments: [{ kind: 'image', path: image, mimeType: 'image/png', name: 'shot.png' }] } as never);
    await withTimeout(Promise.all([first, second]), 'queued turn');
    assert.equal(readCalls().filter((call) => call.method === 'mcode/session/steer').length, 0);
    assert.equal(readCalls().filter((call) => call.method === 'session/prompt').length, 2);
    const results = messagesOf(events).filter((message) => message.type === 'result') as Array<{ usage: { input_tokens: number } }>;
    assert.equal(results.length, 1, 'no result while the queued turn still runs; one for the batch');
    assert.equal(results[0].usage.input_tokens, 100 + 16428 + 134, 'the batch result covers both turns');
  }

  // ── A final usage line written after the prompt response still counts ────
  {
    events.length = 0;
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'LATE write' } as never), 'late usage turn');
    const result = messagesOf(events).find((message) => message.type === 'result') as { usage: { input_tokens: number } } | undefined;
    assert.equal(result?.usage.input_tokens, 3000, 'the request logged after the response is included once');
  }

  // ── mcode exiting between turns: the next send reconnects and resumes ────
  {
    events.length = 0;
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'EXIT afterwards' } as never), 'turn before the exit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    resetCalls();
    answer = (event) => void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'go again' } as never), 'turn after mcode exited');
    const calls = readCalls();
    assert.deepEqual(calls.slice(0, 2).map((call) => call.method), ['initialize', 'session/resume'], 'a fresh process resumes the session');
    assert.equal(calls[1].params.sessionId, 'mvs_fresh');
    assert.ok(calls.some((call) => call.method === 'session/prompt'), 'the turn runs in the new process');
    const result = messagesOf(events).filter((message) => message.type === 'result').at(-1) as { subtype: string } | undefined;
    assert.equal(result?.subtype, 'success');
  }

  // ── …and when mcode no longer has the session, the replacement is announced ─
  {
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'EXIT again' } as never), 'turn before the second exit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    events.length = 0;
    resetCalls();
    process.env.FAKE_MCODE_FAIL_RESUME = '1';
    process.env.FAKE_MCODE_NEW_SESSION_ID = 'mvs_replacement';
    const warn = console.warn;
    console.warn = () => {};
    try {
      await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'go once more' } as never), 'turn after an unresumable exit');
    } finally {
      console.warn = warn;
      delete process.env.FAKE_MCODE_FAIL_RESUME;
      delete process.env.FAKE_MCODE_NEW_SESSION_ID;
    }
    assert.deepEqual(readCalls().slice(0, 3).map((call) => call.method), ['initialize', 'session/resume', 'session/new']);
    const inits = events.filter((event) => event.type === 'system_init');
    assert.deepEqual(inits.map((event) => event.sessionId), ['mvs_replacement'], 'the new id is announced so the thread stores it for the next cold start');
    assert.equal(readCalls().find((call) => call.method === 'session/prompt')?.params.sessionId, 'mvs_replacement');
    assert.equal(adapter.listSessions().find((session) => session.threadId === 't1')?.providerSessionId, 'mvs_replacement');
  }

  // ── A queued turn whose only usage line lands late still counts ──────────
  {
    events.length = 0;
    resetCalls();
    const image = path.join(dir, 'late.png');
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    const first = adapter.sendTurn({ threadId: 't1', prompt: 'PAUSE first' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'paused prompt dispatch'
    );
    const second = adapter.sendTurn({ threadId: 't1', prompt: 'LATEONLY look', attachments: [{ kind: 'image', path: image, mimeType: 'image/png', name: 'late.png' }] } as never);
    await withTimeout(Promise.all([first, second]), 'queued late-only turn');
    const results = messagesOf(events).filter((message) => message.type === 'result') as Array<{ usage: { input_tokens: number } }>;
    assert.equal(results.length, 1);
    assert.equal(results[0].usage.input_tokens, 100 + 2000, "each turn waits for its own final record, not a predecessor's");
  }

  // ── A steer still awaiting mcode when the turn ends holds the result ─────
  {
    events.length = 0;
    resetCalls();
    answer = (event) => void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    const first = adapter.sendTurn({ threadId: 't1', prompt: 'ENDSOON' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'endsoon prompt dispatch'
    );
    // mcode rejects this steer only after the turn has ended: it runs as the next turn.
    const steered = adapter.sendTurn({ threadId: 't1', prompt: 'more' } as never);
    await withTimeout(Promise.all([first, steered]), 'rejected steer turn');
    assert.equal(readCalls().filter((call) => call.method === 'mcode/session/steer').length, 1);
    assert.equal(readCalls().filter((call) => call.method === 'session/prompt').length, 2, 'the rejected steer ran as a turn');
    const results = messagesOf(events).filter((message) => message.type === 'result') as Array<{ usage: { input_tokens: number } }>;
    assert.equal(results.length, 1, 'no result while the steer could still become a turn');
    assert.equal(results[0].usage.input_tokens, 50 + 16428 + 134);
  }

  await adapter.stopAll();

  // ── Stopping a batch still reports the usage it already incurred ──────────
  {
    resetCalls();
    const stopping = new MinimaxAcpAdapter();
    const stoppingEvents: Event[] = [];
    stopping.events.on('event', (event: Event) => {
      stoppingEvents.push(event);
      if (event.type === 'permission_request') void stopping.respondToRequest('t7', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    });
    await stopping.startSession({ threadId: 't7', cwd: dir, prompt: '' } as never);
    const image = path.join(dir, 'hang.png');
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    const first = stopping.sendTurn({ threadId: 't7', prompt: 'PAUSE first' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'paused prompt dispatch'
    );
    const second = stopping.sendTurn({ threadId: 't7', prompt: 'HANG here', attachments: [{ kind: 'image', path: image, mimeType: 'image/png', name: 'hang.png' }] } as never);
    await withTimeout(
      (async () => {
        while (readCalls().filter((call) => call.method === 'session/prompt').length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'hanging turn dispatch'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stopping.stopSession('t7');
    await withTimeout(Promise.all([first, second]), 'stopped batch settles');
    assert.equal(messagesOf(stoppingEvents).filter((message) => message.type === 'result').length, 0, 'a stopped batch emits no turn result');
    // The runner's forwarder is gone by then: the usage goes out process-wide, at once.
    const unreported = stoppingEvents.filter((event) => event.type === 'usage_unreported') as Array<{
      threadId: string;
      message: { type: string; costSource: string; usage: { input_tokens: number } };
    }>;
    assert.equal(unreported.length, 1, 'reported once, at the stop');
    assert.equal(unreported[0].threadId, 't7');
    assert.equal(unreported[0].message.type, 'usage_record', 'an accounting record, not a turn result');
    assert.equal(unreported[0].message.usage.input_tokens, 100 + 70, "the completed turn and the stopped turn's logged request");
    assert.equal(unreported[0].message.costSource, 'estimated');

    // Nothing of it rides on later results.
    await stopping.startSession({ threadId: 't7', cwd: dir, prompt: '', resumeSessionId: 'mvs_fresh' } as never);
    stoppingEvents.length = 0;
    await withTimeout(stopping.sendTurn({ threadId: 't7', prompt: 'go on' } as never), 'turn after the stop');
    const result = messagesOf(stoppingEvents).find((message) => message.type === 'result') as { usage: { input_tokens: number } } | undefined;
    assert.equal(result?.usage.input_tokens, 16428 + 134, 'not counted again');
    assert.equal(stoppingEvents.filter((event) => event.type === 'usage_unreported').length, 0);
    await stopping.stopAll();
  }

  // ── Stopping a turn whose usage is still being read, then resuming at once ─
  {
    resetCalls();
    const finalizing = new MinimaxAcpAdapter();
    const finalizingEvents: Event[] = [];
    finalizing.events.on('event', (event: Event) => {
      finalizingEvents.push(event);
      if (event.type === 'permission_request') void finalizing.respondToRequest('t9', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    });
    await finalizing.startSession({ threadId: 't9', cwd: dir, prompt: '' } as never);
    // LATE answers at once but logs its final request only 300ms later:
    // the turn has ended and is polling for that record when the stop lands.
    const late = finalizing.sendTurn({ threadId: 't9', prompt: 'LATE write' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'late prompt dispatch'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await finalizing.stopSession('t9');
    let unreported = finalizingEvents.filter((event) => event.type === 'usage_unreported') as Array<{ message: { usage: { input_tokens: number } } }>;
    assert.equal(unreported.length, 1, 'the stop accounts for the finalizing turn at once');
    assert.equal(unreported[0].message.usage.input_tokens, 1000, 'what that turn had logged when stopped');
    // The same session resumes right away and logs its own usage while the
    // stopped turn's read would still have been polling.
    await finalizing.startSession({ threadId: 't9', cwd: dir, prompt: '', resumeSessionId: 'mvs_fresh' } as never);
    await withTimeout(late, 'stopped turn settles');
    await withTimeout(finalizing.sendTurn({ threadId: 't9', prompt: 'go on' } as never), 'turn after resuming');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    unreported = finalizingEvents.filter((event) => event.type === 'usage_unreported') as typeof unreported;
    assert.equal(unreported.length, 1, "the stopped turn's read reports nothing more, and never the successor's records");
    const results = messagesOf(finalizingEvents).filter((message) => message.type === 'result') as Array<{ usage: { input_tokens: number } }>;
    assert.deepEqual(results.map((result) => result.usage.input_tokens), [16428 + 134], 'the successor counts only its own usage');
    await finalizing.stopAll();
  }

  // ── An error in a batch: one error result, usage of every turn ────────────
  {
    resetCalls();
    const erring = new MinimaxAcpAdapter();
    const erringEvents: Event[] = [];
    erring.events.on('event', (event: Event) => {
      erringEvents.push(event);
      if (event.type === 'permission_request') void erring.respondToRequest('t8', event.requestId as string, { behavior: 'allow', updatedInput: {} });
    });
    await erring.startSession({ threadId: 't8', cwd: dir, prompt: '' } as never);
    const image = path.join(dir, 'err.png');
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
    const first = erring.sendTurn({ threadId: 't8', prompt: 'FAILSLOW first' } as never);
    await withTimeout(
      (async () => {
        while (!readCalls().some((call) => call.method === 'session/prompt')) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      'failing prompt dispatch'
    );
    const second = erring.sendTurn({ threadId: 't8', prompt: 'look', attachments: [{ kind: 'image', path: image, mimeType: 'image/png', name: 'err.png' }] } as never);
    await withTimeout(Promise.all([first, second]), 'batch with an error');
    const results = messagesOf(erringEvents).filter((message) => message.type === 'result') as Array<{ subtype: string; usage: { input_tokens: number } }>;
    assert.equal(results.length, 1, 'one result for the batch');
    assert.equal(results[0].subtype, 'error', 'the earlier error is kept');
    assert.equal(results[0].usage.input_tokens, 40 + 16428 + 134);
    assert.equal(erringEvents.filter((event) => event.type === 'error').length, 1, 'the error is raised once, with the result');
    await erring.stopAll();
  }

  // ── A turn that fails before its prompt goes out counts no usage ──────────
  {
    resetCalls();
    const failing = new MinimaxAcpAdapter();
    const failingEvents: Event[] = [];
    failing.events.on('event', (event: Event) => failingEvents.push(event));
    await failing.startSession({ threadId: 't5', cwd: dir, prompt: '' } as never);
    await withTimeout(failing.sendTurn({ threadId: 't5', prompt: 'EXIT afterwards' } as never), 'turn before the exit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    failingEvents.length = 0;
    process.env.FAKE_MCODE_FAIL_INIT = '1';
    const warn = console.warn;
    console.warn = () => {};
    try {
      await withTimeout(failing.sendTurn({ threadId: 't5', prompt: 'go' } as never), 'turn whose reconnect fails');
    } finally {
      console.warn = warn;
      delete process.env.FAKE_MCODE_FAIL_INIT;
    }
    const result = messagesOf(failingEvents).find((message) => message.type === 'result') as
      | { subtype: string; total_cost_usd: number; usage: { input_tokens: number; total_tokens: number } }
      | undefined;
    assert.equal(result?.subtype, 'error');
    assert.equal(result?.usage.total_tokens, 0, "the session's earlier history is not billed to the failed turn");
    assert.equal(result?.total_cost_usd, 0);
    await failing.stopAll();
  }

  // ── Stopping while a reconnect is still starting kills it ─────────────────
  {
    resetCalls();
    const reconnecting = new MinimaxAcpAdapter();
    await reconnecting.startSession({ threadId: 't6', cwd: dir, prompt: '' } as never);
    await withTimeout(reconnecting.sendTurn({ threadId: 't6', prompt: 'EXIT afterwards' } as never), 'turn before the exit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    resetCalls();
    process.env.FAKE_MCODE_SLOW_INIT = '1';
    try {
      const pending = reconnecting.sendTurn({ threadId: 't6', prompt: 'go' } as never);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await reconnecting.stopSession('t6');
      await withTimeout(pending, 'send whose reconnect was stopped', 1000);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.deepEqual(readCalls().map((call) => call.method), ['initialize'], 'the reconnecting process was killed before it resumed');
      assert.equal(reconnecting.hasSession('t6'), false);
    } finally {
      delete process.env.FAKE_MCODE_SLOW_INIT;
    }
  }

  // ── The shared ACP client fails requests to an exited process at once ─────
  {
    const { AcpJsonRpcClient } = await import('../../src/electron/libs/provider/acp-json-rpc-client');
    const { spawn } = await import('node:child_process');
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new AcpJsonRpcClient(proc, () => {}, () => {}, () => {});
    await new Promise((resolve) => proc.once('exit', resolve));
    await assert.rejects(withTimeout(client.request('initialize', {}), 'request to an exited process', 1000), /exited/);
  }

  // ── Stopping a session while it is still starting ─────────────────────────
  {
    resetCalls();
    process.env.FAKE_MCODE_SLOW_INIT = '1';
    try {
      const starting = new MinimaxAcpAdapter();
      const start = starting.startSession({ threadId: 't4', cwd: dir, prompt: 'should never run' } as never);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await starting.stopSession('t4');
      await assert.rejects(start, /cancelled|exited/, 'a stopped start fails instead of registering');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(starting.hasSession('t4'), false);
      assert.deepEqual(readCalls().map((call) => call.method), ['initialize'], 'no session is created and no prompt sent');
    } finally {
      delete process.env.FAKE_MCODE_SLOW_INIT;
    }
  }

  // ── Resume (no replay) and a resume that fails ────────────────────────────
  {
    resetCalls();
    events.length = 0;
    const resumed = new MinimaxAcpAdapter();
    const resumedEvents: Event[] = [];
    resumed.events.on('event', (event: Event) => resumedEvents.push(event));
    const session = await resumed.startSession({ threadId: 't2', cwd: dir, prompt: '', resumeSessionId: 'mvs_old' } as never);
    assert.equal(session.providerSessionId, 'mvs_old');
    assert.deepEqual(readCalls().map((call) => call.method), ['initialize', 'session/resume']);
    const usage = messagesOf(resumedEvents).find((message) => message.subtype === 'token_usage') as { usage: { totalTokens: number } } | undefined;
    assert.equal(usage?.usage.totalTokens, 4321, 'context usage reported before binding is applied once bound');
    await resumed.stopAll();

    resetCalls();
    process.env.FAKE_MCODE_FAIL_RESUME = '1';
    const warn = console.warn;
    console.warn = () => {};
    try {
      const fallback = new MinimaxAcpAdapter();
      const fresh = await fallback.startSession({ threadId: 't3', cwd: dir, prompt: '', resumeSessionId: 'mvs_gone' } as never);
      assert.equal(fresh.providerSessionId, 'mvs_fresh', 'a session mcode no longer has continues in a fresh one');
      await fallback.stopAll();
    } finally {
      console.warn = warn;
      delete process.env.FAKE_MCODE_FAIL_RESUME;
    }
  }

  // ── Model catalog probe ───────────────────────────────────────────────────
  {
    const catalog = await cli.getMinimaxModelConfig();
    assert.deepEqual(catalog.options, [FLASH, M3], 'advertised values mcode rejects are left out of the picker');
    assert.equal(catalog.defaultModel, FLASH);
    const efforts = await cli.getMinimaxThinkingEfforts(FLASH);
    assert.deepEqual(efforts.levels.map((level) => level.id), ['default', 'low', 'high', 'max']);
    assert.deepEqual((await cli.getMinimaxThinkingEfforts(M3)).levels, [], 'M3 has no effort control');
    assert.equal((await cli.getMinimaxThinkingEfforts(M3)).failed, undefined);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await cli.getMinimaxThinkingEfforts('m:minimax:Unknown:v:')).failed, true, 'a failed read is marked, not reported as "no efforts"');
    } finally {
      console.warn = warn;
    }
  }

  console.log('minimax-acp-adapter: ok');
}

main()
  .then(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });

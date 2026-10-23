import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Drives DevinAcpAdapter end to end against a scripted stand-in for
 * `devin acp` that reproduces the wire behavior observed on devin 3000.6.14:
 * - reverse requests carry UUID string ids (a numeric-only client misreads
 *   session/request_permission as a notification and the turn hangs);
 * - session/load replays the conversation as session/update notifications
 *   before responding;
 * - exec output streams as cumulative snapshots and the final `completed`
 *   update carries no content.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'devin-acp-test-'));
const logPath = path.join(dir, 'calls.jsonl');
const pidsPath = path.join(dir, 'pids');
const failSwitchPath = path.join(dir, 'fail-next-model-switch');
const bareSwitchPath = path.join(dir, 'bare-next-model-switch');
const fakeAgentPath = path.join(dir, 'devin');

writeFileSync(
  fakeAgentPath,
  `#!/usr/bin/env node
const { appendFileSync, existsSync, unlinkSync } = require('node:fs');
const LOG = ${JSON.stringify(logPath)};
const FAIL_SWITCH = ${JSON.stringify(failSwitchPath)};
const BARE_SWITCH = ${JSON.stringify(bareSwitchPath)};
const FAIL_LOAD = process.env.FAKE_DEVIN_FAIL_LOAD === '1';
const SLOW_INIT = process.env.FAKE_DEVIN_SLOW_INIT === '1';
const HANG_INIT = process.env.FAKE_DEVIN_HANG_INIT === '1';
appendFileSync(${JSON.stringify(pidsPath)}, process.pid + '\\n');
let buffer = '';
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\\n');
// Per-model thinking levels; a model switch resets the level to the model's
// own default and swe-2-medium has no thinking select at all (as observed).
const LEVELS = { 'swe-2-high': ['high', ['medium', 'high', 'max']], 'claude-opus-5-5-high': ['medium', ['low', 'medium', 'high', 'xhigh', 'max']] };
const state = { model: 'swe-2-high', level: 'high' };
// A SLOW turn stays open until a prompt arrives mid-turn; Devin folds that
// prompt into the turn and resolves every prompt of it with one result.
let openTurn = null;
const config = () => [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'accept-edits', options: [] },
  { id: 'model', category: 'model', type: 'select', currentValue: state.model, options: ['swe-2-high', 'swe-2-medium', 'claude-opus-5-5-high'].map((value) => ({ value, name: value })) },
  ...(LEVELS[state.model] ? [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: state.level, options: LEVELS[state.model][1].map((value) => ({ value, name: value.toUpperCase() })) }] : []),
];
const commands = (sessionId) => update(sessionId, {
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'plan', description: 'Switch to Plan mode', input: { hint: '[prompt]' } }, { name: 'compact', description: 'Compact' }],
});
const ask = (method, params) => new Promise((resolve) => {
  const id = 'b6f1c0de-0000-4000-8000-' + String(pending.size + 1).padStart(12, '0');
  pending.set(id, resolve);
  send({ id, method, params });
});

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
    if (HANG_INIT) return;
    if (SLOW_INIT) await new Promise((resolve) => setTimeout(resolve, 1500));
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (method === 'session/new') {
    update('fresh-session', { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' });
    commands('fresh-session');
    send({ id, result: { sessionId: 'fresh-session', modes: { currentModeId: 'accept-edits', availableModes: [] }, configOptions: config() } });
  } else if (method === 'session/load') {
    if (FAIL_LOAD) {
      send({ id, error: { code: -32002, message: 'Session not found' } });
      return;
    }
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED ANSWER' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'Ran ls', kind: 'execute', rawInput: { command: 'ls' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    update(sid, { sessionUpdate: 'usage_update', used: 1234, size: 200000, _meta: {} });
    commands(sid);
    send({ id, result: { modes: { currentModeId: 'plan', availableModes: [] }, configOptions: config() } });
  } else if (method === 'session/set_mode') {
    update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    send({ id, result: {} });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model' && existsSync(FAIL_SWITCH)) {
      // One transient failure (the marker is consumed), then switches work.
      unlinkSync(FAIL_SWITCH);
      send({ id, error: { code: -32603, message: 'Internal error', data: 'transient' } });
      return;
    }
    if (params.configId === 'model') {
      state.model = params.value;
      state.level = LEVELS[params.value]?.[0];
    } else if (params.configId === 'thought_level') {
      if (!LEVELS[state.model]?.[1].includes(params.value)) {
        send({ id, error: { code: -32602, message: 'Invalid params', data: 'bad thought_level' } });
        return;
      }
      state.level = params.value;
    }
    if (params.configId === 'model' && existsSync(BARE_SWITCH)) {
      // One switch whose reply carries no configOptions (the marker is consumed).
      unlinkSync(BARE_SWITCH);
      send({ id, result: {} });
      return;
    }
    send({ id, result: { configOptions: config() } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('BUMP')) {
    // Devin changes its own level mid-turn and reports it.
    state.level = 'xhigh';
    update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: config() });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
  } else if (method === 'session/prompt' && openTurn) {
    openTurn.ids.push(id);
    openTurn.release();
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('SLOW')) {
    openTurn = { ids: [id] };
    await new Promise((resolve) => { openTurn.release = resolve; });
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Folded.' } });
    const result = { stopReason: 'end_turn', usage: { totalTokens: 10, inputTokens: 9, outputTokens: 1 }, _meta: { 'cognition.ai/userMessageId': 'user-message-2' } };
    for (const promptId of openTurn.ids) send({ id: promptId, result });
    openTurn = null;
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('ASK')) {
    const reply = await ask('elicitation/create', {
      mode: 'form',
      sessionId: params.sessionId,
      message: 'Which fruits do you like?',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: { type: 'array', title: 'Fruits', description: 'Which fruits do you like?', minItems: 1, items: { anyOf: [{ const: 'Apple', title: 'Crisp' }, { const: 'Banana', title: 'Soft' }] } },
          q1: { type: 'string', title: 'Color', description: 'Favorite color?', oneOf: [{ const: 'Red', title: 'Warm' }, { const: 'Blue', title: 'Cool' }] },
        },
        required: ['q0', 'q1'],
      },
      _meta: { 'cognition.ai/allowOther': true },
    });
    log({ method: 'elicitation_response', params: reply });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
  } else if (method === 'session/prompt') {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'session_info_update', title: 'functions.read_file:0{}' });
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running it.' } });
    const exec = 'functions.exec:0#abc';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: exec, title: 'Ran for', kind: 'execute', rawInput: { command: 'for i in 1 2; do echo line$i; done' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'line1' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'line1\\nline2' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'completed' });
    const curl = 'functions.exec:1#def';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: curl, title: 'Ran curl', kind: 'execute', rawInput: { command: 'curl -sI https://example.com' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    const decision = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: curl, _meta: { 'cognition.ai/editableCommand': 'curl -sI https://example.com' } },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow curl (session)', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    log({ method: 'permission_response', params: decision });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: curl, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'HTTP/2 200' } }] });
    update(sid, { sessionUpdate: 'usage_update', used: 25000, size: 262000, _meta: { 'cognition.ai/inputTokens': 24900, 'cognition.ai/outputTokens': 100, 'cognition.ai/cachedReadTokens': 24000 } });
    send({ method: '_cognition.ai/agent_stopped', params: { cause: 'complete' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 25000, inputTokens: 24900, outputTokens: 100, cachedReadTokens: 24000 } } });
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
process.env.DEVIN_CLI_PATH = fakeAgentPath;

type Event = { type: string; [key: string]: unknown };

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

// A misrouted reverse request leaves the turn waiting forever; fail loudly instead.
function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readPids(): number[] {
  try {
    return readFileSync(pidsPath, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const { DevinAcpAdapter } = await import('../../src/electron/libs/provider/devin-acp-adapter');

  // ── New session + one turn ────────────────────────────────────────────────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });

    const session = await adapter.startSession({
      threadId: 't1',
      cwd: dir,
      prompt: '',
      model: 'claude-opus-5-5-high',
      devinPermissionMode: 'smart',
    } as never);
    assert.equal(session.providerSessionId, 'fresh-session');
    assert.equal(session.model, 'claude-opus-5-5-high', 'start applies the requested model via set_config_option');

    const startCalls = readCalls();
    assert.deepEqual(
      startCalls.map((call) => call.method),
      ['initialize', 'session/new', 'session/set_config_option', 'session/set_mode']
    );
    assert.deepEqual(
      startCalls[0].params.clientCapabilities,
      { elicitation: { form: {} } },
      'no fs/terminal (Devin runs its own tools); form elicitation for its questions'
    );
    assert.equal(startCalls[3].params.modeId, 'smart');
    const mcpServers = startCalls[1].params.mcpServers as Array<{ type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
    assert.equal(mcpServers.length, 1, 'chat sessions get the Aegis session MCP server (read_session)');
    assert.equal(mcpServers[0].type, 'http');
    assert.equal(mcpServers[0].name, 'aegis-sessions');
    assert.match(mcpServers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(
      mcpServers[0].headers.some((header) => header.name === 'Authorization' && header.value.startsWith('Bearer ')),
      'the session MCP endpoint is called with its bearer token'
    );

    const init = events.find((event) => event.type === 'system_init');
    assert.equal(init?.sessionId, 'fresh-session');
    const commandMessages = events.filter(
      (event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'available_commands_update'
    );
    assert.equal(commandMessages.length, 1, 'startup command list is emitted once, after binding');

    events.length = 0;
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'go', model: 'claude-opus-5-5-high', devinPermissionMode: 'smart' } as never),
      'turn with a permission request'
    );

    const calls = readCalls();
    assert.deepEqual(
      calls.map((call) => call.method),
      ['session/prompt', 'permission_response'],
      'unchanged model/mode must not be re-sent'
    );
    assert.deepEqual(calls[1].params, { outcome: { outcome: 'selected', optionId: 'allow_once' } });

    const messages = events
      .filter((event) => event.type === 'message')
      .map((event) => event.message as Record<string, unknown>);
    const toolUses = messages.flatMap((message) =>
      ((message.message as { content?: Array<Record<string, unknown>> })?.content || []).filter((block) => block.type === 'tool_use')
    );
    assert.ok(toolUses.length >= 2);
    assert.ok(toolUses.every((block) => block.name === 'Bash'), 'exec maps to the Bash card');
    assert.equal((toolUses[0].input as { command: string }).command, 'for i in 1 2; do echo line$i; done');

    const deltas = events.filter((event) => event.type === 'tool_output_delta').map((event) => event.delta);
    assert.deepEqual(deltas, ['line1', '\nline2'], 'cumulative snapshots become incremental deltas');

    const results = messages.flatMap((message) =>
      ((message.message as { content?: Array<Record<string, unknown>> })?.content || []).filter((block) => block.type === 'tool_result')
    );
    assert.deepEqual(
      results.map((block) => [block.tool_use_id, block.content, block.is_error]),
      [
        ['functions.exec:0#abc', 'line1\nline2', false],
        ['functions.exec:1#def', 'HTTP/2 200', false],
      ],
      'an empty completed update reports the last output snapshot'
    );

    const permission = events.find((event) => event.type === 'permission_request');
    assert.ok(permission, 'UUID-id permission requests must reach the UI');
    const permissionInput = permission.input as { provider: string; title: string; question: string; toolName: string };
    assert.equal(permissionInput.provider, 'devin');
    assert.equal(permissionInput.title, 'Ran curl', 'title comes from the preceding tool_call');
    assert.equal(permissionInput.question, 'curl -sI https://example.com');
    assert.equal(permissionInput.toolName, 'Bash');

    const usage = messages.find((message) => message.subtype === 'token_usage') as
      | { provider: string; usage: { totalTokens: number; contextWindow: number } }
      | undefined;
    assert.equal(usage?.provider, 'devin');
    assert.equal(usage?.usage.totalTokens, 25000);
    assert.equal(usage?.usage.contextWindow, 262000);

    const assistantTexts = messages
      .filter((message) => message.type === 'assistant')
      .flatMap((message) => ((message.message as { content?: Array<Record<string, unknown>> }).content || []))
      .filter((block) => block.type === 'text')
      .map((block) => block.text);
    assert.deepEqual(assistantTexts, ['Running it.', ' Done.'], 'a tool call closes the narration block');

    const result = messages.find((message) => message.type === 'result') as
      | { subtype: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } }
      | undefined;
    assert.equal(result?.subtype, 'success');
    assert.equal(result?.usage.input_tokens, 24900);
    assert.equal(result?.usage.cache_read_input_tokens, 24000);

    // Model and mode switches apply live, before the next prompt.
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'again', model: 'swe-2-medium', devinPermissionMode: 'plan' } as never),
      'turn after a live model/mode switch'
    );
    assert.deepEqual(
      readCalls().slice(0, 3).map((call) => call.method),
      ['session/set_config_option', 'session/set_mode', 'session/prompt']
    );

    // A model the session does not offer is skipped once, not retried per turn.
    resetCalls();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        await withTimeout(
          adapter.sendTurn({ threadId: 't1', prompt: 'x', model: 'swe-9-ultra', devinPermissionMode: 'plan' } as never),
          'turn with an unoffered model'
        );
      }
    } finally {
      console.warn = warn;
    }
    assert.ok(!readCalls().some((call) => call.method === 'session/set_config_option'));
    assert.equal(warnings.filter((line) => line.includes('swe-9-ultra')).length, 1);

    await adapter.stopAll();
  }

  // ── Steer: a prompt sent mid-turn folds into the running turn ───────────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t6', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });
    await adapter.startSession({ threadId: 't6', cwd: dir, prompt: '' } as never);

    events.length = 0;
    resetCalls();
    // The steer is sent while the primary is still switching models: it must
    // wait for the primary's prompt and must not change config mid-turn.
    const primary = adapter.sendTurn({ threadId: 't6', prompt: 'SLOW task', model: 'swe-2-medium' } as never);
    const steer = adapter.sendTurn({
      threadId: 't6',
      prompt: 'also this',
      model: 'claude-opus-5-5-high',
      devinPermissionMode: 'plan',
    } as never);
    await withTimeout(Promise.all([primary, steer]), 'steered turn');

    assert.deepEqual(
      readCalls().map((call) => [call.method, (call.params.prompt as Array<{ text?: string }> | undefined)?.[0]?.text]),
      [
        ['session/set_config_option', undefined],
        ['session/prompt', 'SLOW task'],
        ['session/prompt', 'also this'],
      ],
      'the steer follows the primary prompt and leaves config for the next turn'
    );
    const statuses = events.filter((event) => event.type === 'status_change').map((event) => event.status);
    assert.deepEqual(statuses, ['running', 'completed'], 'one running stretch for the primary and its steer');
    const results = events
      .filter((event) => event.type === 'message' && (event.message as { type?: string }).type === 'result')
      .map((event) => event.message as { subtype: string; usage: { input_tokens: number } });
    assert.equal(results.length, 1, 'the folded turn ends with a single result');
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].usage.input_tokens, 9, 'prompts sharing a userMessageId are counted once');

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't6', prompt: 'next', model: 'claude-opus-5-5-high', devinPermissionMode: 'plan' } as never),
      'turn after a steer'
    );
    assert.deepEqual(
      readCalls().slice(0, 3).map((call) => call.method),
      ['session/set_config_option', 'session/set_mode', 'session/prompt'],
      "the steer's model and mode apply from the next turn"
    );
    await adapter.stopAll();
  }

  // ── Steer into the session's first turn (the one startSession sends) ─────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    let completed!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'status_change' && event.status === 'completed') completed();
    });
    // The agent loop chains later sends off startSession: it must return once
    // the session is ready, not after the first turn (which here only ends
    // when the steer arrives).
    await withTimeout(
      adapter.startSession({ threadId: 't7', cwd: dir, prompt: 'SLOW first' } as never),
      'startSession with a first prompt',
      3_000
    );
    await withTimeout(adapter.sendTurn({ threadId: 't7', prompt: 'also this' } as never), 'steer into the first turn');
    await withTimeout(turnCompleted, 'first turn completion');
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/prompt').map((call) => (call.params.prompt as Array<{ text: string }>)[0].text),
      ['SLOW first', 'also this']
    );
    const results = events.filter((event) => event.type === 'message' && (event.message as { type?: string }).type === 'result');
    assert.equal(results.length, 1, 'the steer folds into the first turn: one result');
    await adapter.stopAll();
  }

  // ── Thinking level: applied after the model, re-applied after a switch ───
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    type LevelResult = { model?: string; modelLabel?: string; thoughtLevel?: string; thoughtLevelLabel?: string };
    const levelResults: LevelResult[] = [];
    adapter.events.on('event', (event: Event) => {
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t4', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
      const message = event.type === 'message' ? (event.message as LevelResult & { type?: string }) : undefined;
      if (message?.type === 'result') {
        levelResults.push({ model: message.model, modelLabel: message.modelLabel, thoughtLevel: message.thoughtLevel, thoughtLevelLabel: message.thoughtLevelLabel });
      }
    });
    const configCalls = () =>
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => [call.params.configId, call.params.value]);
    await adapter.startSession({
      threadId: 't4',
      cwd: dir,
      prompt: '',
      model: 'claude-opus-5-5-high',
      devinThoughtLevel: 'max',
    } as never);
    const start = readCalls().filter((call) => call.method === 'session/set_config_option');
    assert.deepEqual(
      start.map((call) => [call.params.configId, call.params.value]),
      [['model', 'claude-opus-5-5-high'], ['thought_level', 'max']],
      'the level is applied after the model (a switch resets it)'
    );

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'claude-opus-5-5-high', devinThoughtLevel: 'max' } as never),
      'turn with an unchanged level'
    );
    assert.ok(!readCalls().some((call) => call.method === 'session/set_config_option'), 'unchanged level is not re-sent');
    assert.deepEqual(
      levelResults.at(-1),
      { model: 'claude-opus-5-5-high', modelLabel: 'claude-opus-5-5-high', thoughtLevel: 'max', thoughtLevelLabel: 'MAX' },
      'the result records the level the turn ran at, with catalog names'
    );

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-high', devinThoughtLevel: 'max' } as never),
      'turn after a model switch'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => [call.params.configId, call.params.value]),
      [['model', 'swe-2-high'], ['thought_level', 'max']],
      'the switch reset the level to high, so max is re-applied'
    );

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-medium', devinThoughtLevel: 'max' } as never),
      'turn on a model without thinking control'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => call.params.configId),
      ['model'],
      'a model without a thought_level select gets no level'
    );
    assert.deepEqual(
      levelResults.at(-1),
      { model: 'swe-2-medium', modelLabel: 'swe-2-medium', thoughtLevel: undefined, thoughtLevelLabel: undefined },
      'no level is recorded for a model without one'
    );

    // Devin changes its own level mid-turn (config_option_update): the result
    // records the level it ran at; the next turn re-applies the composer's.
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'BUMP', model: 'claude-opus-5-5-high', devinThoughtLevel: 'max' } as never),
      'turn where Devin changes its level'
    );
    assert.equal(levelResults.at(-1)?.thoughtLevel, 'xhigh', 'a level Devin reports mid-turn is recorded');
    assert.equal(levelResults.at(-1)?.thoughtLevelLabel, 'XHIGH');
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'claude-opus-5-5-high', devinThoughtLevel: 'max' } as never), 'turn after Devin changed the level');
    assert.deepEqual(configCalls(), [['thought_level', 'max']], "the composer's level is re-applied");
    assert.equal(levelResults.at(-1)?.thoughtLevel, 'max');

    // A model switch whose reply carries no options: the level is unknown, so
    // the composer's is applied again rather than skipped or guessed.
    writeFileSync(bareSwitchPath, '');
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-high', devinThoughtLevel: 'max' } as never), 'switch without options');
    assert.deepEqual(configCalls(), [['model', 'swe-2-high'], ['thought_level', 'max']], 'the level is re-applied after a bare switch');
    assert.equal(levelResults.at(-1)?.thoughtLevel, 'max', 'and recorded once Devin confirms it');

    // A steer that changes the level: the folded turn keeps the level it ran
    // at; the new one applies from the next turn.
    resetCalls();
    const slow = adapter.sendTurn({ threadId: 't4', prompt: 'SLOW level', model: 'swe-2-high', devinThoughtLevel: 'max' } as never);
    for (let i = 0; i < 100 && !readCalls().some((call) => call.method === 'session/prompt'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await withTimeout(adapter.sendTurn({ threadId: 't4', prompt: 'steer', model: 'swe-2-high', devinThoughtLevel: 'high' } as never), 'steer with a new level');
    await withTimeout(slow, 'slow turn');
    assert.equal(levelResults.at(-1)?.thoughtLevel, 'max', 'the folded turn ran at max');
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-high' } as never), 'turn after the steer');
    assert.deepEqual(configCalls(), [['thought_level', 'high']], "the steer's level applies from the next turn");
    assert.equal(levelResults.at(-1)?.thoughtLevel, 'high');
    await adapter.stopAll();
  }

  // ── Questions: elicitation/create ↔ AskUserQuestion card ─────────────────
  {
    const answerWith = async (decision: Record<string, unknown>) => {
      resetCalls();
      const adapter = new DevinAcpAdapter();
      let card: Event | undefined;
      adapter.events.on('event', (event: Event) => {
        if (event.type === 'permission_request') {
          card = event;
          void adapter.respondToRequest('t5', event.requestId as string, decision as never);
        }
      });
      await adapter.startSession({ threadId: 't5', cwd: dir, prompt: '' } as never);
      await withTimeout(adapter.sendTurn({ threadId: 't5', prompt: 'ASK me' } as never), 'turn with a question');
      await adapter.stopAll();
      return { card, reply: readCalls().find((call) => call.method === 'elicitation_response')?.params };
    };

    const accepted = await answerWith({
      behavior: 'allow',
      updatedInput: { answers: { 'Which fruits do you like?': 'Apple,Durian, ripe', 'Favorite color?': 'Blue' } },
    });
    assert.equal(accepted.card?.toolName, 'AskUserQuestion');
    assert.deepEqual(accepted.card?.input, {
      questions: [
        { question: 'Which fruits do you like?', header: 'Fruits', options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana', description: 'Soft' }], multiSelect: true },
        { question: 'Favorite color?', header: 'Color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] },
      ],
    });
    assert.deepEqual(
      accepted.reply,
      { action: 'accept', content: { q0: ['Apple', 'Durian, ripe'], q1: 'Blue' } },
      'choices map to their consts; "Other" text stays whole, commas included'
    );

    const declined = await answerWith({ behavior: 'deny', message: 'User cancelled the request' });
    assert.deepEqual(declined.reply, { action: 'decline' });

    const { parseDevinElicitation, buildDevinElicitationContent } = await import('../../src/electron/libs/provider/devin-acp-adapter');
    assert.equal(parseDevinElicitation({ mode: 'url', url: 'https://x' }), null, 'only form mode has a UI');
    const mixed = parseDevinElicitation({
      message: 'Setup',
      requestedSchema: { properties: { a: { type: 'string', title: 'Name' }, b: { type: 'boolean', title: 'Proceed?' }, c: { type: 'integer', description: 'Count?' } } },
    })!;
    assert.deepEqual(
      buildDevinElicitationContent(mixed, { Name: 'Ada, Lovelace', 'Proceed?': 'Yes', 'Count?': '3' }),
      { a: 'Ada, Lovelace', b: true, c: 3 },
      'free text is kept whole; booleans and numbers are typed'
    );

    // The card's structured answers keep comma-containing labels and "Other"
    // text apart, so they map to exact option consts.
    const commas = parseDevinElicitation({
      requestedSchema: {
        properties: {
          q0: { type: 'array', description: 'Pick cities', items: { anyOf: [{ const: 'Paris, France' }, { const: 'Austin, Texas' }, { const: 'Lima' }] } },
          q1: { type: 'string', description: 'One city', oneOf: [{ const: 'Paris, France' }, { const: 'Lima' }] },
        },
      },
      _meta: { 'cognition.ai/allowOther': true },
    })!;
    assert.deepEqual(
      buildDevinElicitationContent(
        commas,
        { 'Pick cities': 'Paris, France,Austin, Texas,Rome, Italy, Europe', 'One city': 'Paris, France' },
        {
          'Pick cities': { selected: ['Paris, France', 'Austin, Texas'], other: 'Rome, Italy, Europe' },
          'One city': { selected: ['Paris, France'] },
        }
      ),
      { q0: ['Paris, France', 'Austin, Texas', 'Rome, Italy, Europe'], q1: 'Paris, France' },
      'structured answers give exact consts and the whole "Other" text'
    );

    const structured = await answerWith({
      behavior: 'allow',
      // The joined string alone would misread "Banana, ripe" as Banana + "ripe".
      updatedInput: { answers: { 'Which fruits do you like?': 'Apple,Banana, ripe', 'Favorite color?': 'Blue' } },
      questionAnswers: {
        'Which fruits do you like?': { selected: ['Apple'], other: 'Banana, ripe' },
        'Favorite color?': { selected: ['Blue'] },
      },
    });
    assert.deepEqual(
      structured.reply,
      { action: 'accept', content: { q0: ['Apple', 'Banana, ripe'], q1: 'Blue' } },
      'respondToRequest prefers the structured answers over the joined string'
    );
  }

  // ── Skill library: `devin skills list --json` / `devin skills show` ──────
  {
    const { parseDevinSkillList, parseDevinSkillShowContent } = await import('../../src/electron/libs/devin-cli');
    const { mkdirSync } = await import('node:fs');
    const project = path.join(dir, 'project');
    const userSkill = path.join(dir, 'home', '.agents', 'skills', 'clarify');
    const projectSkill = path.join(project, '.devin', 'skills', 'deploy');
    mkdirSync(userSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(path.join(userSkill, 'SKILL.md'), '# clarify');
    writeFileSync(path.join(projectSkill, 'SKILL.md'), '# deploy');
    const listing = parseDevinSkillList(
      JSON.stringify([
        { name: 'deploy', description: 'Ship it', provider: 'Devin', base_dir: projectSkill, triggers: ['user'] },
        { name: 'clarify', description: 'Better copy', provider: 'Devin', base_dir: userSkill, triggers: ['user', 'model'] },
        { name: 'upload-secrets', description: 'Secrets', provider: 'Builtin', base_dir: '', triggers: ['model', 'user'] },
        { name: 'clarify', description: 'duplicate', provider: 'Claude', base_dir: userSkill },
      ]),
      project
    );
    assert.deepEqual(
      listing.map((entry) => [entry.descriptor.name, entry.descriptor.scope, entry.descriptor.path, entry.needsInlineContent]),
      [
        ['clarify', 'user', path.join(userSkill, 'SKILL.md'), false],
        ['deploy', 'project', path.join(projectSkill, 'SKILL.md'), false],
        ['upload-secrets', 'system', 'devin-builtin:upload-secrets', true],
      ],
      'file-backed skills get their SKILL.md; builtins are System with inline content; duplicates collapse'
    );
    assert.equal(
      parseDevinSkillShowContent(
        'Skill: x\n\nDescription: mentions Content: inline\nTriggers: user\n\nContent:\n────────────\nBody line 1\n\nBody line 2\n'
      ),
      'Body line 1\n\nBody line 2',
      'the body starts after the Content: line and its rule, not at an inline mention'
    );
    assert.equal(parseDevinSkillShowContent('Skill: x\nno body'), null);
  }

  // ── Thinking level parsing ───────────────────────────────────────────────
  {
    const { parseDevinThoughtLevels } = await import('../../src/electron/libs/devin-cli');
    assert.deepEqual(
      parseDevinThoughtLevels([
        { id: 'model', currentValue: 'x', options: [] },
        { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }] },
      ]),
      { levels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'XHigh' }], defaultLevel: 'high' }
    );
    assert.deepEqual(parseDevinThoughtLevels([{ id: 'model', options: [] }]), { levels: [], defaultLevel: null });
  }

  // ── Tool naming: Devin ids → Claude-shaped cards ─────────────────────────
  {
    const { devinToolName, devinToolInput } = await import('../../src/electron/libs/provider/devin-acp-adapter');
    const named = (id: string) => devinToolName({ _meta: { 'cognition.ai/inferenceToolName': id } });
    assert.deepEqual(
      ['exec', 'read', 'write', 'edit', 'grep', 'find_file_by_name', 'notebook_edit', 'mcp__x__y'].map(named),
      ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit', 'mcp__x__y']
    );
    assert.equal(devinToolName({ kind: 'execute', title: 'Ran ls' }), 'Bash', 'ACP kind is the fallback');
    assert.deepEqual(devinToolInput('Glob', { query: '**/note.txt' }), { query: '**/note.txt', pattern: '**/note.txt' });
    assert.deepEqual(devinToolInput('Bash', { command: 'ls' }), { command: 'ls' });
    assert.equal(named('ask_user_question'), 'AskUserQuestion');
    assert.deepEqual(
      devinToolInput('AskUserQuestion', { questions: [{ question: 'Q?', multi_select: true, options: [{ label: 'a' }] }] }),
      { questions: [{ question: 'Q?', options: [{ label: 'a' }], multiSelect: true }] }
    );
  }

  // ── Catalog parsing: flat and grouped model selects ──────────────────────
  {
    const { parseDevinAcpModelOptions } = await import('../../src/electron/libs/devin-cli');
    assert.deepEqual(
      parseDevinAcpModelOptions([
        { id: 'mode', options: [{ value: 'plan', name: 'Plan' }] },
        { id: 'model', category: 'model', currentValue: 'swe-2-high', options: [{ value: 'adaptive', name: 'Adaptive' }, { value: 'swe-2-high', name: 'SWE-2' }] },
      ]),
      { defaultModel: 'swe-2-high', availableModels: [{ id: 'adaptive', label: 'Adaptive' }, { id: 'swe-2-high', label: 'SWE-2' }] }
    );
    assert.deepEqual(
      parseDevinAcpModelOptions([
        { id: 'model', currentValue: 'b', options: [{ group: 'g1', name: 'Group', options: [{ value: 'a', name: 'A' }, { value: 'b' }] }, { value: 'a', name: 'dup' }] },
      ]),
      { defaultModel: 'b', availableModels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'b' }] }
    );
    assert.deepEqual(parseDevinAcpModelOptions(undefined), { defaultModel: null, availableModels: [] });
  }

  // ── Resume: load replay is dropped, startup state is kept ────────────────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => events.push(event));
    const session = await adapter.startSession({
      threadId: 't2',
      cwd: dir,
      prompt: '',
      resumeSessionId: 'old-session',
      devinPermissionMode: 'plan',
    } as never);
    assert.equal(session.providerSessionId, 'old-session');
    assert.deepEqual(
      readCalls().map((call) => call.method),
      ['initialize', 'session/load'],
      'the loaded session is already in plan mode: no set_mode'
    );
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('REPLAYED ANSWER'), 'replayed transcript must not re-enter the thread');
    assert.ok(!serialized.includes('old-call'), 'replayed tool calls must not re-enter the thread');
    const usage = events.find(
      (event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'token_usage'
    );
    assert.ok(usage, 'the replayed context watermark seeds the context ring');
    assert.ok(
      events.some((event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'available_commands_update')
    );
    await adapter.stopAll();
  }

  // ── Resume failure falls back to a fresh session ─────────────────────────
  {
    resetCalls();
    process.env.FAKE_DEVIN_FAIL_LOAD = '1';
    const adapter = new DevinAcpAdapter();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const session = await adapter.startSession({
        threadId: 't3',
        cwd: dir,
        prompt: '',
        resumeSessionId: 'gone-session',
      } as never);
      assert.equal(session.providerSessionId, 'fresh-session');
      assert.deepEqual(readCalls().map((call) => call.method), ['initialize', 'session/load', 'session/new']);
    } finally {
      console.warn = warn;
      delete process.env.FAKE_DEVIN_FAIL_LOAD;
      await adapter.stopAll();
    }
  }

  // ── Stopping a session while it is still starting ─────────────────────────
  {
    resetCalls();
    process.env.FAKE_DEVIN_SLOW_INIT = '1';
    try {
      for (const teardown of ['stop', 'dispose'] as const) {
        resetCalls();
        writeFileSync(pidsPath, '');
        const adapter = new DevinAcpAdapter();
        const start = adapter.startSession({ threadId: 't8', cwd: dir, prompt: 'should never run' } as never);
        start.catch(() => undefined);
        await waitFor(() => readCalls().some((call) => call.method === 'initialize'), 'initialize reaching the CLI');
        const [pid] = readPids();
        if (teardown === 'stop') await adapter.stopSession('t8');
        else assert.equal(adapter.disposeSession('t8'), true, 'dispose reports the cancelled start');
        await assert.rejects(start, /cancelled|exited/, `a ${teardown}ped start fails instead of registering`);
        await waitFor(() => !isAlive(pid), `the starting process exiting after ${teardown}`);
        // Past the delayed initialize response: nothing may follow it.
        await new Promise((resolve) => setTimeout(resolve, 1600));
        assert.equal(adapter.hasSession('t8'), false);
        assert.deepEqual(readCalls().map((call) => call.method), ['initialize'], 'no session is created and no prompt sent');
      }
    } finally {
      delete process.env.FAKE_DEVIN_SLOW_INIT;
    }
  }

  // ── Devin exiting between turns: the next send reconnects and reloads ─────
  {
    resetCalls();
    writeFileSync(pidsPath, '');
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t9', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });
    await adapter.startSession({ threadId: 't9', cwd: dir, prompt: '' } as never);
    await withTimeout(adapter.sendTurn({ threadId: 't9', prompt: 'go' } as never), 'turn before the exit');
    const [firstPid] = readPids();
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => !isAlive(firstPid), 'the killed CLI exiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.hasSession('t9'), true, 'an exit between turns keeps the session');

    events.length = 0;
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId: 't9', prompt: 'go again' } as never), 'turn after Devin exited');
    const calls = readCalls();
    assert.deepEqual(calls.slice(0, 2).map((call) => call.method), ['initialize', 'session/load'], 'a fresh process reloads the session');
    assert.equal(calls[1].params.sessionId, 'fresh-session');
    assert.ok(calls.some((call) => call.method === 'session/prompt'), 'the turn runs in the new process');
    const pids = readPids();
    assert.equal(pids.length, 2);
    assert.ok(isAlive(pids[1]), 'the new process serves the session');
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('REPLAYED ANSWER'), 'the reload replay must not re-enter the thread');
    assert.ok(!events.some((event) => event.type === 'system_init'), 'the reloaded session keeps its id');
    const result = events
      .filter((event) => event.type === 'message' && (event.message as { type?: string }).type === 'result')
      .map((event) => event.message as { subtype: string })
      .at(-1);
    assert.equal(result?.subtype, 'success');
    await adapter.stopAll();
    await waitFor(() => !isAlive(pids[1]), 'stopAll killing the reconnected process');
  }

  // ── Stopping while a reconnect is still starting kills it ─────────────────
  {
    resetCalls();
    writeFileSync(pidsPath, '');
    const adapter = new DevinAcpAdapter();
    adapter.events.on('event', (event: Event) => {
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t10', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });
    await withTimeout(adapter.startSession({ threadId: 't10', cwd: dir, prompt: '' } as never), 'startSession');
    await withTimeout(adapter.sendTurn({ threadId: 't10', prompt: 'go' } as never), 'turn before the exit');
    const [firstPid] = readPids();
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => !isAlive(firstPid), 'the killed CLI exiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
    resetCalls();
    process.env.FAKE_DEVIN_SLOW_INIT = '1';
    try {
      const pending = adapter.sendTurn({ threadId: 't10', prompt: 'go again' } as never);
      await waitFor(() => readPids().length === 2, 'the reconnect spawning');
      const reconnectingPid = readPids()[1];
      await adapter.stopSession('t10');
      await withTimeout(pending, 'send whose reconnect was stopped', 1_000);
      await waitFor(() => !isAlive(reconnectingPid), 'the reconnecting process killed by the stop', 1_000);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      assert.ok(!readCalls().some((call) => call.method === 'session/load' || call.method === 'session/prompt'), 'the stopped reconnect never reloads or prompts');
      assert.equal(adapter.hasSession('t10'), false);
    } finally {
      delete process.env.FAKE_DEVIN_SLOW_INIT;
    }
  }

  // ── Probe close: a probe stuck in initialize is still killed ─────────────
  {
    const { DevinProbeSession } = await import('../../src/electron/libs/devin-cli');
    writeFileSync(pidsPath, '');
    process.env.FAKE_DEVIN_HANG_INIT = '1';
    try {
      const probe = new DevinProbeSession(300);
      await assert.rejects(probe.run(async () => 'never'), /timed out/);
      const [pid] = readPids();
      assert.ok(pid, 'the probe spawned the CLI');
      await waitFor(() => !isAlive(pid), 'the stuck probe process exiting', 4_000);
    } finally {
      delete process.env.FAKE_DEVIN_HANG_INIT;
    }
  }

  // ── Thinking levels: a failed read is not cached by the renderer ─────────
  {
    const { getDevinThoughtLevels } = await import('../../src/electron/libs/devin-cli');
    (globalThis as { window?: unknown }).window = { electron: { getDevinThoughtLevels } };
    const { requestDevinThoughtLevels } = await import('../../src/ui/hooks/useDevinThoughtLevels');
    writeFileSync(pidsPath, '');
    writeFileSync(failSwitchPath, '');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const failed = await withTimeout(requestDevinThoughtLevels('claude-opus-5-5-high'), 'failing level read');
      assert.equal(failed.failed, true, 'a failed read is marked failed, not "no thinking control"');
      assert.deepEqual(failed.levels, []);
      const retried = await withTimeout(requestDevinThoughtLevels('claude-opus-5-5-high'), 'level read after a failure');
      assert.equal(retried.failed, undefined);
      assert.deepEqual(retried.levels.map((level) => level.id), ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(retried.defaultLevel, 'medium');
    } finally {
      console.warn = warn;
      // The shared probe idles for 45s before closing itself.
      for (const pid of readPids()) if (isAlive(pid)) process.kill(pid, 'SIGTERM');
    }
  }

  console.log('devin-acp-adapter: all checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });

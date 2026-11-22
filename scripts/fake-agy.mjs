#!/usr/bin/env node
/**
 * A scripted stand-in for Google's `agy` (Antigravity CLI), for tests. It
 * answers `--version`, `acp --help` and runs an ACP stdio server on `acp`
 * that reproduces the wire behavior observed on agy 1.5.14:
 * - ACP v1; no fs/terminal use; session/new reports models (config options
 *   `model`, `thought_level`), session modes and a `mode` config option;
 * - session/resume reopens a session on the default model;
 * - a tool call goes in_progress → pending → session/request_permission
 *   (allow / deny, the request repeats the call with its diff) → in_progress
 *   → completed, with PascalCase arguments (`Path`, `Content`, `CommandLine`);
 * - the prompt response carries the turn's token usage;
 * - session/cancel ends the running prompt with stopReason `cancelled`;
 * - the process exits by itself when its input closes.
 *
 * What a turn does is chosen by words in the prompt (WRITE, RUN, THINK, SLOW,
 * CRASH, EXIT_AFTER, REFUSE, FAIL, PLAN, SWITCH_MODE, TITLE); anything else
 * is echoed. Environment:
 *   FAKE_AGY_LOG            jsonl file that receives every request
 *   FAKE_AGY_AUTH_REQUIRED  session/new and session/resume fail with ACP's auth_required
 *   FAKE_AGY_FAIL_RESUME    session/resume fails (the session is gone)
 *   FAKE_AGY_NO_RESUME      advertise loadSession only (no session/resume)
 *   FAKE_AGY_NO_ACP         `acp --help` fails (a CLI too old for ACP)
 *   FAKE_AGY_SLOW_INIT      initialize answers after 400ms
 *   FAKE_AGY_SESSION_ID     id of the next new session
 */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const LOG = process.env.FAKE_AGY_LOG;
const log = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (args[0] === '--version') {
  console.log('1.5.14');
  process.exit(0);
}
if (args[0] === 'acp' && (args.includes('--help') || args.includes('-h'))) {
  if (process.env.FAKE_AGY_NO_ACP === '1') {
    console.error('unknown command: acp');
    process.exit(2);
  }
  console.log('Usage: agy acp [flags]\n\nStart the Agent Client Protocol (ACP) stdio server\n\nFlags:\n  --login   Log in with Google interactively, then exit (ACP terminal auth)');
  process.exit(0);
}
if (args[0] !== 'acp' || args.length !== 1) {
  // Aegis must start the server with exactly `acp`: anything else is a bug.
  log({ badArgs: args });
  console.error(`fake agy: unexpected arguments ${JSON.stringify(args)}`);
  process.exit(64);
}

log({ spawn: { args, cwd: process.cwd() } });

const MODELS = [
  { value: 'gemini-4-neon', name: 'Gemini 4 Neon', levels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', levels: ['low', 'medium', 'high'] },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', levels: [] },
];
const LEVEL_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra' };
const MODES = [
  { id: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
  { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
  { id: 'auto', name: 'Auto', description: 'Approve edits and safe commands; ask before irreversible actions.' },
  { id: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
];

/** sessionId → state. A resumed session starts again from the defaults. */
const sessions = new Map();
const freshState = () => ({ model: 'gemini-4-neon', level: 'high', mode: 'default', used: 0 });

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const configOptions = (state) => {
  const model = MODELS.find((entry) => entry.value === state.model);
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model, options: MODELS.map(({ value, name }) => ({ value, name })) },
    ...(model.levels.length > 0
      ? [{ id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: state.level, options: model.levels.map((value) => ({ value, name: LEVEL_NAMES[value] })) }]
      : []),
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: state.mode, options: MODES.map(({ id, name, description }) => ({ value: id, name, description })) },
  ];
};
const sessionRecord = (sessionId, state) => ({
  sessionId,
  models: { availableModels: MODELS.map(({ value, name }) => ({ modelId: value, name })), currentModelId: state.model },
  modes: { currentModeId: state.mode, availableModes: MODES },
  configOptions: configOptions(state),
});
const pushStartupState = (sessionId, state) => {
  update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [
    { name: 'plan', description: 'Plan carefully before executing a task.' },
    { name: 'compact', description: 'Compact the conversation now.' },
  ] });
  update(sessionId, { sessionUpdate: 'usage_update', used: state.used, size: 1048576 });
};

let nextRequestId = 1;
const pendingAnswers = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = String(nextRequestId++);
    pendingAnswers.set(id, resolve);
    send({ id, method, params });
  });

/** agy numbers its calls; an id is never used twice. */
let callSeq = 0;

/** The running prompt, so session/cancel can end it. */
let running = null;

const usage = (state, output) => {
  state.used += 10000 + output;
  return { inputTokens: 12000, outputTokens: output, cachedReadTokens: 8000, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 20000 + output };
};

async function toolCall(sessionId, call, { diff, output }) {
  const base = { toolCallId: call.id, name: call.name, args: call.args, kind: call.kind, title: call.title, rawInput: call.args };
  update(sessionId, { sessionUpdate: 'tool_call', ...base, status: 'in_progress' });
  update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'pending' });
  const answer = await ask('session/request_permission', {
    sessionId,
    toolCall: { sessionUpdate: 'tool_call', ...base, status: 'pending', ...(diff ? { content: [diff] } : {}) },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  log({ permission: answer });
  const outcome = answer?.outcome;
  if (outcome?.outcome !== 'selected' || outcome.optionId !== 'allow') {
    update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'failed', rawOutput: { output: 'Denied by the user.' } });
    return false;
  }
  update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'in_progress' });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    ...base,
    status: 'completed',
    rawOutput: output ? { output, exit_code: 0 } : {},
    content: diff ? [diff] : [{ type: 'content', content: { type: 'text', text: output } }],
  });
  return true;
}

async function prompt(id, params) {
  const { sessionId } = params;
  const state = sessions.get(sessionId);
  if (!state) {
    send({ id, error: { code: -32602, message: `Unknown session: ${sessionId}` } });
    return;
  }
  const text = (params.prompt || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const turn = { id, sessionId, cancelled: false, finish: null };
  running = turn;
  const finish = (stopReason, output = 40) => {
    if (running === turn) running = null;
    send({ id, result: { stopReason, usage: usage(state, output) } });
  };
  turn.finish = finish;
  const say = (chunk) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });

  if (/\bTITLE\b/.test(text)) update(sessionId, { sessionUpdate: 'session_info_update', title: 'Fake Title From Agy' });
  if (/\bFAIL\b/.test(text)) {
    running = null;
    send({ id, error: { code: -32603, message: 'Model is overloaded, try again later' } });
    return;
  }
  if (/\bCRASH\b/.test(text)) {
    say('about to');
    console.error('panic: fake agy crashed');
    await sleep(20);
    process.exit(3);
  }
  if (/\bREFUSE\b/.test(text)) {
    say('I cannot help with that.');
    finish('refusal', 8);
    return;
  }
  if (/\bSLOW\b/.test(text)) {
    say('working');
    // Ends only when cancelled.
    return;
  }
  if (/\bTHINK\b/.test(text)) {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me ' } });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think.' } });
  }
  if (/\bPLAN\b/.test(text)) {
    update(sessionId, { sessionUpdate: 'plan', entries: [
      { content: 'Read the code', priority: 'high', status: 'completed' },
      { content: 'Write the fix', priority: 'medium', status: 'in_progress' },
      { content: 'Run the tests', priority: 'low', status: 'pending' },
    ] });
  }
  if (/\bSWITCH_MODE\b/.test(text)) {
    state.mode = 'plan';
    update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
  }
  if (/\bWRITE\b/.test(text)) {
    say('Writing the file. ');
    const file = `${process.cwd()}/hello.txt`;
    const allowed = await toolCall(
      sessionId,
      { id: `call_write_${++callSeq}`, name: 'write_file', kind: 'edit', title: 'File hello.txt', args: { Content: 'hello\n', Path: file } },
      { diff: { type: 'diff', path: file, newText: 'hello\n' } }
    );
    if (turn.cancelled) return;
    if (!allowed) {
      say('I did not write the file.');
      finish('end_turn', 20);
      return;
    }
  }
  if (/\bRUN\b/.test(text)) {
    const allowed = await toolCall(
      sessionId,
      { id: `call_run_${++callSeq}`, name: 'run_command', kind: 'execute', title: 'cat hello.txt', args: { CommandLine: 'cat hello.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Display hello.txt content' } },
      { output: 'Command exited with code 0.\n\nCommand output:\nhello\r\n' }
    );
    if (turn.cancelled) return;
    if (!allowed) {
      finish('end_turn', 20);
      return;
    }
  }
  if (/\bEDIT\b/.test(text)) {
    // A tool agy names differently: only its ACP kind and diff describe it.
    const file = `${process.cwd()}/hello.txt`;
    const base = { toolCallId: `call_edit_${++callSeq}`, name: 'replace_file_content', kind: 'edit', title: 'Edit hello.txt', rawInput: { TargetFile: file } };
    update(sessionId, { sessionUpdate: 'tool_call', ...base, status: 'in_progress', locations: [{ path: file }] });
    update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'completed', rawOutput: {}, content: [{ type: 'diff', path: file, oldText: 'hello\n', newText: 'goodbye\n' }] });
  }
  say(/\bWRITE\b|\bRUN\b|\bEDIT\b/.test(text) ? 'done' : `echo: ${text}`);
  update(sessionId, { sessionUpdate: 'usage_update', used: state.used + 10000, size: 1048576 });
  finish('end_turn');
  if (/\bEXIT_AFTER\b/.test(text)) {
    await sleep(30);
    process.exit(0);
  }
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === undefined) {
    const resolve = pendingAnswers.get(String(id));
    if (resolve) {
      pendingAnswers.delete(String(id));
      resolve(message.error ? null : message.result);
    }
    return;
  }
  log({ method, params });
  switch (method) {
    case 'initialize': {
      if (process.env.FAKE_AGY_SLOW_INIT === '1') await sleep(400);
      const noResume = process.env.FAKE_AGY_NO_RESUME === '1';
      send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { ...(noResume ? {} : { resume: {} }), close: {}, load: {}, list: {} },
          auth: { logout: {} },
        },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
          { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' },
        ],
      } });
      return;
    }
    case 'session/new':
    case 'session/resume':
    case 'session/load': {
      if (process.env.FAKE_AGY_AUTH_REQUIRED === '1') {
        send({ id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      if (method !== 'session/new' && process.env.FAKE_AGY_FAIL_RESUME === '1') {
        send({ id, error: { code: -32603, message: `Failed to read session ${params.sessionId}; retry, or load it with session/load` } });
        return;
      }
      const sessionId = method === 'session/new' ? process.env.FAKE_AGY_SESSION_ID || `agy-${process.pid}-${sessions.size + 1}` : params.sessionId;
      const state = freshState();
      sessions.set(sessionId, state);
      if (method === 'session/load') {
        // The transcript, replayed before the answer.
        update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an earlier message' } });
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'an earlier answer' } });
      }
      send({ id, result: sessionRecord(sessionId, state) });
      pushStartupState(sessionId, state);
      return;
    }
    case 'session/set_config_option': {
      const state = sessions.get(params.sessionId);
      if (!state) return send({ id, error: { code: -32602, message: `Unknown session: ${params.sessionId}` } });
      if (params.configId === 'model') {
        const model = MODELS.find((entry) => entry.value === params.value);
        if (!model) return send({ id, error: { code: -32602, message: `Unknown model ID: ${params.value}` } });
        state.model = model.value;
        // A model switch resets the level to that model's default.
        state.level = model.levels.includes('high') ? 'high' : model.levels[0] || '';
      } else if (params.configId === 'thought_level') {
        const model = MODELS.find((entry) => entry.value === state.model);
        if (!model.levels.includes(params.value)) return send({ id, error: { code: -32602, message: `Unknown thinking level: ${params.value}` } });
        state.level = params.value;
      } else {
        return send({ id, error: { code: -32602, message: `Unknown config option: ${params.configId}` } });
      }
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(state) });
      send({ id, result: { configOptions: configOptions(state) } });
      return;
    }
    case 'session/set_mode': {
      const state = sessions.get(params.sessionId);
      if (!state || !MODES.some((mode) => mode.id === params.modeId)) {
        return send({ id, error: { code: -32602, message: `Unknown mode: ${params.modeId}` } });
      }
      state.mode = params.modeId;
      send({ id, result: {} });
      update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: state.mode });
      return;
    }
    case 'session/prompt':
      await prompt(id, params);
      return;
    case 'session/cancel': {
      const turn = running;
      if (turn && turn.sessionId === params.sessionId) {
        turn.cancelled = true;
        // Pending approvals are answered `cancelled` by the client; agy then
        // ends the prompt.
        await sleep(15);
        turn.finish('cancelled', 5);
      }
      return;
    }
    case 'session/close':
      sessions.delete(params.sessionId);
      send({ id, result: {} });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(message);
  }
});
// agy exits by itself when its input closes.
process.stdin.on('end', () => {
  log({ exit: 'stdin closed' });
  process.exit(0);
});

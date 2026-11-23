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
 * - an edit's `diff` entry holds the whole file before and after it, while the
 *   arguments name the passage (`Target` → `Replacement`): a real session's
 *   stored calls had a 29-character Target beside two 536 KB texts;
 * - a command that outlives its wait goes on in the background: the prompt
 *   turn ends with its call still in progress, and when the command is done
 *   agy goes on by itself, with thoughts, calls and text outside any prompt
 *   (a real session's stored rows show such work after three of five turns).
 *   Every model step ends with a usage_update, sent just before its tool call;
 *
 * What a turn does is chosen by words in the prompt (WRITE, RUN, EDIT,
 * WHOLEFILE, WHOLEDIFF, BACKGROUND, THINK, SLOW, CRASH, EXIT_AFTER, REFUSE,
 * FAIL, PLAN, SWITCH_MODE, TITLE); anything else is echoed. After BACKGROUND,
 * WAKE_HOLD stops the work agy does by itself in the middle of a step,
 * WAKE_CRASH ends the process there, and WAKE_TWICE has it speak once more
 * after a pause. WAKE_NOW sends the first of that work in the same write as
 * the prompt's response; WAKE_RESEND repeats the command's tool_call before
 * it reports back; WAKE_PARALLEL runs a quick and a slow call in one step;
 * WAKE_RETITLE ends with an update that only renames a finished call; and
 * WAKE_EDIT has agy edit a large file, whole-file diff and all. Environment:
 *   FAKE_AGY_LOG            jsonl file that receives every request
 *   FAKE_AGY_AUTH_REQUIRED  session/new and session/resume fail with ACP's auth_required
 *   FAKE_AGY_FAIL_RESUME    session/resume fails (the session is gone)
 *   FAKE_AGY_NO_RESUME      advertise loadSession only (no session/resume)
 *   FAKE_AGY_NO_ACP         `acp --help` fails (a CLI too old for ACP)
 *   FAKE_AGY_SLOW_INIT      initialize answers after 400ms
 *   FAKE_AGY_SESSION_ID     id of the next new session
 *   FAKE_AGY_WAKE_MS        how long a BACKGROUND command runs after its turn (80)
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

/** Lines held to go out in one write, so they reach the client in one read. */
let held = null;
const send = (message) => {
  const line = `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
  if (held) held.push(line);
  else process.stdout.write(line);
};
const inOneWrite = (work) => {
  held = [];
  work();
  const lines = held.join('');
  held = null;
  process.stdout.write(lines);
};
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

/** A 14,000-line source file (about 600 KB), and the same file with one line changed. */
const BIG_FILE_LINES = 14000;
const bigFileLine = (index) => `  const entry${index} = table[${index}] ?? fallback;`;
const bigFile = (changed) =>
  `${Array.from({ length: BIG_FILE_LINES }, (_, index) => changed?.[index] ?? bigFileLine(index)).join('\n')}\n`;

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

/**
 * What agy does by itself once the background command of a BACKGROUND turn is
 * done. `finishPrompt`: with WAKE_NOW, the prompt's response, sent together
 * with the first of this work.
 */
async function wake(sessionId, state, build, text, finishPrompt) {
  const has = (word) => new RegExp(`\\b${word}\\b`).test(text);
  const pause = Number(process.env.FAKE_AGY_WAKE_MS || 80);
  const think = (chunk) => update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk } });
  const say = (chunk) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
  const stepEnds = () => update(sessionId, { sessionUpdate: 'usage_update', used: (state.used += 5000), size: 1048576 });
  const reportsBack = () =>
    update(sessionId, { sessionUpdate: 'tool_call_update', ...build, status: 'completed', rawOutput: { output: 'built in 63s', exit_code: 0 } });
  if (finishPrompt) {
    inOneWrite(() => {
      finishPrompt();
      reportsBack();
      think('The build ');
    });
  } else {
    await sleep(pause);
    // agy repeats the call it is still running, as it does when a call changes state.
    if (has('WAKE_RESEND')) update(sessionId, { sessionUpdate: 'tool_call', ...build, status: 'in_progress' });
    // The command reports back, and the model takes it from there.
    reportsBack();
    think('The build ');
  }
  await sleep(10);
  think('finished.');
  stepEnds();
  const check = { toolCallId: `call_check_${++callSeq}`, name: 'run_command', kind: 'execute', title: 'ls dist', rawInput: { CommandLine: 'ls dist' } };
  update(sessionId, { sessionUpdate: 'tool_call', ...check, status: 'in_progress' });
  const slow = { toolCallId: `call_slow_${callSeq + 1}`, name: 'run_command', kind: 'execute', title: 'codesign app', rawInput: { CommandLine: 'codesign app' } };
  if (has('WAKE_PARALLEL')) {
    callSeq += 1;
    update(sessionId, { sessionUpdate: 'tool_call', ...slow, status: 'in_progress' });
  }
  await sleep(10);
  update(sessionId, { sessionUpdate: 'tool_call_update', ...check, status: 'completed', rawOutput: { output: 'app.dmg', exit_code: 0 } });
  if (has('WAKE_PARALLEL')) {
    // The model still waits for the slow call, far longer than for the quick one.
    await sleep(pause * 8);
    update(sessionId, { sessionUpdate: 'tool_call_update', ...slow, status: 'completed', rawOutput: { output: 'signed', exit_code: 0 } });
  }
  if (has('WAKE_EDIT')) {
    const file = `${process.cwd()}/big.ts`;
    const replacement = '  const entry9000 = changed;';
    const edit = { toolCallId: `call_edit_${++callSeq}`, name: 'replace_file_content', kind: 'edit', title: 'Edit big.ts', rawInput: { Path: file, Target: bigFileLine(9000), Replacement: replacement } };
    update(sessionId, { sessionUpdate: 'tool_call', ...edit, status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', ...edit, status: 'completed', rawOutput: {}, content: [{ type: 'diff', path: file, oldText: bigFile(), newText: bigFile({ 9000: replacement }) }] });
  }
  say('Checking the artefact. ');
  if (has('WAKE_HOLD')) return;
  if (has('WAKE_CRASH')) {
    console.error('panic: fake agy crashed');
    await sleep(20);
    process.exit(3);
  }
  await sleep(10);
  say('The build is done: app.dmg.');
  stepEnds();
  // A call that finished long ago gets a new title: no status, nothing new.
  if (has('WAKE_RETITLE')) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: check.toolCallId, title: 'ls dist (done)' });
  if (has('WAKE_TWICE')) {
    await sleep(pause * 5);
    say('One more note.');
    stepEnds();
  }
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
  if (/\bBACKGROUND\b/.test(text)) {
    // A command that outlives its wait: the turn ends with its call open.
    const build = { toolCallId: `call_bg_${++callSeq}`, name: 'run_command', kind: 'execute', title: 'npm run build', rawInput: { CommandLine: 'npm run build', WaitMsBeforeAsync: 10000 } };
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will start the build.' } });
    update(sessionId, { sessionUpdate: 'usage_update', used: state.used + 5000, size: 1048576 });
    update(sessionId, { sessionUpdate: 'tool_call', ...build, status: 'in_progress' });
    await sleep(10);
    say('Started the build; waiting for it to finish.');
    update(sessionId, { sessionUpdate: 'usage_update', used: state.used + 10000, size: 1048576 });
    if (/\bWAKE_NOW\b/.test(text)) {
      void wake(sessionId, state, build, text, () => finish('end_turn'));
      return;
    }
    finish('end_turn');
    void wake(sessionId, state, build, text);
    return;
  }
  if (/\bWHOLEFILE\b/.test(text)) {
    // An edit of one line: the passage in the arguments, the whole file in the diff.
    const file = `${process.cwd()}/big.ts`;
    const replacement = '  const entry9000 = changed;';
    const allowed = await toolCall(
      sessionId,
      { id: `call_whole_${++callSeq}`, name: 'replace_file_content', kind: 'edit', title: 'Edit big.ts', args: { Path: file, Target: bigFileLine(9000), Replacement: replacement } },
      { diff: { type: 'diff', path: file, oldText: bigFile(), newText: bigFile({ 9000: replacement }) } }
    );
    if (turn.cancelled) return;
    if (!allowed) {
      finish('end_turn', 20);
      return;
    }
  }
  if (/\bWHOLEDIFF\b/.test(text)) {
    // The same edit from a tool that describes it by its diff alone.
    const file = `${process.cwd()}/big.ts`;
    const base = { toolCallId: `call_diff_${++callSeq}`, name: 'apply_change', kind: 'edit', title: 'Edit big.ts', rawInput: { TargetFile: file } };
    update(sessionId, { sessionUpdate: 'tool_call', ...base, status: 'in_progress', locations: [{ path: file }] });
    update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'completed', rawOutput: {}, content: [{ type: 'diff', path: file, oldText: bigFile(), newText: bigFile({ 9000: '  const entry9000 = changed;' }) }] });
  }
  say(/\bWRITE\b|\bRUN\b|\bEDIT\b|\bWHOLEFILE\b|\bWHOLEDIFF\b/.test(text) ? 'done' : `echo: ${text}`);
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

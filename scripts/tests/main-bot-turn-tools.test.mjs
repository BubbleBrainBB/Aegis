// What the model is given in a turn of the main bot's conversation, through the
// real Bubble SDK: its job as the system prompt, its own tools, and of the
// coding agent's tools only the ones that look. A model left with the coding
// agent's prompt and tools handed work to a workflow of its own instead of a
// task, then looked for start_task with tool_search, which only knows tools
// not loaded yet, and said there was none.
// Run: npm run transpile:electron && node scripts/tests/main-bot-turn-tools.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'aegis-main-bot-turn-'));
const oldHome = process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME = join(root, 'home');
try {
  const { BubbleSdk } = await import('@bubblebrain-ai/bubble');
  const { registerDynamicModelMetadata } = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  const { setMainBotTools } = require('../../dist-electron/electron/libs/main-bot/tools.js');
  const { bubbleHostTools, bubbleRoleOptions } = require('../../dist-electron/electron/libs/bubble-session-reader.js');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  const { MAIN_BOT_INSTRUCTIONS } = require('../../dist-electron/shared/main-bot.js');
  setMainBotTools({}, () => 'main');
  registerDynamicModelMetadata({ providerId: 'openai', id: 'probe', contextWindow: 128000 });
  const cwd = join(root, 'main-bot');
  mkdirSync(cwd, { recursive: true });

  // The adapter sends both with every turn of the bot's conversation, and with no other.
  const adapter = new BubbleSdkAdapter();
  const optionsOf = (threadId) => adapter.turnOptions({ threadId, cwd, pendingRequests: new Map() }, { abortController: new AbortController() }, 'hi', {}, Symbol('turn'));
  const mine = optionsOf('main');
  assert.equal(mine.systemPrompt, MAIN_BOT_INSTRUCTIONS);
  assert.deepEqual(mine.allowedTools, ['read', 'ls', 'grep', 'web_search', 'web_fetch', 'question', 'exit_plan_mode']);
  assert.ok(mine.hostTools.some((tool) => tool.name === 'start_task'));
  const others = optionsOf('a-task');
  assert.equal('systemPrompt' in others, false, 'a task runs as the coding agent');
  assert.equal('allowedTools' in others, false, 'with all of its tools');
  assert.deepEqual(bubbleRoleOptions(undefined), {});

  // What reaches the model.
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  const calls = [];
  let script = [];
  sdk.resolveProvider = () => ({ providerId: 'openai', model: 'openai:probe', provider: { async *streamChat(messages, options) {
    calls.push({
      tools: (options?.tools ?? []).map((tool) => tool.name),
      system: messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n'),
      all: messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n'),
    });
    const next = script.shift();
    if (next) yield { type: 'tool_call', id: 'call-' + calls.length, name: next.name, arguments: JSON.stringify(next.args), isStart: true, isEnd: true };
    else yield { type: 'text', content: 'done' };
    yield { type: 'done' };
  } } });
  const turn = async (threadId, session, prompt, steps = []) => {
    script = [...steps];
    const before = calls.length;
    const events = [];
    for await (const event of sdk.runTurn(session, { prompt, mode: 'bypassPermissions', hostTools: bubbleHostTools(threadId), ...bubbleRoleOptions(threadId) })) events.push(event);
    return { calls: calls.slice(before), events };
  };

  const bot = sdk.createSession({ cwd }).id;
  const own = bubbleHostTools('main').map((tool) => tool.name);
  // "workflow" in a message is what Bubble takes for a request to orchestrate.
  const first = (await turn('main', bot, 'Hand this out: draw the design first. Its task may prepare a workflow.')).calls[0];
  assert.deepEqual([...first.tools].sort(), ['read', 'ls', 'grep', 'web_search', 'web_fetch', 'question', ...own].sort(), 'the tools that look, the question, and its own');
  for (const name of ['start_task', 'message_task', 'list_handed_out', 'list_tasks', 'read_conversation']) assert.ok(first.tools.includes(name), name);
  for (const gone of ['spawn_agent', 'wait_agent', 'send_input', 'run_workflow', 'wait_workflow', 'bash', 'write', 'edit', 'tool_search', 'memory', 'skill', 'start_workflow', 'start_session']) {
    assert.ok(!first.tools.includes(gone), gone + ' is not offered to the bot');
  }
  assert.ok(first.system.startsWith('You are Aegis'), 'its job is the system prompt');
  assert.match(first.system, /New work: start_task/);
  assert.doesNotMatch(first.system, /You are Bubble|Available tools:|Delegation policy|spawn_agent|run_workflow/, 'nothing of the coding agent is left in it');
  assert.doesNotMatch(first.all, /run_workflow/, 'no reminder to run a workflow of its own');

  // A model that still calls one of them is told it does not exist, and the next turns are as the first.
  const tried = await turn('main', bot, 'again', [{ name: 'run_workflow', args: { script: 'return 1' } }, { name: 'tool_search', args: { query: 'select:start_task' } }]);
  assert.equal(tried.events.filter((event) => event.type === 'tool_end' && event.result?.isError).length, 2, 'neither runs');
  assert.deepEqual(tried.calls.at(-1).tools, first.tools);
  assert.equal(tried.calls.at(-1).system, first.system);

  // Any other conversation is the coding agent it was.
  const task = (await turn('a-task', sdk.createSession({ cwd }).id, 'Run a workflow over the repo')).calls[0];
  for (const name of ['spawn_agent', 'run_workflow', 'bash', 'write', 'edit', 'tool_search', 'start_workflow', 'start_session']) assert.ok(task.tools.includes(name), name + ' stays with a task');
  assert.ok(!task.tools.includes('start_task'));
  assert.match(task.system, /^You are Bubble/);
  console.log('main-bot-turn-tools: ok');
} finally {
  if (oldHome === undefined) delete process.env.BUBBLE_HOME; else process.env.BUBBLE_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);

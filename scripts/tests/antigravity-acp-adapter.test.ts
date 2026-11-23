import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drives the Antigravity integration end to end against scripts/fake-agy.mjs,
 * a scripted stand-in for `agy` that reproduces the wire behavior observed on
 * agy 1.5.14 (see that file). Covers the CLI module (detection, status, the
 * catalog read over ACP), the ACP adapter (handshake, streaming, approvals,
 * cancel, exits, reopening) and the rule that only a person drives it.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'antigravity-acp-test-'));
const cwd = path.join(dir, 'project');
mkdirSync(cwd);
const logPath = path.join(dir, 'calls.jsonl');
const fakeAgy = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fake-agy.mjs');

process.env.ANTIGRAVITY_CLI_PATH = fakeAgy;
process.env.FAKE_AGY_LOG = logPath;

type Event = { type: string; [key: string]: any };
type Call = { pid: number; method?: string; params?: Record<string, any>; spawn?: { args: string[]; cwd: string }; permission?: any; exit?: string; badArgs?: string[] };

function readCalls(): Call[] {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function resetCalls(): void {
  writeFileSync(logPath, '');
}

function methods(): string[] {
  return readCalls().map((call) => call.method).filter((method): method is string => Boolean(method));
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

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function messages(events: Event[]): Array<Record<string, any>> {
  return events.filter((event) => event.type === 'message').map((event) => event.message);
}

function blocks(events: Event[], type: string): Array<Record<string, any>> {
  return messages(events)
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.message.content as Array<Record<string, any>>)
    .filter((block) => block.type === type);
}

function results(events: Event[]): Array<Record<string, any>> {
  return messages(events).filter((message) => message.type === 'result');
}

/** Environment for the fake, for the length of one case. */
async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

async function main(): Promise<void> {
  const cli = await import('../../src/electron/libs/antigravity-cli');
  const { AntigravityAcpAdapter, antigravityToolInput, antigravityToolName, parseAntigravityUsage } = await import(
    '../../src/electron/libs/provider/antigravity-acp-adapter'
  );
  const policy = await import('../../src/shared/human-driven-providers');
  const { getProviderService } = await import('../../src/electron/libs/provider/service');

  let threadSeq = 0;
  const open = async (
    input: Record<string, unknown> = {},
    options: { stopGraceMs?: number; selfTurnSettleMs?: number; selfTurnIdleMs?: number } = {}
  ) => {
    const adapter = new AntigravityAcpAdapter({ ...options, stopGraceMs: options.stopGraceMs ?? 400 });
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => events.push(event));
    const threadId = `t${++threadSeq}`;
    const session = await withTimeout(
      adapter.startSession({ provider: 'antigravity', threadId, cwd, prompt: '', ...input } as never),
      'startSession'
    );
    return { adapter, events, threadId, session };
  };
  const turnDone = (events: Event[], count = 1) =>
    until(() => results(events).length >= count, `result #${count}`);

  // ── The rule: only a person drives it ────────────────────────────────────
  {
    assert.equal(policy.isHumanDrivenOnlyProvider('antigravity'), true);
    assert.equal(policy.isHumanDrivenOnlyProvider('claude'), false);
    assert.equal(policy.humanDrivenOnlyRefusal('antigravity', 'user'), null, 'a typed message goes through');
    assert.match(policy.humanDrivenOnlyRefusal('antigravity', 'app') ?? '', /only takes messages you type/);
    assert.ok(policy.humanDrivenOnlyRefusal('antigravity', 'user', true), 'a prompt the app wrote is refused whoever relays it');
    assert.equal(policy.humanDrivenOnlyRefusal('claude', 'app', true), null, 'other agents are not affected');
    assert.equal(policy.humanDrivenOnlyRefusal(undefined, 'app'), null);

    // No one-shot entry point, and the service refuses to fake one through a session.
    assert.equal((new AntigravityAcpAdapter() as { runOneShot?: unknown }).runOneShot, undefined);
    const service = getProviderService();
    service.registerAdapter(new AntigravityAcpAdapter());
    resetCalls();
    await assert.rejects(
      service.runOneShot({ provider: 'antigravity', threadId: 'title-1', cwd, prompt: 'Name this task' }),
      /only takes messages a person types/
    );
    assert.deepEqual(readCalls(), [], 'agy was not even started for a one-shot');
  }

  // ── CLI: detection and status ────────────────────────────────────────────
  {
    resetCalls();
    const status = await cli.getAntigravityRuntimeStatus(true);
    assert.equal(status.ready, true);
    assert.equal(status.cliAvailable, true);
    assert.equal(status.cliPath, fakeAgy);
    assert.equal(status.cliVersion, '1.5.14');
    assert.equal(status.acpAvailable, true);
    assert.equal(status.authState, 'ready', 'an ACP session opened, so agy is signed in');
    assert.equal(status.loginCommand, `${fakeAgy} acp --login`);
    assert.equal(status.cliPathOverride, fakeAgy);
    assert.match(status.installCommand, /antigravity\.google\/cli\/install/);

    // The catalog is what the ACP session reported, nothing else.
    const catalog = await cli.getAntigravityModelConfig();
    assert.deepEqual(catalog.availableModels, [
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
    assert.equal(catalog.defaultModel, 'gemini-4-neon');
    assert.deepEqual(catalog.modes.map((mode) => mode.id), ['default', 'accept-edits', 'auto', 'plan']);
    assert.equal(catalog.modes[1].label, 'Accept edits');
    assert.match(catalog.modes[1].description ?? '', /without asking/);
    assert.equal(catalog.defaultMode, 'default');
    assert.deepEqual(catalog.authMethods.map((method) => method.id), ['oauth-personal', 'gemini-api-key']);
    assert.equal(catalog.imagePrompts, true);
    assert.equal(catalog.agentVersion, '1.5.14');

    // Thinking levels are per model, read with one set_config_option each.
    assert.deepEqual(await cli.getAntigravityThoughtLevels(null), {
      model: 'gemini-4-neon',
      levels: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra' },
      ],
      defaultLevel: 'high',
    });
    const flash = await cli.getAntigravityThoughtLevels('gemini-3.8-flash');
    assert.deepEqual(flash.levels.map((level) => level.id), ['low', 'medium', 'high']);
    const plain = await cli.getAntigravityThoughtLevels('gpt-oss-120b-medium');
    assert.deepEqual(plain, { model: 'gpt-oss-120b-medium', levels: [], defaultLevel: null }, 'a model without thinking control');
    assert.equal((await cli.getAntigravityThoughtLevels('not-a-model')).failed, true, 'an unknown model is not "no thinking control"');

    const calls = readCalls();
    assert.ok(calls.some((call) => call.spawn), 'the probe started agy');
    for (const call of calls.filter((entry) => entry.spawn)) {
      assert.deepEqual(call.spawn?.args, ['acp'], 'agy is started with exactly `acp`');
    }
    assert.equal(calls.some((call) => call.badArgs), false);
    assert.equal(methods().includes('session/prompt'), false, 'reading the catalog never prompts');
    const init = calls.find((call) => call.method === 'initialize');
    assert.equal(init?.params?.protocolVersion, 1);
    assert.deepEqual(init?.params?.clientCapabilities, {}, 'no fs or terminal capability is claimed');
    assert.equal(init?.params?.clientInfo.name, 'aegis', 'Aegis says who it is');
    assert.deepEqual(calls.find((call) => call.method === 'session/new')?.params?.mcpServers, []);
  }

  // ── CLI: signed out, no ACP, a bad override ──────────────────────────────
  await withEnv({ FAKE_AGY_AUTH_REQUIRED: '1' }, async () => {
    const status = await cli.getAntigravityRuntimeStatus(true);
    assert.equal(status.cliAvailable, true);
    assert.equal(status.ready, false, 'a definitive sign-out blocks the agent');
    assert.equal(status.authState, 'login_required');
    assert.match(status.detail, /acp --login/);
    assert.match(cli.formatAntigravityRuntimeBlockingMessage(status), /sign-in required\. Run: .* acp --login/);
    assert.deepEqual((await cli.getAntigravityModelConfig()).availableModels, []);

    const adapter = new AntigravityAcpAdapter();
    await assert.rejects(
      adapter.startSession({ provider: 'antigravity', threadId: 'signed-out', cwd, prompt: 'hello' }),
      /Antigravity sign-in required\. Run: .* acp --login/
    );
    assert.equal(adapter.hasSession('signed-out'), false);
  });
  await withEnv({ FAKE_AGY_NO_ACP: '1' }, async () => {
    const status = await cli.getAntigravityRuntimeStatus(true);
    assert.equal(status.cliAvailable, true);
    assert.equal(status.acpAvailable, false);
    assert.equal(status.ready, false);
    assert.match(cli.formatAntigravityRuntimeBlockingMessage(status), /agy update/);
  });
  {
    assert.equal(cli.describeAntigravityCliPathProblem(''), null);
    assert.match(cli.describeAntigravityCliPathProblem('agy') ?? '', /full path/);
    assert.match(cli.describeAntigravityCliPathProblem(path.join(dir, 'missing')) ?? '', /No file/);
    assert.match(cli.describeAntigravityCliPathProblem(dir) ?? '', /not a file/);
    assert.equal(cli.describeAntigravityCliPathProblem(fakeAgy), null);

    // The Settings override: used as is, and a broken one is reported rather
    // than quietly replaced by another agy.
    delete process.env.ANTIGRAVITY_CLI_PATH;
    cli.setAntigravityCliPathSource(() => path.join(dir, 'missing'));
    const broken = await cli.getAntigravityRuntimeStatus();
    assert.equal(broken.cliAvailable, false);
    assert.equal(broken.cliPathOverride, path.join(dir, 'missing'));
    assert.match(broken.summary, /path is not usable/);
    assert.match(cli.formatAntigravityRuntimeBlockingMessage(broken), /Settings/);
    assert.equal(await cli.resolveAntigravityBinary(), null);
    cli.setAntigravityCliPathSource(() => fakeAgy);
    assert.equal(await cli.resolveAntigravityBinary(), fakeAgy);
    assert.equal((await cli.getAntigravityRuntimeStatus()).ready, true);
    cli.setAntigravityCliPathSource(() => '');
    process.env.ANTIGRAVITY_CLI_PATH = fakeAgy;
    cli.invalidateAntigravityCaches();
    // Every probe closed its session and agy exited on end of input; none
    // was killed. (Also keeps their last calls out of the logs read below.)
    await until(
      () => readCalls().filter((call) => call.exit).length >= readCalls().filter((call) => call.spawn).length,
      'the catalog probes exiting'
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  {
    assert.equal(antigravityToolName({ name: 'run_command', kind: 'execute' }), 'Bash');
    assert.equal(antigravityToolName({ name: 'write_file', kind: 'edit' }), 'Write');
    assert.equal(antigravityToolName({ name: 'some_reader', kind: 'read' }), 'Read', 'an unknown tool is named by its ACP kind');
    assert.equal(antigravityToolName({ name: 'mystery', kind: 'other' }), 'mystery');
    assert.deepEqual(antigravityToolInput('Bash', { rawInput: { CommandLine: 'ls', toolSummary: 'List' } }), {
      CommandLine: 'ls',
      toolSummary: 'List',
      command: 'ls',
      description: 'List',
    });
    assert.equal(antigravityToolInput('Read', { rawInput: {}, locations: [{ path: '/a/b.ts' }] }).file_path, '/a/b.ts');
    assert.deepEqual(parseAntigravityUsage({ inputTokens: 5, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 0, totalTokens: 10 }), {
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalTokens: 10,
    });
    assert.equal(parseAntigravityUsage(undefined), null);
  }

  // ── A plain turn ─────────────────────────────────────────────────────────
  {
    resetCalls();
    const { adapter, events, threadId, session } = await open({ prompt: 'hello' });
    assert.equal(session.provider, 'antigravity');
    assert.equal(session.model, 'gemini-4-neon');
    await turnDone(events);

    const init = events.find((event) => event.type === 'system_init');
    assert.equal(init?.sessionId, session.providerSessionId);
    assert.deepEqual(blocks(events, 'text').map((block) => block.text), ['echo: hello']);
    const deltas = messages(events).filter((message) => message.type === 'stream_event');
    assert.equal(deltas.length, 1, 'text streams as deltas before the committed message');
    const [result] = results(events);
    assert.equal(result.subtype, 'success');
    assert.deepEqual(result.usage, {
      input_tokens: 12000,
      output_tokens: 40,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 0,
      total_tokens: 20040,
    });
    assert.equal(result.costSource, 'unavailable', 'agy reports no cost and none is made up');
    assert.equal(result.total_cost_usd, 0);
    assert.equal(result.model, 'gemini-4-neon');
    assert.equal(result.modelLabel, 'Gemini 4 Neon');
    assert.equal(result.thoughtLevel, 'high');
    assert.equal(result.thoughtLevelLabel, 'High');
    assert.equal(events.at(-1)?.type, 'status_change');
    assert.equal(events.at(-1)?.status, 'completed');

    // Slash commands and the context ring arrive from agy's own pushes.
    const commands = messages(events).find((message) => message.subtype === 'available_commands_update');
    assert.deepEqual(commands?.availableCommands.map((command: { name: string }) => command.name), ['plan', 'compact']);
    const ring = messages(events).filter((message) => message.subtype === 'token_usage').at(-1);
    assert.equal(ring?.provider, 'antigravity');
    assert.equal(ring?.usage.contextWindow, 1048576);

    const calls = readCalls();
    assert.deepEqual(calls.find((call) => call.spawn)?.spawn, { args: ['acp'], cwd: calls.find((call) => call.spawn)?.spawn?.cwd });
    assert.ok(calls.find((call) => call.spawn)?.spawn?.cwd.endsWith('project'), 'agy runs in the project folder');
    const prompt = calls.find((call) => call.method === 'session/prompt');
    assert.deepEqual(prompt?.params?.prompt, [{ type: 'text', text: 'hello' }], 'the prompt goes out as typed');
    assert.deepEqual(calls.find((call) => call.method === 'session/new')?.params, { cwd, mcpServers: [] }, 'no Aegis tools are attached');
    assert.deepEqual(methods(), ['initialize', 'session/new', 'session/prompt'], 'nothing else is asked of agy');

    // Closing the session closes agy's input and it exits by itself.
    await adapter.stopSession(threadId);
    await until(() => readCalls().some((call) => call.exit === 'stdin closed'), 'agy exiting on end of input');
    assert.equal(adapter.hasSession(threadId), false);
  }

  // ── Model, thinking level and mode come from the session's own offer ─────
  {
    resetCalls();
    const { adapter, events, threadId } = await open({
      prompt: 'hello',
      model: 'gemini-3.8-flash',
      antigravityThoughtLevel: 'low',
      antigravityPermissionMode: 'accept-edits',
    });
    await turnDone(events);
    const setCalls = readCalls().filter((call) => call.method === 'session/set_config_option' || call.method === 'session/set_mode');
    assert.deepEqual(setCalls.map((call) => [call.method, call.params?.configId ?? 'mode', call.params?.value ?? call.params?.modeId]), [
      ['session/set_config_option', 'model', 'gemini-3.8-flash'],
      ['session/set_config_option', 'thought_level', 'low'],
      ['session/set_mode', 'mode', 'accept-edits'],
    ]);
    const [result] = results(events);
    assert.equal(result.model, 'gemini-3.8-flash');
    assert.equal(result.thoughtLevel, 'low');

    // What agy does not offer is never sent: a mode from another agent, a
    // model it does not list, a level the model lacks.
    resetCalls();
    await withTimeout(
      adapter.sendTurn({
        threadId,
        prompt: 'again',
        model: 'claude-fable-5-2',
        antigravityThoughtLevel: 'xhigh',
        antigravityPermissionMode: 'bypassPermissions',
      } as never),
      'sendTurn'
    );
    assert.deepEqual(methods(), ['session/prompt'], 'no set call for values agy does not offer');
    assert.equal(results(events)[1].model, 'gemini-3.8-flash', 'the session keeps its model');

    // A model without thinking control: no level is sent or reported.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'plain', model: 'gpt-oss-120b-medium' } as never), 'sendTurn');
    assert.equal(results(events)[2].model, 'gpt-oss-120b-medium');
    assert.equal(results(events)[2].thoughtLevel, undefined);
    // An empty model means Default: back to the model the session opened on.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'default' } as never), 'sendTurn');
    assert.equal(results(events)[3].model, 'gemini-4-neon');
    await adapter.stopSession(threadId);
  }

  // ── Approvals ────────────────────────────────────────────────────────────
  {
    resetCalls();
    const { adapter, events, threadId } = await open({ prompt: 'WRITE then RUN' });
    await until(() => events.some((event) => event.type === 'permission_request'), 'the edit approval');
    const edit = events.find((event) => event.type === 'permission_request')!;
    assert.equal(edit.toolName, 'Write');
    assert.equal(edit.input.kind, 'acp-permission');
    assert.equal(edit.input.provider, 'antigravity');
    assert.deepEqual(edit.input.options.map((option: { optionId: string; kind: string }) => [option.optionId, option.kind]), [
      ['allow', 'allow_once'],
      ['deny', 'reject_once'],
    ]);
    assert.ok(edit.input.toolCall.rawInput.file_path.endsWith('hello.txt'));
    assert.equal(edit.input.toolCall.rawInput.content, 'hello\n');
    assert.equal(edit.input.toolCall.content[0].type, 'diff', 'the card gets the diff agy sent');
    assert.equal(results(events).length, 0, 'the turn waits for the person');
    await adapter.respondToRequest(threadId, edit.requestId, { behavior: 'allow', updatedInput: {} } as never);

    await until(() => events.filter((event) => event.type === 'permission_request').length === 2, 'the command approval');
    const command = events.filter((event) => event.type === 'permission_request')[1];
    assert.equal(command.toolName, 'Bash');
    assert.equal(command.input.question, 'cat hello.txt');
    // The card's explicit option wins over the allow/deny default.
    await adapter.respondToRequest(threadId, command.requestId, { behavior: 'allow', updatedInput: { optionId: 'allow' } } as never);
    await turnDone(events);

    assert.deepEqual(readCalls().filter((call) => call.permission).map((call) => call.permission.outcome), [
      { outcome: 'selected', optionId: 'allow' },
      { outcome: 'selected', optionId: 'allow' },
    ]);
    const uses = blocks(events, 'tool_use');
    const write = uses.filter((block) => block.id === 'call_write_1').at(-1)!;
    assert.equal(write.name, 'Write');
    assert.ok(write.input.file_path.endsWith('hello.txt'));
    assert.equal(write.input.content, 'hello\n');
    const run = uses.filter((block) => block.id === 'call_run_2').at(-1)!;
    assert.equal(run.name, 'Bash');
    assert.equal(run.input.command, 'cat hello.txt');
    assert.equal(run.input.description, 'Display hello.txt content');
    const toolResults = blocks(events, 'tool_result');
    assert.deepEqual(toolResults.map((block) => [block.tool_use_id, block.is_error]), [
      ['call_write_1', false],
      ['call_run_2', false],
    ]);
    assert.match(toolResults[1].content, /Command output:\nhello/);
    // Narration before the call and the answer after it are separate blocks.
    assert.deepEqual(blocks(events, 'text').map((block) => block.text), ['Writing the file. ', 'done']);
    assert.equal(results(events)[0].subtype, 'success');

    // Deny: agy is told, and the call's card ends as failed.
    resetCalls();
    void adapter.sendTurn({ threadId, prompt: 'WRITE' } as never);
    await until(() => events.filter((event) => event.type === 'permission_request').length === 3, 'the second edit approval');
    const denied = events.filter((event) => event.type === 'permission_request')[2];
    await adapter.respondToRequest(threadId, denied.requestId, { behavior: 'deny', message: 'no' } as never);
    await turnDone(events, 2);
    assert.deepEqual(readCalls().find((call) => call.permission)?.permission.outcome, { outcome: 'selected', optionId: 'deny' });
    assert.equal(blocks(events, 'tool_result').at(-1)?.is_error, true);
    // An answer for a request already settled is ignored.
    await adapter.respondToRequest(threadId, denied.requestId, { behavior: 'allow', updatedInput: {} } as never);
    await adapter.stopSession(threadId);
  }

  // ── An edit's diff holds the whole file: the card gets the passage ───────
  {
    const line = (index: number) => `  const entry${index} = table[${index}] ?? fallback;`;
    const changed = '  const entry9000 = changed;';
    const size = (value: unknown) => JSON.stringify(value).length;

    // agy names the passage in its arguments and sends the file twice in the diff.
    const { adapter, events, threadId } = await open({ prompt: 'WHOLEFILE' });
    await until(() => events.some((event) => event.type === 'permission_request'), 'the edit approval');
    const approval = events.find((event) => event.type === 'permission_request')!;
    assert.equal(approval.toolName, 'Edit');
    assert.equal(approval.input.toolCall.rawInput.old_string, line(9000));
    assert.equal(approval.input.toolCall.rawInput.new_string, changed);
    const approvalDiff = approval.input.toolCall.content[0];
    assert.equal(approvalDiff.type, 'diff');
    assert.ok(approvalDiff.path.endsWith('big.ts'));
    assert.equal(approvalDiff.oldText, [8997, 8998, 8999, 9000, 9001, 9002, 9003].map((index) => `${line(index)}\n`).join(''));
    assert.ok(approvalDiff.newText.includes(changed));
    assert.ok(size(approval) < 4_000, `the approval is ${size(approval)} characters, not the file twice`);
    await adapter.respondToRequest(threadId, approval.requestId, { behavior: 'allow', updatedInput: {} } as never);
    await turnDone(events);

    const uses = blocks(events, 'tool_use').filter((block) => block.id === 'call_whole_1');
    assert.equal(uses.length, 1, 'the diff arriving later does not change the card, so it is not sent again');
    assert.equal(uses[0].name, 'Edit');
    assert.ok(uses[0].input.file_path.endsWith('big.ts'));
    assert.equal(uses[0].input.old_string, line(9000));
    assert.equal(uses[0].input.new_string, changed);
    // The fake sent the 600 KB file six times over; none of it reaches the host.
    assert.ok(size(events) < 20_000, `the turn's events are ${size(events)} characters`);

    // A tool that describes its edit by the diff alone: the lines that changed, with context.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'WHOLEDIFF' } as never), 'sendTurn');
    const byDiff = blocks(events, 'tool_use').filter((block) => block.id === 'call_diff_2').at(-1)!;
    assert.equal(byDiff.name, 'Edit');
    assert.ok(byDiff.input.file_path.endsWith('big.ts'));
    assert.equal(byDiff.input.old_string, [8997, 8998, 8999, 9000, 9001, 9002, 9003].map((index) => `${line(index)}\n`).join(''));
    assert.equal(
      byDiff.input.new_string,
      [line(8997), line(8998), line(8999), changed, line(9001), line(9002), line(9003)].map((text) => `${text}\n`).join('')
    );
    assert.ok(size(events) < 40_000, `both turns' events are ${size(events)} characters`);
    await adapter.stopSession(threadId);

    // Arguments the diff does not bear out give way to the diff.
    const file = Array.from({ length: 40 }, (_, index) => `row ${index}`);
    const edited = file.map((row, index) => (index === 20 ? 'row twenty' : row));
    const diff = { type: 'diff', path: '/p/rows.txt', oldText: `${file.join('\n')}\n`, newText: `${edited.join('\n')}\n` };
    assert.deepEqual(
      antigravityToolInput('Edit', { rawInput: { Path: '/p/rows.txt', Target: 'not in the file', Replacement: 'x' }, content: [diff] }),
      {
        Path: '/p/rows.txt',
        Target: 'not in the file',
        Replacement: 'x',
        file_path: '/p/rows.txt',
        old_string: 'row 17\nrow 18\nrow 19\nrow 20\nrow 21\nrow 22\nrow 23\n',
        new_string: 'row 17\nrow 18\nrow 19\nrow twenty\nrow 21\nrow 22\nrow 23\n',
      }
    );
    // Before the diff arrives the arguments are all there is; once it does, the card is the same.
    const args = { Path: '/p/rows.txt', Target: 'row 20', Replacement: 'row twenty' };
    const early = antigravityToolInput('Edit', { rawInput: args });
    assert.equal(early.old_string, 'row 20');
    assert.equal(early.new_string, 'row twenty');
    assert.deepEqual(antigravityToolInput('Edit', { rawInput: args, content: [diff] }), early);
    // A new file has no old text to cut down.
    assert.equal(antigravityToolInput('Edit', { content: [{ type: 'diff', path: '/p/new.txt', newText: 'hello\n' }] }).old_string, '');
  }

  // ── A background command: agy goes on by itself after the turn ───────────
  {
    /** What the host is told, in order, without the streamed increments. */
    const story = (events: Event[]): string[] =>
      events.flatMap((event) => {
        if (event.type === 'status_change') return [`status ${event.status}`];
        if (event.type === 'error') return ['error'];
        if (event.type !== 'message') return [];
        const message = event.message;
        if (message.type === 'result') return [`result ${message.subtype}`];
        if (message.type === 'system' && message.subtype === 'init') return [message.selfStarted ? 'init by itself' : 'init'];
        if (message.type !== 'assistant') return [];
        const block = message.message.content[0];
        if (block.type === 'tool_use') return [`call ${block.id}`];
        if (block.type === 'tool_result') return [`result of ${block.tool_use_id}: ${block.content}`];
        return [`${block.type}: ${block.text ?? block.thinking}`];
      });
    const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const woke = (events: Event[]) => story(events).includes('init by itself');

    // The turn ends with the command still running; agy takes the rest up by
    // itself. That work is a turn of its own: it opens marked as agy's own,
    // sets the task running, commits what it wrote and ends with a result.
    const { adapter, events, threadId, session } = await open({ prompt: 'BACKGROUND' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
    await turnDone(events, 2);
    await quiet(400);
    assert.deepEqual(story(events).slice(story(events).indexOf('status running')), [
      'status running',
      'thinking: I will start the build.',
      'call call_bg_1',
      'text: Started the build; waiting for it to finish.',
      // The call is still open when the turn ends: its card is settled for now.
      'result of call_bg_1: npm run build',
      'result success',
      'status completed',
      // The command reports back between turns: its card gets the real output.
      'result of call_bg_1: built in 63s',
      'status running',
      'init by itself',
      'thinking: The build finished.',
      'call call_check_2',
      'result of call_check_2: app.dmg',
      // The step's usage_update was followed by a call at once: no end there.
      // The last one was followed by nothing: the words are committed, then the result.
      'text: Checking the artefact. The build is done: app.dmg.',
      'result success',
      'status completed',
    ]);
    const settled = messages(events).filter((message) => message.uuid === `antigravity-tool-result:${threadId}:call_bg_1`);
    assert.equal(settled.length, 2, 'the real outcome replaces the stand-in under the same id');
    assert.equal(settled[0].createdAt, settled[1].createdAt, 'and at the same place in the transcript');
    const wokenInit = messages(events).find((message) => message.type === 'system' && message.selfStarted);
    assert.equal(wokenInit?.session_id, session.providerSessionId);
    assert.equal(wokenInit?.model, 'gemini-4-neon');
    assert.ok(results(events)[0].usage.total_tokens > 0);
    assert.equal(results(events)[1].usage.total_tokens, 0, 'no prompt response reports what agy used by itself');
    assert.equal(adapter.listSessions()[0].status, 'completed');

    // The next message is an ordinary turn again, with nothing left over.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'plain' } as never), 'sendTurn');
    assert.deepEqual(story(events).slice(-4), ['status running', 'text: echo: plain', 'result success', 'status completed']);
    await adapter.stopSession(threadId);

    // agy speaks again after a pause longer than the wait: one more turn of its own.
    {
      const twice = await open({ prompt: 'BACKGROUND WAKE_TWICE' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
      await turnDone(twice.events, 3);
      assert.deepEqual(story(twice.events).slice(-5), ['status running', 'init by itself', 'text: One more note.', 'result success', 'status completed']);
      await twice.adapter.stopSession(twice.threadId);
    }

    // A message sent while agy works by itself takes the work over: what agy
    // wrote is kept, and the one result is the prompt's.
    {
      const held = await open({ prompt: 'BACKGROUND WAKE_HOLD' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 60_000 });
      await until(() => story(held.events).includes('result of call_check_2: app.dmg'), 'agy working by itself');
      await quiet(400);
      assert.equal(results(held.events).length, 1, 'in the middle of a step there is no end to report');
      assert.equal(held.adapter.listSessions()[0].status, 'running');
      await withTimeout(held.adapter.sendTurn({ threadId: held.threadId, prompt: 'plain' } as never), 'sendTurn');
      assert.deepEqual(story(held.events).slice(story(held.events).indexOf('init by itself')), [
        'init by itself',
        'thinking: The build finished.',
        'call call_check_2',
        'result of call_check_2: app.dmg',
        'text: Checking the artefact. ',
        'status running',
        'text: echo: plain',
        'result success',
        'status completed',
      ]);
      await held.adapter.stopSession(held.threadId);
    }

    // Stop reaches work agy started by itself, and nothing is reported after it.
    {
      const stopped = await open({ prompt: 'BACKGROUND WAKE_HOLD' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 300 });
      await until(() => woke(stopped.events), 'agy working by itself');
      resetCalls();
      await stopped.adapter.stopSession(stopped.threadId);
      await until(() => methods().includes('session/cancel'), 'agy is told to stop');
      const told = stopped.events.length;
      await quiet(500);
      assert.equal(stopped.events.length, told, 'a stopped session reports nothing more');
    }

    // Silence in the middle of a step ends the turn after the long wait.
    {
      const silent = await open({ prompt: 'BACKGROUND WAKE_HOLD' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 300 });
      await turnDone(silent.events, 2);
      assert.deepEqual(story(silent.events).slice(-3), ['text: Checking the artefact. ', 'result success', 'status completed']);
      await silent.adapter.stopSession(silent.threadId);
    }

    // agy dies while working by itself: the turn ends as failed, with the reason.
    {
      const crashed = await open({ prompt: 'BACKGROUND WAKE_CRASH' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
      await turnDone(crashed.events, 2);
      assert.deepEqual(story(crashed.events).slice(-3), ['text: Checking the artefact. ', 'result error', 'error']);
      assert.match(crashed.events.at(-1)!.error.message, /exited during the turn \(code 3\).*panic: fake agy crashed/);
      crashed.adapter.disposeSession(crashed.threadId);
    }

    // The response to a prompt and what agy sends right after it can arrive
    // in one read. The response ends the turn first: what follows is agy's own.
    {
      const now = await open({ prompt: 'BACKGROUND WAKE_NOW' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
      await turnDone(now.events, 2);
      const told = story(now.events);
      assert.deepEqual(told.slice(told.indexOf('result success')), [
        'result success',
        'status completed',
        'result of call_bg_1: built in 63s',
        'status running',
        'init by itself',
        'thinking: The build finished.',
        'call call_check_2',
        'result of call_check_2: app.dmg',
        'text: Checking the artefact. The build is done: app.dmg.',
        'result success',
        'status completed',
      ]);
      await now.adapter.stopSession(now.threadId);
    }

    // agy repeats a call it is still running after the turn settled it for
    // now: the repeat keeps the stand-in replaceable, and the real outcome lands.
    {
      const resent = await open({ prompt: 'BACKGROUND WAKE_RESEND' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
      await turnDone(resent.events, 2);
      const outcomes = story(resent.events).filter((line) => line.startsWith('result of call_bg_1'));
      assert.deepEqual(outcomes, ['result of call_bg_1: npm run build', 'result of call_bg_1: built in 63s']);
      await resent.adapter.stopSession(resent.threadId);
    }

    // Two calls in one step: the quick one finishing is not a reason to stop
    // waiting for the slow one, however long the silence. (The silence here
    // is twice the wait that ends a turn in the middle of a step.)
    {
      const parallel = await open({ prompt: 'BACKGROUND WAKE_PARALLEL' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 300 });
      await turnDone(parallel.events, 2);
      const told = story(parallel.events);
      assert.deepEqual(told.slice(told.indexOf('init by itself')), [
        'init by itself',
        'thinking: The build finished.',
        'call call_check_2',
        'call call_slow_3',
        'result of call_check_2: app.dmg',
        // Its real output, not a stand-in from a turn ended too early.
        'result of call_slow_3: signed',
        'text: Checking the artefact. The build is done: app.dmg.',
        'result success',
        'status completed',
      ]);
      await parallel.adapter.stopSession(parallel.threadId);
    }

    // An update that only renames a finished call says nothing about the
    // turn: the end that was due still comes.
    {
      const retitled = await open({ prompt: 'BACKGROUND WAKE_RETITLE' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 60_000 });
      await turnDone(retitled.events, 2);
      assert.deepEqual(story(retitled.events).slice(-2), ['result success', 'status completed']);
      await retitled.adapter.stopSession(retitled.threadId);
    }

    // The host announces a prompt (yieldToPrompt) before it shows it: agy's
    // own work ends there without a result of its own, its words committed.
    {
      const yielded = await open({ prompt: 'BACKGROUND WAKE_HOLD' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 60_000 });
      await until(() => story(yielded.events).includes('result of call_check_2: app.dmg'), 'agy working by itself');
      await quiet(100);
      yielded.adapter.yieldToPrompt(yielded.threadId);
      assert.equal(story(yielded.events).at(-1), 'text: Checking the artefact. ', 'committed at once, before the prompt is shown');
      await quiet(400);
      assert.equal(results(yielded.events).length, 1, 'and nothing of it ends a turn afterwards');
      await withTimeout(yielded.adapter.sendTurn({ threadId: yielded.threadId, prompt: 'plain' } as never), 'sendTurn');
      assert.deepEqual(story(yielded.events).slice(-4), ['status running', 'text: echo: plain', 'result success', 'status completed']);
      assert.equal(results(yielded.events).length, 2);
      await yielded.adapter.stopSession(yielded.threadId);

      // What agy sends between the announcement and the prompt opens no turn;
      // the prompt's turn takes it in.
      const gap = await open({ prompt: 'BACKGROUND WAKE_TWICE' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 60_000 });
      await turnDone(gap.events, 2);
      gap.adapter.yieldToPrompt(gap.threadId);
      await quiet(700);
      assert.equal(results(gap.events).length, 2);
      assert.equal(story(gap.events).filter((line) => line === 'init by itself').length, 1);
      await withTimeout(gap.adapter.sendTurn({ threadId: gap.threadId, prompt: 'plain' } as never), 'sendTurn');
      assert.deepEqual(story(gap.events).slice(-5), ['text: One more note.', 'status running', 'text: echo: plain', 'result success', 'status completed']);
      await gap.adapter.stopSession(gap.threadId);
    }

    // What a finished call carried is let go, turn after turn: the whole-file
    // texts of an edit's diff are never kept, and a finished call keeps nothing.
    {
      const lean = await open({ prompt: 'BACKGROUND WAKE_EDIT' }, { selfTurnSettleMs: 150, selfTurnIdleMs: 10_000 });
      await turnDone(lean.events, 2);
      const edit = blocks(lean.events, 'tool_use').filter((block) => block.id === 'call_edit_3');
      assert.equal(edit.length, 1, 'the diff arriving later leaves the card as it is');
      assert.equal(edit[0].input.new_string, '  const entry9000 = changed;');
      const kept = (lean.adapter as any).sessions.get(lean.threadId).toolCalls as Map<string, unknown>;
      assert.deepEqual([...kept.keys()], ['call_bg_1', 'call_check_2', 'call_edit_3']);
      assert.ok(JSON.stringify([...kept]).length < 1_500, `finished calls hold ${JSON.stringify([...kept]).length} characters`);
      // A prompt drops them; calls that may still report back are kept, the latest 32.
      const calls = (lean.adapter as any).sessions.get(lean.threadId).toolCalls as Map<string, Record<string, unknown>>;
      for (let index = 0; index < 40; index += 1) {
        calls.set(`left_${index}`, { name: 'Bash', title: 'sleep', source: {}, input: {}, createdAt: 1, output: '', settled: true, placeholder: true });
      }
      await withTimeout(lean.adapter.sendTurn({ threadId: lean.threadId, prompt: 'plain' } as never), 'sendTurn');
      const after = (lean.adapter as any).sessions.get(lean.threadId).toolCalls as Map<string, unknown>;
      assert.deepEqual([...after.keys()], Array.from({ length: 32 }, (_, index) => `left_${index + 8}`));
      await lean.adapter.stopSession(lean.threadId);
    }

    // A process that has exited, or one the session has moved on from, opens
    // no turn with what was still in its pipe.
    {
      const gone = await open({ prompt: 'plain EXIT_AFTER' });
      await turnDone(gone.events);
      const live = (gone.adapter as any).sessions.get(gone.threadId);
      await until(() => Boolean(live.dead), 'agy exited');
      const told = gone.events.length;
      const late = { update: { sessionUpdate: 'tool_call', toolCallId: 'call_late', name: 'run_command', kind: 'execute', title: 'ls', status: 'in_progress' } };
      (gone.adapter as any).handleNotification({ proc: live.proc, session: live }, 'session/update', late);
      assert.equal(gone.events.length, told, 'nothing from a dead process');
      assert.equal(live.selfTurn, undefined);
      // The next message reconnects; the old connection's leftovers still say nothing.
      const oldProc = live.proc;
      await withTimeout(gone.adapter.sendTurn({ threadId: gone.threadId, prompt: 'plain' } as never), 'sendTurn');
      const heard = gone.events.length;
      (gone.adapter as any).handleNotification({ proc: oldProc, session: live }, 'session/update', late);
      assert.equal(gone.events.length, heard, 'nothing from a connection the session left');
      await gone.adapter.stopSession(gone.threadId);
    }
  }

  // ── An edit that is more than the passage agy names ──────────────────────
  {
    const rows = Array.from({ length: 40 }, (_, index) => (index === 5 || index === 30 ? 'flag=false' : `row ${index}`));
    const text = (lines: string[]) => `${lines.join('\n')}\n`;
    const args = { Path: '/p/flags.txt', Target: 'flag=false', Replacement: 'flag=true' };
    // Both occurrences changed: the card shows both, not the one the arguments name.
    const both = antigravityToolInput('Edit', {
      rawInput: args,
      content: [{ type: 'diff', path: '/p/flags.txt', oldText: text(rows), newText: text(rows.map((row) => (row === 'flag=false' ? 'flag=true' : row))) }],
    });
    assert.equal(String(both.old_string).split('flag=false').length - 1, 2);
    assert.equal(String(both.new_string).split('flag=true').length - 1, 2);
    assert.ok(String(both.old_string).startsWith('row 2\n') && String(both.old_string).endsWith('row 33\n'));
    // The named passage changed and so did another line.
    const more = antigravityToolInput('Edit', {
      rawInput: args,
      content: [{ type: 'diff', path: '/p/flags.txt', oldText: text(rows), newText: text(rows.map((row, index) => (index === 5 ? 'flag=true' : index === 20 ? 'row twenty' : row))) }],
    });
    assert.ok(String(more.new_string).includes('flag=true') && String(more.new_string).includes('row twenty'));
    // Only the first occurrence changed: that one replacement is the whole edit.
    const first = antigravityToolInput('Edit', {
      rawInput: args,
      content: [{ type: 'diff', path: '/p/flags.txt', oldText: text(rows), newText: text(rows.map((row, index) => (index === 5 ? 'flag=true' : row))) }],
    });
    assert.equal(first.old_string, 'flag=false');
    assert.equal(first.new_string, 'flag=true');
    // Only the second occurrence changed: the arguments would point at the wrong line.
    const second = antigravityToolInput('Edit', {
      rawInput: args,
      content: [{ type: 'diff', path: '/p/flags.txt', oldText: text(rows), newText: text(rows.map((row, index) => (index === 30 ? 'flag=true' : row))) }],
    });
    assert.equal(second.old_string, 'row 27\nrow 28\nrow 29\nflag=false\nrow 31\nrow 32\nrow 33\n');
  }

  // ── The ACP client: a response before the lines that follow it ───────────
  {
    const { AcpJsonRpcClient } = await import('../../src/electron/libs/provider/acp-json-rpc-client');
    const { EventEmitter } = await import('node:events');
    const heardIn = async (options?: { responsesFirst?: boolean }) => {
      const order: string[] = [];
      const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      const proc = Object.assign(new EventEmitter(), { stdout, stdin: { writable: true, write() {} } });
      const rpc = new AcpJsonRpcClient(proc as never, (method) => order.push(method), () => undefined, () => undefined, options);
      const answered = rpc.request('session/prompt').then(() => order.push('the caller'));
      // One read: the response, two notifications, another response, a notification.
      const later = rpc.request('session/set_mode').then(() => order.push('the second caller'));
      stdout.emit(
        'data',
        '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"first"}\n{"jsonrpc":"2.0","method":"second"}\n{"jsonrpc":"2.0","id":2,"result":{}}\n{"jsonrpc":"2.0","method":"third"}\n{"jsonrpc":"2.0","method":"cut'
      );
      stdout.emit('data', ' off"}\n');
      await Promise.all([answered, later]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return order;
    };
    assert.deepEqual(await heardIn({ responsesFirst: true }), ['the caller', 'first', 'second', 'the second caller', 'third', 'cut off']);
    // Every other agent's client reads as it always did.
    assert.deepEqual(await heardIn(), ['first', 'second', 'third', 'cut off', 'the caller', 'the second caller']);
  }

  // ── Tools agy names differently, thinking, plans, its own title and mode ─
  {
    const { adapter, events, threadId } = await open({ prompt: 'THINK PLAN EDIT TITLE' });
    await turnDone(events);
    const edit = blocks(events, 'tool_use').filter((block) => block.id === 'call_edit_1').at(-1)!;
    assert.equal(edit.name, 'Edit', 'named by its ACP kind');
    assert.ok(edit.input.file_path.endsWith('hello.txt'), 'the file comes from the diff');
    assert.equal(edit.input.old_string, 'hello\n');
    assert.equal(edit.input.new_string, 'goodbye\n');
    assert.deepEqual(blocks(events, 'thinking').map((block) => block.thinking), ['Let me think.']);
    const plan = messages(events).find((message) => message.type === 'plan_update');
    assert.deepEqual(plan?.steps, [
      { step: 'Read the code', status: 'completed' },
      { step: 'Write the fix', status: 'inProgress' },
      { step: 'Run the tests', status: 'pending' },
    ]);
    const titles = events.filter((event) => event.type === 'session_title');
    assert.deepEqual(titles.map((event) => [event.provider, event.title]), [['antigravity', 'Fake Title From Agy']]);

    // agy switches mode by itself: the composer is told, and the next turn
    // does not switch it back unless the person picks another mode.
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'SWITCH_MODE TITLE' } as never), 'sendTurn');
    const changed = events.filter((event) => event.type === 'permission_mode_changed');
    assert.deepEqual(changed.map((event) => [event.provider, event.mode]), [['antigravity', 'plan']]);
    assert.equal(events.filter((event) => event.type === 'session_title').length, 1, 'an unchanged title is not repeated');
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'next' } as never), 'sendTurn');
    assert.equal(methods().includes('session/set_mode'), false, "agy's own switch is kept");
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'back', antigravityPermissionMode: 'default' } as never), 'sendTurn');
    assert.equal(readCalls().find((call) => call.method === 'session/set_mode')?.params?.modeId, 'default');
    assert.equal(events.filter((event) => event.type === 'permission_mode_changed').length, 1, 'a mode Aegis set is not reported back as agy\'s own');
    await adapter.stopSession(threadId);
  }

  // ── Images ───────────────────────────────────────────────────────────────
  {
    resetCalls();
    const image = path.join(dir, 'shot.png');
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { adapter, events, threadId } = await open({
      prompt: 'look',
      attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', path: image, mimeType: 'image/png' }],
    });
    await turnDone(events);
    assert.deepEqual(readCalls().find((call) => call.method === 'session/prompt')?.params?.prompt, [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    ]);
    await adapter.stopSession(threadId);
  }

  // ── Stop: cancel, the cancelled turn's usage, and a clean exit ───────────
  {
    resetCalls();
    const { adapter, events, threadId } = await open({ prompt: 'SLOW' });
    await until(() => methods().includes('session/prompt') && blocks(events, 'text').length + messages(events).filter((m) => m.type === 'stream_event').length > 0, 'the turn streaming');
    await withTimeout(adapter.stopSession(threadId), 'stopSession');
    assert.ok(methods().includes('session/cancel'), 'the turn is cancelled the ACP way');
    const unreported = events.filter((event) => event.type === 'usage_unreported');
    assert.equal(unreported.length, 1, 'what the cancelled turn used is kept for accounting');
    assert.equal(unreported[0].provider, 'antigravity');
    assert.equal(unreported[0].message.type, 'usage_record');
    assert.equal(unreported[0].message.usage.output_tokens, 5);
    assert.equal(unreported[0].message.costSource, 'unavailable');
    assert.equal(results(events).length, 0, 'a stopped turn has no result');
    assert.equal(adapter.hasSession(threadId), false);
    await until(() => readCalls().some((call) => call.exit === 'stdin closed'), 'agy exiting after the stop');

    // A stop while an approval is open: the card goes, and agy hears `cancelled`.
    resetCalls();
    const second = await open({ prompt: 'WRITE' });
    await until(() => second.events.some((event) => event.type === 'permission_request'), 'the approval');
    const request = second.events.find((event) => event.type === 'permission_request')!;
    await withTimeout(second.adapter.stopSession(second.threadId), 'stopSession');
    assert.deepEqual(second.events.filter((event) => event.type === 'permission_dismissed').map((event) => event.requestId), [request.requestId]);
    await until(() => readCalls().some((call) => call.permission), 'agy hearing the cancelled approval');
    assert.deepEqual(readCalls().find((call) => call.permission)?.permission.outcome, { outcome: 'cancelled' });
    assert.equal(results(second.events).length, 0);

    // A stop between turns reports nothing: the finished turn had its result.
    const quiet = await open({ prompt: 'hello' });
    await turnDone(quiet.events);
    await quiet.adapter.stopSession(quiet.threadId);
    assert.equal(quiet.events.filter((event) => event.type === 'usage_unreported').length, 0);
  }

  // ── Sends during a turn wait their turn and end in one result ────────────
  {
    resetCalls();
    const { adapter, events, threadId } = await open();
    const first = adapter.sendTurn({ threadId, prompt: 'one' } as never);
    const second = adapter.sendTurn({ threadId, prompt: 'two' } as never);
    await withTimeout(Promise.all([first, second]), 'both turns');
    assert.deepEqual(blocks(events, 'text').map((block) => block.text), ['echo: one', 'echo: two']);
    assert.equal(results(events).length, 1, 'the session never reads idle between queued sends');
    assert.equal(results(events)[0].usage.total_tokens, 40080, 'both turns are counted');
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/prompt').map((call) => call.params?.prompt[0].text),
      ['one', 'two']
    );
    await adapter.stopSession(threadId);
  }

  // ── Refusals and errors ──────────────────────────────────────────────────
  {
    const { adapter, events, threadId } = await open({ prompt: 'REFUSE' });
    await turnDone(events);
    assert.equal(results(events)[0].subtype, 'error', 'a refusal is not a success');
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'FAIL' } as never), 'sendTurn');
    assert.equal(results(events)[1].subtype, 'error');
    const error = events.filter((event) => event.type === 'error').at(-1);
    assert.equal(error?.error.message, 'Antigravity: Model is overloaded, try again later', "agy's own words");
    // The session is still usable.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'still here' } as never), 'sendTurn');
    assert.equal(results(events)[2].subtype, 'success');
    await adapter.stopSession(threadId);
  }

  // ── agy exits: during a turn, and between turns ──────────────────────────
  {
    resetCalls();
    const { adapter, events, threadId, session } = await open({ prompt: 'CRASH' });
    await turnDone(events);
    assert.equal(results(events)[0].subtype, 'error');
    const crash = events.filter((event) => event.type === 'error').at(-1);
    assert.match(crash?.error.message, /Antigravity \(agy acp\) exited during the turn \(code 3\)/);
    assert.match(crash?.error.message, /panic: fake agy crashed/, 'with what agy last said on stderr');
    assert.equal(adapter.hasSession(threadId), true, 'the thread survives its process');

    // The next message reopens the same session in a new process.
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'after the crash' } as never), 'sendTurn');
    assert.deepEqual(methods(), ['initialize', 'session/resume', 'session/prompt']);
    assert.equal(readCalls().find((call) => call.method === 'session/resume')?.params?.sessionId, session.providerSessionId);
    assert.equal(blocks(events, 'text').at(-1)?.text, 'echo: after the crash');
    assert.equal(events.filter((event) => event.type === 'system_init').length, 1, 'the same session: nothing new to store');

    // Exited quietly between turns: same recovery.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'EXIT_AFTER' } as never), 'sendTurn');
    await until(() => readCalls().filter((call) => call.spawn).length >= 1, 'the process');
    await new Promise((resolve) => setTimeout(resolve, 150));
    resetCalls();
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'once more', model: 'gemini-3.8-flash' } as never), 'sendTurn');
    assert.deepEqual(methods().slice(0, 3), ['initialize', 'session/resume', 'session/set_config_option'], 'the composer\'s model is applied again');
    assert.equal(results(events).at(-1)?.model, 'gemini-3.8-flash');
    assert.equal(results(events).at(-1)?.subtype, 'success');

    // agy no longer has the session: a fresh one replaces it and is announced.
    await withTimeout(adapter.sendTurn({ threadId, prompt: 'EXIT_AFTER' } as never), 'sendTurn');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await withEnv({ FAKE_AGY_FAIL_RESUME: '1', FAKE_AGY_SESSION_ID: 'agy-replacement' }, async () => {
      await withTimeout(adapter.sendTurn({ threadId, prompt: 'in a new session' } as never), 'sendTurn');
    });
    assert.equal(events.filter((event) => event.type === 'system_init').at(-1)?.sessionId, 'agy-replacement');
    assert.equal(results(events).at(-1)?.subtype, 'success');
    await adapter.stopSession(threadId);
  }

  // ── Reopening after an app restart ───────────────────────────────────────
  {
    resetCalls();
    const resumed = await open({ prompt: 'welcome back', resumeSessionId: 'agy-earlier' });
    await turnDone(resumed.events);
    assert.deepEqual(methods(), ['initialize', 'session/resume', 'session/prompt']);
    assert.equal(resumed.session.providerSessionId, 'agy-earlier');
    assert.deepEqual(readCalls().find((call) => call.method === 'session/resume')?.params, { sessionId: 'agy-earlier', cwd, mcpServers: [] });
    await resumed.adapter.stopSession(resumed.threadId);

    // An agy without session/resume: session/load, whose replay is not shown again.
    resetCalls();
    await withEnv({ FAKE_AGY_NO_RESUME: '1' }, async () => {
      const loaded = await open({ prompt: 'hello', resumeSessionId: 'agy-earlier' });
      await turnDone(loaded.events);
      assert.deepEqual(methods(), ['initialize', 'session/load', 'session/prompt']);
      assert.deepEqual(blocks(loaded.events, 'text').map((block) => block.text), ['echo: hello'], 'the replayed transcript is not emitted');
      await loaded.adapter.stopSession(loaded.threadId);
    });

    // A session agy no longer has does not brick the thread.
    await withEnv({ FAKE_AGY_FAIL_RESUME: '1', FAKE_AGY_SESSION_ID: 'agy-fresh' }, async () => {
      const fresh = await open({ prompt: 'hello', resumeSessionId: 'agy-gone' });
      assert.equal(fresh.session.providerSessionId, 'agy-fresh');
      await turnDone(fresh.events);
      await fresh.adapter.stopSession(fresh.threadId);
    });
  }

  // ── A start that is cancelled, and one that is superseded ────────────────
  await withEnv({ FAKE_AGY_SLOW_INIT: '1' }, async () => {
    resetCalls();
    const adapter = new AntigravityAcpAdapter();
    const starting = adapter.startSession({ provider: 'antigravity', threadId: 'cancelled', cwd, prompt: 'hello' });
    await until(() => methods().includes('initialize'), 'agy starting');
    assert.equal(adapter.disposeSession('cancelled'), true, 'a start still connecting is released');
    await assert.rejects(starting, /cancelled/);
    assert.equal(adapter.hasSession('cancelled'), false);
    await until(() => readCalls().some((call) => call.exit === 'stdin closed'), 'the cancelled start\'s process exiting');
    assert.equal(methods().includes('session/prompt'), false);
    assert.equal(adapter.disposeSession('cancelled'), false, 'idempotent');
  });
  {
    const { adapter, events, threadId } = await open({ prompt: 'hello' });
    await turnDone(events);
    assert.equal(adapter.listSessions().length, 1);
    assert.equal(adapter.disposeSession(threadId), true);
    assert.equal(adapter.listSessions().length, 0);
    await assert.rejects(adapter.sendTurn({ threadId, prompt: 'gone' } as never), /No Antigravity session/);
    await adapter.stopAll();
  }

  // ── Capabilities say what agy does, nothing more ─────────────────────────
  {
    const adapter = new AntigravityAcpAdapter();
    assert.deepEqual(adapter.capabilities, {
      sessionModelSwitch: true,
      skillDiscovery: false,
      pluginDiscovery: false,
      mcpServers: false,
      imageAttachments: true,
      forkThread: false,
      compactThread: false,
      planMode: true,
    });
    const composer = adapter.getComposerCapabilities();
    assert.equal(composer.supportsNativeSlashCommandDiscovery, true);
    assert.equal(composer.supportsSkillDiscovery, false);
    assert.deepEqual(await adapter.listSkills({} as never), { skills: [], source: 'antigravity-acp', cached: false });
  }

  // Across every case, agy was only ever started as `agy acp`.
  assert.equal(readCalls().some((call) => call.badArgs), false);

  console.log('antigravity-acp-adapter: all checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    // The catalog probe keeps agy for a moment for follow-up reads.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  });

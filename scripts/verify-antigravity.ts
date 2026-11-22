import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

/**
 * Checks that the Antigravity integration stays inside what Google allows for
 * a personal sign-in (Antigravity Additional Terms §6;
 * google-antigravity/antigravity-cli#1493): the unmodified `agy acp`, driven
 * by a person, with nothing else able to prompt it.
 *
 *   npx tsx scripts/verify-antigravity.ts
 *       The rules, checked against the source and the modules themselves.
 *       Starts nothing; this is what CI runs.
 *   npx tsx scripts/verify-antigravity.ts --live
 *       Also asks the agy on this machine what it offers, over ACP: version,
 *       sign-in state, models, modes. Sends no prompt.
 *   npx tsx scripts/verify-antigravity.ts --live --prompt "your message"
 *       Also runs one real turn through the adapter with the message you
 *       typed, asking you on the terminal for every approval, then closes
 *       the session. For a person at the keyboard; never run by CI.
 *       Optional: --model <id> --level <id> --mode <id> --cwd <dir>
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function count(source: string, pattern: RegExp): number {
  return (source.match(pattern) || []).length;
}

async function checkRules(): Promise<void> {
  const adapter = read('src/electron/libs/provider/antigravity-acp-adapter.ts');
  const cli = read('src/electron/libs/antigravity-cli.ts');
  const ipc = read('src/electron/ipc-handlers.ts');

  // 1. Only the unmodified binary, started as `agy acp`: no wrapper, no extra
  //    flags (also not --dangerously-skip-permissions), no other subcommand
  //    that runs a model (`-p`, `--print`).
  const spawns = [...adapter.matchAll(/spawn\(([^)]*)\)/g), ...cli.matchAll(/spawn\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(spawns.length, 2, 'agy is spawned in two places: a session and the catalog probe');
  for (const call of spawns) {
    assert.match(call, /^binary, \['acp'\], \{/, `agy must be started with exactly ['acp']: spawn(${call})`);
  }
  for (const [name, source] of [['adapter', adapter], ['cli', cli]] as const) {
    assert.doesNotMatch(source, /dangerously-skip-permissions|--print\b|'-p'|stream-json/, `${name}: no headless or auto-approve mode`);
    assert.doesNotMatch(source, /systemPrompt|system_prompt/, `${name}: agy's system identity is left alone`);
  }
  assert.deepEqual(
    [...cli.matchAll(/execFileText\(cliPath, (\[[^\]]*\])/g)].map((match) => match[1]),
    ["['--version']", "['acp', '--help']"],
    'the only other invocations are --version and acp --help'
  );

  // 2. Nothing of Aegis's is attached to the session, and no client
  //    capability is claimed that agy would then route through Aegis.
  assert.equal(count(adapter, /mcpServers: \[\]/g), 3, 'session/new, session/resume and session/load attach no MCP servers');
  assert.equal(count(adapter, /mcpServers: (?!\[\]|false,)/g), 0, 'and none anywhere else (the capability itself is false)');
  assert.match(adapter, /clientCapabilities: \{\},/, 'no fs or terminal capability');
  assert.doesNotMatch(adapter, /getSessionReaderHttpConfig|createBrowserUseSessionMcpDescriptor|createGrokAcpHttpMcpServer/, 'no Aegis MCP tools');

  // 3. Credentials stay with agy: neither module reads agy's files or names
  //    its storage, and the environment is passed through as is.
  assert.doesNotMatch(cli, /readFileSync|readdirSync|createReadStream/, 'the CLI module reads no file');
  assert.equal(count(adapter, /readFileSync\(/g), 1, 'the adapter reads one kind of file');
  assert.match(adapter, /data: readFileSync\(attachment\.path\)\.toString\('base64'\)/, 'an image the user attached');
  for (const [name, source] of [['adapter', adapter], ['cli', cli]] as const) {
    assert.doesNotMatch(source, /\.gemini|oauth_creds|google_accounts|keytar|safeStorage/, `${name}: agy's storage is never touched`);
    assert.doesNotMatch(source, /access_token|refresh_token|Bearer /i, `${name}: no token handling`);
    assert.doesNotMatch(source, /env\.(GEMINI_API_KEY|GOOGLE_[A-Z_]+|AGY_[A-Z_]+)\s*=/, `${name}: no credential is injected`);
  }
  assert.match(cli, /const env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env \};/, 'the user\'s own environment');
  assert.doesNotMatch(adapter, /homedir\(/, 'the adapter looks nowhere in the home folder');
  assert.equal(count(cli, /homedir\(\)/g), 2, 'the CLI module only to find the installed executable');
  assert.doesNotMatch(adapter, /session\/list|authenticate'/, 'no listing of agy\'s sessions, no sign-in on the user\'s behalf');

  // 4. No one-shot entry point: nothing can ask the adapter for a throwaway
  //    answer (a title, a summary), and the service refuses to fake one.
  assert.doesNotMatch(adapter, /runOneShot|discardSession/, 'the adapter has no one-shot');
  assert.match(
    read('src/electron/libs/provider/service.ts'),
    /if \(isHumanDrivenOnlyProvider\(provider\)\) \{\s*throw new Error/,
    'the provider service refuses one-shots for it'
  );

  // 5. Default-deny at the two functions every start and every turn go
  //    through: only the composer's client event says a person wrote the prompt.
  assert.equal(count(ipc, /handleSessionStart\(mainWindow, event\.payload, undefined, 'user'\)/g), 1);
  assert.equal(count(ipc, /handleSessionContinue\(mainWindow, event\.payload, undefined, 'user'\)/g), 1);
  assert.equal(count(ipc, /, 'user'\)/g), 2, "nothing else claims a prompt was typed by a person");
  assert.match(ipc, /origin: PromptOrigin = 'app'\n\): Promise<string \| null> \{/, 'a start says nothing: taken as the app\'s');
  assert.match(ipc, /origin: PromptOrigin = 'app',\n\): Promise<boolean> \{/, 'a turn says nothing: taken as the app\'s');
  const clientEvents = ipc.slice(ipc.indexOf('async function handleClientEvent('), ipc.indexOf("case 'session.editLatestPrompt'"));
  assert.ok(clientEvents.includes("case 'session.start':") && clientEvents.includes("'user'"), 'the `user` origin is set in the client-event handler');
  assert.equal(count(ipc, /handleClientEvent\(mainWindow, event, /g), 1, 'client events come from the renderer IPC only');
  const startAt = ipc.indexOf('async function handleSessionStart(');
  const startBody = ipc.slice(startAt, ipc.indexOf('async function startSession(', startAt));
  assert.ok(
    startBody.indexOf('humanDrivenOnlyRefusal(') > 0 && startBody.indexOf('humanDrivenOnlyRefusal(') < startBody.indexOf('startSession(mainWindow, payload, onCreated)'),
    'a start is refused before any session is created'
  );
  const continueAt = ipc.indexOf('async function handleSessionContinue(');
  const continueBody = ipc.slice(continueAt, ipc.indexOf('async function handleSessionContinueImpl(', continueAt));
  assert.ok(
    continueBody.indexOf('humanDrivenOnlyRefusal(') > 0 && continueBody.indexOf('humanDrivenOnlyRefusal(') < continueBody.indexOf('handleSessionContinueImpl(mainWindow, payload, internal)'),
    'a turn is refused before anything is written'
  );
  assert.match(continueBody, /payload\.provider \|\| sessions\.getSession\(payload\.sessionId\)\?\.provider/, 'checked against the agent the turn would run on');

  // 6. The prompt goes out as typed: no title one-shot, no handoff brief, no
  //    notes of Aegis's appended.
  assert.match(ipc, /const namedByOneShot = namesItself && !isHumanDrivenOnlyProvider\(chosenProvider\);/);
  assert.match(ipc, /if \(namedByOneShot\) \{\s*nameTaskWithItsAgent\(/);
  assert.equal(count(ipc, /nameTaskWithItsAgent\(/g), 2, 'the one call, and the function itself');
  assert.match(ipc, /const runnerPrompt = isHumanDrivenOnlyProvider\(chosenProvider\) \? effectiveRunnerPrompt/);
  assert.match(ipc, /const runnerPrompt = isHumanDrivenOnlyProvider\(nextProvider\) \? effectiveRunnerPrompt/);
  assert.match(ipc, /session\.handoff_pending === 1 && !isHumanDrivenOnlyProvider\(nextProvider\)/);
  assert.match(ipc, /if \(isHumanDrivenOnlyProvider\(targetProvider\)\) \{\s*return \{\s*ok: false as const,/, 'a handoff to it is refused');

  // 7. It is on no list of agents that something other than a person can
  //    start: workflows, delegation, the Feishu and remote bridges (which the
  //    main bot also uses), automations, session references, goal loops.
  const { PROVIDER_WORKFLOW_DECLARATIONS } = await import('../src/electron/libs/workflow/member-configs');
  assert.equal(PROVIDER_WORKFLOW_DECLARATIONS.some((entry) => (entry.provider as string) === 'antigravity'), false, 'not a workflow member, planner or parent');
  const { PROVIDERS: bridgeProviders } = await import('../src/electron/feishu/agent-settings');
  assert.equal((bridgeProviders as string[]).includes('antigravity'), false, 'not startable from Feishu or by the main bot');
  const { providerSchema } = await import('../src/shared/remote/protocol');
  assert.equal(providerSchema.safeParse('antigravity').success, false, 'not creatable from a remote device');
  const { supportsSessionReferences } = await import('../src/shared/session-links');
  assert.equal(supportsSessionReferences('antigravity'), false, 'no read_session tool');
  const delegate = read('src/electron/libs/delegate-service.ts');
  const delegateList = delegate.slice(delegate.indexOf('DELEGATE_TARGET_PROVIDERS'), delegate.indexOf('];', delegate.indexOf('DELEGATE_TARGET_PROVIDERS')));
  assert.doesNotMatch(delegateList, /antigravity/, 'not a delegation target');
  const automations = read('src/ui/components/AutomationsView.tsx');
  const automationList = automations.slice(automations.indexOf('const PROVIDERS'), automations.indexOf('];', automations.indexOf('const PROVIDERS')));
  assert.doesNotMatch(automationList, /antigravity/, 'not offered for automations');
  assert.match(read('src/electron/ipc/session-goal.ts'), /\['codex', 'claude', 'kimi'\]\.includes\(session\.provider/, 'no goal loop');
  assert.match(
    read('src/electron/libs/main-bot/index.ts'),
    /unavailable: isHumanDrivenOnlyProvider\(entry\.provider\)/,
    'the main bot is told it cannot give it work'
  );

  // 8. The policy itself, and that the adapter reports only what agy does.
  const policy = await import('../src/shared/human-driven-providers');
  assert.equal(policy.humanDrivenOnlyRefusal('antigravity', 'user'), null);
  for (const origin of ['app'] as const) assert.ok(policy.humanDrivenOnlyRefusal('antigravity', origin));
  assert.ok(policy.humanDrivenOnlyRefusal('antigravity', 'user', true));
  const { AntigravityAcpAdapter } = await import('../src/electron/libs/provider/antigravity-acp-adapter');
  const capabilities = new AntigravityAcpAdapter().capabilities;
  assert.equal(capabilities.mcpServers, false);
  assert.equal(capabilities.forkThread, false);
  assert.equal(capabilities.compactThread, false);
  assert.equal(capabilities.skillDiscovery, false);

  // 9. The person is told: the same notes in Settings as in the policy.
  const notes = policy.ANTIGRAVITY_USAGE_NOTES.join('\n');
  for (const phrase of ['unmodified `agy acp`', 'You type every message', 'Workflows, automations', '`agy acp --login`', 'never reads, copies or stores', 'no transcripts', 'Gemini API key or Vertex AI']) {
    assert.ok(notes.includes(phrase), `the usage notes say: ${phrase}`);
  }
  assert.match(read('src/ui/components/settings/AntigravitySettingsPanel.tsx'), /ANTIGRAVITY_USAGE_NOTES\.map/);
  assert.match(read('src/ui/components/settings/AgentRuntimeSettings.tsx'), /<AntigravitySettingsPanel /);

  console.log('verify-antigravity: usage rules hold (9 groups)');
}

async function checkLive(): Promise<void> {
  const cli = await import('../src/electron/libs/antigravity-cli');
  const status = await cli.getAntigravityRuntimeStatus(true);
  console.log(`agy: ${status.cliPath ?? 'not found'}${status.cliVersion ? ` (${status.cliVersion})` : ''}`);
  console.log(`status: ${status.summary} ${status.detail}`);
  if (!status.cliAvailable) {
    console.log(`install: ${status.installCommand}`);
    process.exitCode = 1;
    return;
  }
  if (!status.ready) {
    console.log(`sign in: ${status.loginCommand}`);
    process.exitCode = 1;
    return;
  }
  const catalog = await cli.getAntigravityModelConfig();
  console.log(`ACP agent version: ${catalog.agentVersion}`);
  console.log(`models (${catalog.availableModels.length}): ${catalog.availableModels.map((model) => model.id).join(', ')}`);
  console.log(`default model: ${catalog.defaultModel}`);
  const levels = await cli.getAntigravityThoughtLevels(null);
  console.log(`thinking levels of the default model: ${levels.levels.map((level) => level.id).join(', ') || 'none'} (default ${levels.defaultLevel})`);
  console.log(`modes: ${catalog.modes.map((mode) => mode.id).join(', ')} (starts in ${catalog.defaultMode})`);
  console.log(`sign-in methods: ${catalog.authMethods.map((method) => method.id).join(', ')}`);
  console.log(`image prompts: ${catalog.imagePrompts}`);
  assert.ok(catalog.availableModels.length > 0, 'agy offers at least one model');
  assert.ok(catalog.modes.length > 0, 'agy offers at least one mode');
  console.log('verify-antigravity: live handshake ok (no prompt was sent)');

  const prompt = option('--prompt');
  if (prompt) await runTurn(prompt);
  cli.invalidateAntigravityCaches();
}

/** One real turn with the message a person typed on the command line. */
async function runTurn(prompt: string): Promise<void> {
  const { AntigravityAcpAdapter } = await import('../src/electron/libs/provider/antigravity-acp-adapter');
  const adapter = new AntigravityAcpAdapter();
  const cwd = path.resolve(option('--cwd') || process.cwd());
  const threadId = 'verify-antigravity';
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let text = '';
  const done = new Promise<{ subtype: string; usage: unknown; model?: string }>((resolve, reject) => {
    adapter.events.on('event', (event: any) => {
      if (event.type === 'permission_request') {
        const question = `\n[approval] ${event.toolName}: ${event.input.question}\n  allow? (y/N) `;
        void terminal.question(question).then((answer) =>
          adapter.respondToRequest(threadId, event.requestId, /^y(es)?$/i.test(answer.trim())
            ? { behavior: 'allow', updatedInput: {} }
            : { behavior: 'deny', message: 'Denied at the terminal.' })
        );
      } else if (event.type === 'error') {
        reject(event.error);
      } else if (event.type === 'message') {
        const message = event.message;
        if (message.type === 'stream_event' && message.event.delta.text) {
          text += message.event.delta.text;
          process.stdout.write(message.event.delta.text);
        } else if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') console.log(`\n[tool] ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
          }
        } else if (message.type === 'result') {
          resolve(message);
        }
      }
    });
  });
  console.log(`\n> ${prompt}\n`);
  const session = await adapter.startSession({
    provider: 'antigravity',
    threadId,
    cwd,
    prompt,
    model: option('--model'),
    antigravityThoughtLevel: option('--level'),
    antigravityPermissionMode: option('--mode'),
  });
  try {
    const result = await done;
    console.log(`\n\nsession: ${session.providerSessionId}`);
    console.log(`result: ${result.subtype}, model ${result.model}, usage ${JSON.stringify(result.usage)}`);
    assert.equal(result.subtype, 'success');
    assert.ok(text.trim().length > 0, 'agy answered');
  } finally {
    terminal.close();
    const proc = (adapter as any).sessions.get(threadId)?.proc;
    await adapter.stopSession(threadId);
    if (proc) {
      const exited = await new Promise<string>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve(`code ${proc.exitCode}`);
        proc.once('exit', (code: number | null, signal: string | null) => resolve(signal ? `signal ${signal}` : `code ${code}`));
      });
      console.log(`agy exited: ${exited}`);
      assert.equal(exited, 'code 0', 'agy exits by itself when the session closes');
    }
  }
  console.log('verify-antigravity: live turn ok');
}

async function main(): Promise<void> {
  await checkRules();
  if (flag('--live')) await checkLive();
  else if (option('--prompt')) throw new Error('--prompt needs --live: it talks to the real agy.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 2500).unref());

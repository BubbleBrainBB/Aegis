// Real Codex app-server, real model turns: does a Computer use *read* reach
// Aegis before it runs, in each permission mode?
//
//   npm run verify:codex-computer-use-routing
//
// One session has the desktop at a time, for looking too. Aegis can only hold
// Codex's own Computer use to that if Codex asks before a read runs, and
// whether it asks is Codex's behaviour, not Aegis's: this script is where
// that is checked against the real thing. For Default, Plan and Full Access
// it starts a thread with exactly the arguments and permission options the
// manager uses, has the model call the read-only `list_apps` once, and
// requires the approval request to arrive at the client before the call
// completes. For Auto it requires the opposite: the read must not ask (there
// Codex's own reviewer would answer, at seconds per look, and Aegis would
// still not be asked).
//
// Nothing on the desktop is touched: `list_apps` only lists apps. Each mode
// costs one or a few short model turns on the signed-in Codex account, so
// this is not part of the CI suites. Skipped when Codex or its Computer use
// client is not installed.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = mkdtempSync(path.join(tmpdir(), 'aegis-codex-routing-'));
// Aegis's own MCP catalog for Codex: an empty one, so only Computer use is added.
process.env.AEGIS_CODEX_MCP_CONFIG_PATH = path.join(testRoot, 'aegis-codex-config.toml');
writeFileSync(process.env.AEGIS_CODEX_MCP_CONFIG_PATH, '');

const require = createRequire(import.meta.url);
const load = (file) => {
  const mod = require(path.join(root, 'dist-electron/electron', file));
  return mod.default ?? mod;
};
const { buildCodexMcpConfigOverrideArgs } = load('libs/codex-mcp-settings.js');
const { resolveComputerUseClientPath, injectsComputerUseServer, computerUseReadsAskAegis } = load('libs/codex-computer-use.js');
const { parseMcpToolApprovalElicitation } = load('libs/codex-computer-use-elicitation.js');
const { CodexAppServerManager } = load('libs/provider/codex-app-server-manager.js');

const finish = (message, code = 0) => {
  console.log(message);
  rmSync(testRoot, { recursive: true, force: true });
  process.exit(code);
};
if (process.platform !== 'darwin') finish('codex computer-use routing skipped: macOS only');
const clientPath = resolveComputerUseClientPath();
if (!clientPath) finish('codex computer-use routing skipped: SkyComputerUseClient is not installed');
process.env.AEGIS_COMPUTER_USE_CLIENT_PATH = clientPath;
let binary;
try {
  binary = process.env.AEGIS_E2E_CODEX_BINARY?.trim() || execFileSync('which', ['codex'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
} catch {
  finish('codex computer-use routing skipped: codex binary is not on PATH');
}
const codexVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();

const MODES = [
  { name: 'Default', permission: 'defaultPermissions', execution: 'execute', asks: true },
  { name: 'Plan', permission: 'defaultPermissions', execution: 'plan', asks: true },
  { name: 'Full Access', permission: 'fullAccess', execution: 'execute', asks: true },
  { name: 'Auto', permission: 'auto', execution: 'execute', asks: false },
];
// The tools sit behind Codex's tool search, and the model does not always find them at once.
const PROMPT =
  'The MCP server aegis-computer-use provides a tool named list_apps. Find it with your tool search function: try the queries "list_apps", then "aegis", then "computer use", then "apps" until one returns it (it may take a couple of tries). Call list_apps exactly once. Do not call any other tool. Reply DONE, or FAILED with the exact error text.';
const ATTEMPTS = 4;

/** One turn in one mode on a fresh app-server; what the client was asked, and whether the read ran. */
async function runTurn(mode) {
  // The manager's own builders, so that what is checked is what Aegis sends.
  const manager = new CodexAppServerManager(binary, 'routing-check');
  const args = buildCodexMcpConfigOverrideArgs({
    computerUsePolicy: manager.resolveComputerUsePolicy(mode.permission, mode.execution),
    computerUseReadsAsk: computerUseReadsAskAegis(mode.permission),
  });
  manager.computerUseInjected = injectsComputerUseServer(args);
  assert.equal(manager.computerUseInjected, true, 'the Computer use server is injected');

  const child = spawn(binary, ['app-server', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  const seen = { asked: [], reviewed: 0, toolRan: false, toolCompleted: false, askedBeforeCompletion: false, answer: '', error: null };
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  let turnDone;
  const turnFinished = new Promise((resolve) => { turnDone = resolve; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && message.method) {
        // What Aegis's own parser makes of the request, as the manager would see it.
        const elicitation = parseMcpToolApprovalElicitation(message.method, message.params);
        if (elicitation) {
          seen.asked.push({ server: elicitation.server, tool: elicitation.toolName, kind: elicitation.approvalKind, mutating: elicitation.action?.mutating ?? null });
          if (!seen.toolCompleted) seen.askedBeforeCompletion = true;
        }
        const result = message.method.toLowerCase().includes('elicitation') ? { action: 'accept', content: {} } : {};
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        continue;
      }
      const item = message.params?.item;
      if (message.method === 'item/autoApprovalReview/started') seen.reviewed += 1;
      if (item?.type === 'mcpToolCall' && item.server === 'aegis-computer-use' && item.tool === 'list_apps') {
        if (message.method === 'item/started') seen.toolRan = true;
        if (message.method === 'item/completed') {
          seen.toolCompleted = true;
          seen.error = item.error ? JSON.stringify(item.error) : null;
        }
      }
      if (item?.type === 'agentMessage' && message.method === 'item/completed') seen.answer = String(item.text || '').slice(0, 200);
      if (message.method === 'turn/completed') turnDone();
    }
  });
  const send = (method, params, timeoutMs = 90_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs).unref();
    });

  try {
    await send('initialize', { clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const deadline = Date.now() + 90_000;
    for (;;) {
      const status = await send('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }, 20_000);
      const server = (status?.data || []).find((entry) => entry.name === 'aegis-computer-use');
      if (server?.tools && Object.keys(server.tools).includes('list_apps')) break;
      if (Date.now() > deadline) throw new Error('aegis-computer-use did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const threadOptions = manager.buildThreadPermissionOptions(testRoot, mode.permission, mode.execution);
    const thread = await send('thread/start', { cwd: testRoot, ephemeral: true, ...threadOptions });
    const threadId = thread?.thread?.id ?? thread?.threadId ?? thread?.id;
    assert.ok(threadId, 'thread/start returned an id');
    await send('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT }],
      cwd: testRoot,
      ...manager.buildCollaborationModeOptions(mode.execution, thread?.model, thread?.reasoningEffort ?? 'low'),
      ...manager.buildTurnPermissionOptions(testRoot, mode.permission, mode.execution, [testRoot], false),
    }, 60_000);
    await Promise.race([turnFinished, new Promise((resolve) => setTimeout(resolve, 150_000))]);
    return { ...seen, approvalPolicy: threadOptions.approvalPolicy, reviewer: threadOptions.approvalsReviewer };
  } finally {
    child.kill();
  }
}

const results = {};
try {
  console.log(`codex computer-use routing on ${codexVersion}`);
  for (const mode of MODES) {
    let seen = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      seen = await runTurn(mode);
      // The model did not find or call the tool: nothing was learned, ask again.
      if (seen.toolRan) break;
      console.log(`  ${mode.name}: attempt ${attempt} did not reach the tool (${seen.answer || 'no answer'})`);
    }
    assert.equal(seen.toolRan, true, `${mode.name}: the model never called list_apps in ${ATTEMPTS} attempts`);
    assert.equal(seen.toolCompleted && !seen.error, true, `${mode.name}: list_apps did not complete (${seen.error})`);
    const read = seen.asked.find((asked) => asked.server === 'aegis-computer-use');
    if (mode.asks) {
      assert.ok(read, `${mode.name}: the read ran without asking the client first`);
      assert.equal(seen.askedBeforeCompletion, true, `${mode.name}: the request came after the read had run`);
      assert.equal(read.tool, 'list_apps', `${mode.name}: Aegis reads the tool name out of the real request`);
      assert.equal(read.kind, 'mcp_tool_call');
      assert.equal(read.mutating, false, `${mode.name}: and knows it for a look`);
      assert.equal(seen.reviewed, 0, `${mode.name}: answered by the client, not by Codex's reviewer`);
    } else {
      assert.equal(read, undefined, `${mode.name}: the read is not meant to ask here`);
      assert.equal(seen.reviewed, 0, `${mode.name}: a look must not cost a review`);
    }
    results[mode.name] = {
      approvalPolicy: seen.approvalPolicy,
      reviewer: seen.reviewer,
      askedAegis: Boolean(read),
      reviews: seen.reviewed,
    };
    console.log(`  ✓ ${mode.name}: ${mode.asks ? 'the read asked Aegis before it ran' : 'the read did not ask (as intended) and cost no review'}  ${JSON.stringify(results[mode.name])}`);
  }
} catch (error) {
  console.error(error);
  finish('codex computer-use routing FAILED', 1);
}
finish('codex computer-use routing passed');

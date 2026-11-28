// Run with node --require tsx/cjs --test scripts/tests/workflow-planner-start.test.cjs.
// Use a temporary app database and deterministic planner failures, without an agent login.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

test('chat planning pauses on failure and retries only the chosen planner', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aegis-planner-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const load = Module._load;
  Module._load = function (name, ...args) {
    return name === 'electron' ? { app: { getPath: () => root } } : load.call(this, name, ...args);
  };
  t.after(() => { Module._load = load; });
  const sessions = require('../../src/electron/libs/session-store.ts');
  const { WorkflowService } = require('../../src/electron/libs/workflow/workflow-service.ts');
  const { settleTurn } = require('../../src/electron/libs/workflow/session-hooks.ts');
  sessions.initialize();
  t.after(() => sessions.close());

  const attempts = [];
  let paused = Promise.withResolvers();
  const deps = {
    userDataDir: root,
    appGeneration: 'test',
    modelCatalog: async () => ({ availableModels: [{ name: 'codex-model', label: 'Test Model' }] }),
    effortLevels: async () => ['low', 'high'],
    broadcast: run => { if (run.status === 'needs_input') paused.resolve(run); },
    bridge: {
      start: async (payload, onCreated) => {
        attempts.push([payload.provider, payload.model, payload.codexReasoningEffort, payload.title]);
        if (attempts.length === 1) throw new Error('Could not start Codex');
        const id = 'planner-retry';
        onCreated(id);
        settleTurn(id, 'error', 'Account on hold');
        return id;
      },
    },
  };
  const input = {
    cwd: root,
    request: 'Only review CLAUDE.md',
    context: 'Claude changed this file.',
    parent: { sessionId: 'parent', toolUseId: 'call', provider: 'claude' },
    availableAgents: ['claude', 'codex', 'pi'],
    planner: { agent: 'codex', model: 'Test Model', reasoningEffort: 'HIGH' },
  };
  const service = new WorkflowService(deps);
  for (const planner of [undefined, { ...input.planner, agent: 'pi' },
    { ...input.planner, model: 'unknown' }, { ...input.planner, reasoningEffort: 'unknown' }]) {
    assert.equal((await service.startFromChat({ ...input, planner })).ok, false);
  }
  assert.deepEqual(service.list(), []);
  const started = await service.startFromChat(input);
  assert.equal(started.ok, true);
  const first = await paused.promise;
  assert.equal(first.id, started.run.id);
  assert.equal(first.needsInput.reason, 'planning-paused');
  assert.match(first.needsInput.detail, /codex · codex-model · high/);
  assert.match(first.needsInput.detail, /Could not start Codex/);
  assert.deepEqual(first.needsInput.options.map(o => o.id), ['replan', 'cancel']);

  const reloaded = new WorkflowService(deps);
  reloaded.recoverOnStartup();
  assert.equal(reloaded.get(first.id).status, 'needs_input');
  assert.equal(attempts.length, 1);
  paused = Promise.withResolvers();
  const answer = (view, optionId) => reloaded.act({ type: 'answer', runId: view.id, expectedRevision: view.revision, optionId });
  assert.equal((await answer(first, 'replan')).ok, true);
  const second = await paused.promise;
  assert.match(second.needsInput.detail, /Account on hold/);
  assert.deepEqual(second.steps, []);
  assert.deepEqual(second.members, []);
  assert.equal((await answer(second, 'cancel')).run.status, 'cancelled');
  const expected = ['codex', 'codex-model', 'high', 'Workflow planner'];
  assert.deepEqual(attempts, [expected, expected]);
});

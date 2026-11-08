// Team settings, the roster the coordinator reads, and the no-model
// follow-up rule. Run: npx tsx scripts/tests/team.test.ts
import assert from 'node:assert/strict';
import { normalizeAppPreferences } from '../../src/shared/app-preferences';
import {
  eligibleAgents,
  normalizeTeamSettings,
  quickFollowUpTarget,
  teamFallbackAction,
  teamInstructions,
  teamRoster,
  TEAM_LIMITS,
  type TeamCandidate,
} from '../../src/shared/team';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const candidates: TeamCandidate[] = [
  { provider: 'claude', label: 'Claude Code', unavailable: null },
  { provider: 'codex', label: 'Codex', unavailable: null },
  { provider: 'kimi', label: 'Kimi Code', unavailable: 'not signed in' },
  { provider: 'deepseek', label: 'DeepSeek Harness', unavailable: null },
];

test('settings default to a Claude coordinator that asks when unsure', () => {
  const settings = normalizeTeamSettings(undefined);
  assert.deepEqual(settings.coordinator, { provider: 'claude', model: '' });
  assert.equal(settings.fallback.provider, null);
  assert.equal(settings.askWhenUnsure, true);
  assert.equal(normalizeAppPreferences({}).team.askWhenUnsure, true);
});

test('settings drop unknown agents and bad values', () => {
  const settings = normalizeTeamSettings({
    coordinator: { provider: 'nobody', model: 'x' },
    fallback: { provider: 'codex', model: 'gpt' },
    askWhenUnsure: false,
    agents: {
      nobody: { enabled: true },
      codex: { enabled: true, description: '  Routine fixes  ' },
      deepseek: { enabled: false },
    },
  });
  assert.equal(settings.coordinator.provider, 'claude');
  assert.deepEqual(settings.fallback, { provider: 'codex', model: 'gpt' });
  assert.equal(settings.askWhenUnsure, false);
  assert.equal(settings.agents.nobody as unknown, undefined);
  assert.equal(settings.agents.codex?.description, 'Routine fixes');
  assert.equal(settings.agents.deepseek?.enabled, false);
});

test('the roster lists who can take work, says why others can\'t, and leaves out agents that are off', () => {
  const settings = normalizeTeamSettings({
    agents: {
      claude: { description: 'Engineering and UI' },
      codex: { description: 'Routine fixes' },
      deepseek: { enabled: false },
    },
  });
  const roster = teamRoster(settings, candidates);
  assert.match(roster, /claude \(Claude Code\): Engineering and UI/);
  assert.match(roster, /codex \(Codex\): Routine fixes$/m);
  assert.match(roster, /kimi .*not signed in\. Do not pick it\./);
  assert.doesNotMatch(roster, /deepseek/);
  assert.deepEqual(eligibleAgents(settings, candidates).map((c) => c.provider), ['claude', 'codex']);
});

test('the instructions carry the roster, the projects, the ask rule and no busy/idle balancing', () => {
  const asking = teamInstructions(normalizeTeamSettings({}), '- claude: x', ['/repo']);
  assert.match(asking, /AskUserQuestion/);
  assert.match(asking, /\/repo/);
  assert.match(asking, /Don't balance work by how busy/);
  assert.match(asking, /Leave use_worktree out/);
  const notAsking = teamInstructions(normalizeTeamSettings({ askWhenUnsure: false }), '- claude: x', []);
  assert.doesNotMatch(notAsking, /AskUserQuestion/);
  assert.match(notAsking, /no projects yet/);
});

test('without a model, only a short one-line message soon after the last task talk goes to that task', () => {
  const now = 1_000_000;
  const last = { taskId: 'task-1', at: now - 60_000 };
  assert.equal(quickFollowUpTarget('Also cover iPad', last, now), 'task-1');
  assert.equal(quickFollowUpTarget('two\nlines', last, now), null);
  assert.equal(quickFollowUpTarget('x'.repeat(TEAM_LIMITS.quickFollowUpChars + 1), last, now), null);
  assert.equal(quickFollowUpTarget('Also cover iPad', { taskId: 'task-1', at: now - TEAM_LIMITS.quickFollowUpWindowMs - 1 }, now), null);
  assert.equal(quickFollowUpTarget('Also cover iPad', null, now), null);
});

test('without a model, a task\'s own report is only shown, never sent back to the task as a follow-up', () => {
  const now = 1_000_000;
  const last = { taskId: 'task-1', at: now - 1000 };
  assert.deepEqual(teamFallbackAction({ prompt: 'Sub-session finished: Fix UI', internal: true }, last, now), { kind: 'show' });
  assert.deepEqual(teamFallbackAction({ prompt: 'Also cover iPad', internal: false }, last, now), { kind: 'add', taskId: 'task-1' });
  assert.deepEqual(teamFallbackAction({ prompt: 'Start a whole new piece of work about the release notes', internal: false }, last, now), { kind: 'none' });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n`, error);
  }
}
if (failed) {
  console.error(`${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`all ${tests.length} passed`);

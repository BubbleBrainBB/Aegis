// Usage report days across a clock change, against real SQLite: a report's
// range is whole calendar days, so the day the clocks go forward (23 hours) or
// back (25 hours) still has exactly one bucket and the range starts at a local
// midnight. Each scenario runs in its own process, because the time zone is
// fixed when a process starts. Electron is stubbed; Codex and OpenCode read
// from a scratch home.
// Requires transpile:electron.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

// `now`, `changeDay`: [year, month, day] in the scenario's zone. `offsets`:
// minutes behind UTC at noon the day before and on the change day, to prove
// the zone took effect in the child process.
const SCENARIOS = {
  // Clocks go forward on 2026-03-08 at 02:00: that day is 23 hours long.
  spring: { tz: 'America/New_York', now: [2026, 3, 20], changeDay: [2026, 3, 8], offsets: [300, 240] },
  // Clocks go back on 2026-11-01 at 02:00: that day is 25 hours long.
  autumn: { tz: 'America/New_York', now: [2026, 11, 12], changeDay: [2026, 11, 1], offsets: [240, 300] },
  // Clocks go forward at midnight: 2026-03-08 starts at 01:00.
  'midnight-change': { tz: 'America/Havana', now: [2026, 3, 20], changeDay: [2026, 3, 8], offsets: [300, 240] },
  // No daylight saving: every day is 24 hours, and the report is what it was.
  'no-change': { tz: 'Asia/Shanghai', now: [2026, 3, 20], changeDay: [2026, 3, 8], offsets: [-480, -480] },
};
const RANGES = [7, 30, 90, 365];
const PROVIDERS = ['claude', 'codex', 'opencode'];
const DAY_MS = 86_400_000;

// Calendar days counted in UTC, which has no clock changes.
const utcKey = ([year, month, day], offsetDays = 0) => new Date(Date.UTC(year, month - 1, day) + offsetDays * DAY_MS).toISOString().slice(0, 10);
const localKey = (timestamp) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
};

function runScenario(name) {
  const scenario = SCENARIOS[name];
  const local = ([year, month, day], hour = 0, minute = 0, offsetDays = 0) => new Date(year, month - 1, day + offsetDays, hour, minute).getTime();
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, scenario.tz, 'the scenario runs in its own time zone');
  assert.deepEqual(
    [new Date(local(scenario.changeDay, 12, 0, -1)).getTimezoneOffset(), new Date(local(scenario.changeDay, 12)).getTimezoneOffset()],
    scenario.offsets,
    'the clocks change on the change day'
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-usage-report-days-'));
  // Never read personal Codex or OpenCode history.
  const home = path.join(tmp, 'home');
  os.homedir = () => home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const electron = { app: { getPath: () => tmp, isPackaged: false, getAppPath: () => root } };
  const originalLoad = Module._load;
  Module._load = function (id, ...args) { return id === 'electron' ? electron : originalLoad.call(this, id, ...args); };
  const sessions = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  const Database = require(path.join(root, 'node_modules/better-sqlite3'));
  const realNow = Date.now;
  const now = local(scenario.now, 15);
  Date.now = () => now;

  // One turn per moment that matters, each with its own token count so a sum
  // names the turns in it. `before` is half an hour ahead of the 30-day range.
  const firstDay = 1 - 30;
  const turns = {
    before: { at: local(scenario.now, 23, 30, firstDay - 1), tokens: 1000 },
    firstDay: { at: local(scenario.now, 0, 30, firstDay), tokens: 2000 },
    changeDay: { at: local(scenario.changeDay, 12), tokens: 4000 },
    today: { at: local(scenario.now, 10), tokens: 8000 },
  };
  const ordered = Object.values(turns).sort((left, right) => left.at - right.at);
  const split = (tokens) => ({ input: tokens - 100, output: 100 });

  try {
    sessions.initialize();

    const claude = sessions.createSession({ title: 'Claude days', cwd: tmp, provider: 'claude', model: 'claude-sonnet-4-6' });
    for (const turn of ordered) {
      const { input, output } = split(turn.tokens);
      sessions.addMessage(claude.id, {
        type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0,
        usage: { input_tokens: input, output_tokens: output }, createdAt: turn.at,
      });
    }

    // Codex counts tokens from its rollout file.
    const state = new Database(path.join(process.env.CODEX_HOME, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model TEXT,tokens_used INTEGER)');
    const rollout = path.join(tmp, 'days-thread.jsonl');
    const running = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, total_tokens: 0 };
    const lines = [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })];
    for (const turn of ordered) {
      const { input, output } = split(turn.tokens);
      const last = { input_tokens: input, cached_input_tokens: 0, output_tokens: output, cache_write_input_tokens: 0, total_tokens: turn.tokens };
      for (const key of Object.keys(running)) running[key] += last[key];
      lines.push(JSON.stringify({
        type: 'event_msg', timestamp: new Date(turn.at).toISOString(),
        payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...running } } },
      }));
    }
    fs.writeFileSync(rollout, lines.join('\n'));
    state.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('days-thread', rollout, 'gpt-5.5', 0);
    state.close();
    const codex = sessions.createSession({ title: 'Codex days', cwd: tmp, provider: 'codex', model: 'gpt-5.5' });
    sessions.updateCodexSessionId(codex.id, 'days-thread');

    // OpenCode counts tokens from its own database.
    const opencodeDir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const opencodeDb = new Database(path.join(opencodeDir, 'opencode.db'));
    opencodeDb.exec('CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)');
    for (const turn of ordered) {
      opencodeDb.prepare('INSERT INTO message VALUES(?,?,?)').run('days-session', turn.at, JSON.stringify({
        role: 'assistant', modelID: 'gpt-5.5', tokens: split(turn.tokens),
      }));
    }
    opencodeDb.close();
    const opencode = sessions.createSession({ title: 'OpenCode days', cwd: tmp, provider: 'opencode', model: 'gpt-5.5' });
    sessions.updateOpencodeSessionId(opencode.id, 'days-session');

    for (const provider of PROVIDERS) {
      for (const days of RANGES) {
        const label = `${name} ${provider} ${days} days`;
        const report = sessions.getAgentUsageReport(provider, days);
        const keys = report.daily.map((day) => day.date);
        // One bucket per calendar day, the oldest first, today last.
        assert.deepEqual(keys, Array.from({ length: days }, (_, index) => utcKey(scenario.now, index - (days - 1))), `${label}: consecutive calendar days ending today`);
        assert.equal(new Set(keys).size, days, `${label}: no day twice`);
        // Every turn counted in the range sits in a bucket.
        assert.equal(report.daily.reduce((sum, day) => sum + day.totalTokens, 0), report.totals.totalTokens, `${label}: the days add up to the total`);
        if (scenario.offsets[0] === scenario.offsets[1]) {
          // Without a clock change the 24-hour steps this report used to take name the same days.
          const start = new Date(now).setHours(0, 0, 0, 0) - (days - 1) * DAY_MS;
          assert.deepEqual(keys, Array.from({ length: days }, (_, index) => localKey(start + index * DAY_MS)), `${label}: unchanged without a clock change`);
        }
      }

      const label = `${name} ${provider}`;
      const report = sessions.getAgentUsageReport(provider, 30);
      const tokensOn = (dateKey) => report.daily.find((day) => day.date === dateKey)?.totalTokens;
      assert.equal(report.daily.length, 30);
      assert.equal(report.daily[0].date, utcKey(scenario.now, firstDay));
      // The range starts at the first day's local midnight: a turn half an
      // hour into that day counts, one half an hour before it does not.
      assert.equal(report.totals.totalTokens, turns.firstDay.tokens + turns.changeDay.tokens + turns.today.tokens, `${label}: the range is whole days`);
      assert.equal(tokensOn(utcKey(scenario.now, firstDay)), turns.firstDay.tokens, `${label}: the first day's first hour is in the range`);
      assert.equal(tokensOn(utcKey(scenario.changeDay)), turns.changeDay.tokens, `${label}: the change day has its bucket`);
      assert.equal(tokensOn(utcKey(scenario.now)), turns.today.tokens, `${label}: today`);
      // The days on either side of the change day are there and empty.
      assert.equal(tokensOn(utcKey(scenario.changeDay, -1)), 0, `${label}: the day before the change`);
      assert.equal(tokensOn(utcKey(scenario.changeDay, 1)), 0, `${label}: the day after the change`);
    }
    sessions.close();
  } finally {
    Date.now = realNow;
    Module._load = originalLoad;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[2]) {
  runScenario(process.argv[2]);
} else {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const child = spawnSync(process.execPath, [__filename, name], { env: { ...process.env, TZ: scenario.tz }, stdio: 'inherit' });
    assert.equal(child.status, 0, `usage report day buckets: the ${name} scenario (${scenario.tz}) failed`);
  }
  console.log(`usage report day buckets: ${Object.keys(SCENARIOS).join(', ')} ok`);
}

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `npm test`: builds the main process once, then runs every suite listed in
// package.json "testSuites" (each an npm script) in order.
//
// A suite that fails is run once more on CI (AEGIS_TEST_RETRIES overrides,
// 0 locally by default): the Electron UI suites sometimes miss a frame on
// slow runners. A suite that only passed on its retry is reported, so a
// flaky test stays visible. All suites run; every failure is listed at the end.
//
// AEGIS_TEST_GROUP picks where the suites run, so CI can keep the macOS runners
// for what needs them. "linux" runs package.json "linuxTestSuites", which never
// start Electron; "macos" runs everything else, so a new suite lands there unless
// it is added to the list. Unset runs all suites.
//
// AEGIS_TEST_SHARD=i/n then runs only shard i of n of those suites, so CI can
// split them across machines. Suites go to the lightest shard, longest first, by
// the typical durations in test-suite-seconds.json; a suite without a duration
// counts as DEFAULT_SUITE_SECONDS. Every suite lands in exactly one shard.
//
// AEGIS_TEST_JOBS=n runs up to n suites at once, for suites that mostly wait.
// Their output is held and printed whole when each one ends. Retries run one at
// a time after the rest, so a suite that only fails under load shows up as flaky.
// vite.config.ts reads AEGIS_TEST_WORKER to keep those suites' servers apart.
//
// `node scripts/run-tests.mjs --list` prints the selected suites and exits.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const allSuites = pkg.testSuites;
if (!Array.isArray(allSuites) || allSuites.length === 0) {
  console.error('[test] package.json has no "testSuites".');
  process.exit(1);
}
const missing = allSuites.filter((name) => !pkg.scripts?.[name]);
if (missing.length) {
  console.error(`[test] "testSuites" names scripts that do not exist: ${missing.join(', ')}`);
  process.exit(1);
}

const linuxSuites = pkg.linuxTestSuites ?? [];
const unknown = linuxSuites.filter((name) => !allSuites.includes(name));
if (unknown.length) {
  console.error(`[test] "linuxTestSuites" names suites not in "testSuites": ${unknown.join(', ')}`);
  process.exit(1);
}

const group = process.env.AEGIS_TEST_GROUP;
if (group && group !== 'linux' && group !== 'macos') {
  console.error(`[test] AEGIS_TEST_GROUP must be linux or macos, got "${group}".`);
  process.exit(1);
}

const DEFAULT_SUITE_SECONDS = 10;

function selectGroup(names) {
  if (!group) return names;
  return names.filter((name) => linuxSuites.includes(name) === (group === 'linux'));
}

function selectShard(names, spec) {
  if (!spec) return names;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (index < 1 || index > count) {
    console.error(`[test] AEGIS_TEST_SHARD must look like 1/3, got "${spec}".`);
    process.exit(1);
  }
  const durations = JSON.parse(readFileSync(new URL('./test-suite-seconds.json', import.meta.url), 'utf8'));
  const seconds = (name) => durations[name] ?? DEFAULT_SUITE_SECONDS;
  const shards = Array.from({ length: count }, () => ({ total: 0, names: new Set() }));
  const longestFirst = [...names].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b));
  for (const name of longestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.total < best.total ? shard : best));
    lightest.total += seconds(name);
    lightest.names.add(name);
  }
  return names.filter((name) => shards[index - 1].names.has(name));
}

const suites = selectShard(selectGroup(allSuites), process.env.AEGIS_TEST_SHARD);
if (process.argv.includes('--list')) {
  console.log(suites.join('\n'));
  process.exit(0);
}

const onCI = Boolean(process.env.CI);
const retries = process.env.AEGIS_TEST_RETRIES === undefined
  ? (onCI ? 1 : 0)
  : Math.max(0, Number.parseInt(process.env.AEGIS_TEST_RETRIES, 10) || 0);
const jobs = Math.max(1, Number.parseInt(process.env.AEGIS_TEST_JOBS, 10) || 1);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const seconds = (since) => `${Math.round((Date.now() - since) / 1000)}s`;

const running = new Map();
// A cancelled or timed-out job would otherwise lose the output of whatever hung.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const [suite, output] of running) {
      console.log(`\n[test] ${suite} was still running:`);
      process.stdout.write(Buffer.concat(output));
    }
    process.exit(1);
  });
}

function runHeld(suite, env) {
  return new Promise((resolve) => {
    const output = [];
    running.set(suite, output);
    const child = spawn(npm, ['run', suite], { stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', (error) => output.push(Buffer.from(`${error.stack}\n`)));
    child.on('close', (code) => {
      running.delete(suite);
      process.stdout.write(Buffer.concat(output));
      resolve(code === 0);
    });
  });
}

const run = (script, env) => spawnSync(npm, ['run', script], { stdio: 'inherit', env }).status === 0;

const started = Date.now();
if (!run('transpile:electron', process.env)) {
  console.error('[test] transpile:electron failed.');
  process.exit(1);
}
// Electron downloads on first use, which suites running at once would race for.
if (group !== 'linux' && spawnSync('node', ['-e', "require('electron')"], { stdio: 'inherit' }).status !== 0) {
  console.error('[test] installing Electron failed.');
  process.exit(1);
}
// Electron-hosted suites load native modules built for Electron's ABI. This used
// to happen only inside validate:terminal, which a shard may not contain. The
// Linux group runs no Electron, so it keeps the modules npm built for Node.
if (group !== 'linux' && spawnSync('node', ['scripts/prepare-electron-native-deps.mjs'], { stdio: 'inherit' }).status !== 0) {
  console.error('[test] preparing native dependencies failed.');
  process.exit(1);
}
const env = { ...process.env, AEGIS_TRANSPILED: '1' };

let finished = 0;
const report = (suite, passed, since) => {
  finished += 1;
  console.log(`[test] ${passed ? 'pass' : 'FAIL'} ${suite} (${finished}/${suites.length}, ${seconds(since)})`);
};

let failed = [];
const queue = [...suites];
await Promise.all(Array.from({ length: jobs }, async (_, worker) => {
  while (queue.length) {
    const suite = queue.shift();
    const suiteStarted = Date.now();
    const passed = jobs > 1
      ? await runHeld(suite, { ...env, AEGIS_TEST_WORKER: String(worker) })
      : run(suite, env);
    report(suite, passed, suiteStarted);
    if (!passed) failed.push(suite);
  }
}));

const flaky = [];
for (let attempt = 1; attempt <= retries && failed.length; attempt += 1) {
  const again = [];
  for (const suite of failed) {
    console.log(`\n[test] ${suite} failed; running it again (${attempt}/${retries})\n`);
    const suiteStarted = Date.now();
    const passed = run(suite, env);
    console.log(`[test] ${passed ? 'pass' : 'FAIL'} ${suite} on retry (${seconds(suiteStarted)})`);
    if (passed) flaky.push(suite);
    else again.push(suite);
  }
  failed = again;
}

console.log(`\n[test] ${suites.length - failed.length}/${suites.length} suites passed in ${seconds(started)}.`);
for (const suite of flaky) {
  console.log(`[test] ${suite} passed only on its retry.`);
  if (onCI) console.log(`::warning title=Flaky test suite::${suite} failed once and passed on its retry.`);
}
for (const suite of failed) {
  console.error(`[test] FAILED: ${suite}`);
  if (onCI) console.log(`::error title=Test suite failed::${suite}`);
}
process.exit(failed.length ? 1 : 0);

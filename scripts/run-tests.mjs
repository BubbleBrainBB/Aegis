import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `npm test`: builds the main process once, then runs every suite listed in
// package.json "testSuites" (each an npm script) in order.
//
// A suite that fails is run once more on CI (AEGIS_TEST_RETRIES overrides,
// 0 locally by default): the Electron UI suites sometimes miss a frame on
// slow runners. A suite that only passed on its retry is reported, so a
// flaky test stays visible. All suites run; every failure is listed at the end.
//
// AEGIS_TEST_SHARD=i/n runs only shard i of n, so CI can split the suites across
// machines. Suites go to the lightest shard, longest first, by the typical
// durations in test-suite-seconds.json; a suite without a duration counts as
// DEFAULT_SUITE_SECONDS. Every suite lands in exactly one shard. Shard 1 starts
// BUILD_SECONDS heavier because CI also runs the build there.
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

const DEFAULT_SUITE_SECONDS = 10;
const BUILD_SECONDS = 70;

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
  const shards = Array.from({ length: count }, (_, shard) => ({ total: shard === 0 ? BUILD_SECONDS : 0, names: new Set() }));
  const longestFirst = [...names].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b));
  for (const name of longestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.total < best.total ? shard : best));
    lightest.total += seconds(name);
    lightest.names.add(name);
  }
  return names.filter((name) => shards[index - 1].names.has(name));
}

const suites = selectShard(allSuites, process.env.AEGIS_TEST_SHARD);
if (process.argv.includes('--list')) {
  console.log(suites.join('\n'));
  process.exit(0);
}

const onCI = Boolean(process.env.CI);
const retries = process.env.AEGIS_TEST_RETRIES === undefined
  ? (onCI ? 1 : 0)
  : Math.max(0, Number.parseInt(process.env.AEGIS_TEST_RETRIES, 10) || 0);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (script, env) => spawnSync(npm, ['run', script], { stdio: 'inherit', env }).status === 0;
const seconds = (since) => `${Math.round((Date.now() - since) / 1000)}s`;

const started = Date.now();
if (!run('transpile:electron', process.env)) {
  console.error('[test] transpile:electron failed.');
  process.exit(1);
}
// Electron-hosted suites load native modules built for Electron's ABI. This used
// to happen only inside validate:terminal, which a shard may not contain.
if (spawnSync('node', ['scripts/prepare-electron-native-deps.mjs'], { stdio: 'inherit' }).status !== 0) {
  console.error('[test] preparing native dependencies failed.');
  process.exit(1);
}
const env = { ...process.env, AEGIS_TRANSPILED: '1' };

const failed = [];
const flaky = [];
for (const [index, suite] of suites.entries()) {
  const suiteStarted = Date.now();
  let passed = false;
  for (let attempt = 0; attempt <= retries && !passed; attempt += 1) {
    if (attempt > 0) console.log(`\n[test] ${suite} failed; running it again (${attempt}/${retries})\n`);
    passed = run(suite, env);
    if (passed && attempt > 0) flaky.push(suite);
  }
  if (!passed) failed.push(suite);
  console.log(`[test] ${passed ? 'pass' : 'FAIL'} ${suite} (${index + 1}/${suites.length}, ${seconds(suiteStarted)})`);
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

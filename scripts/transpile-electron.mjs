import { spawnSync } from 'node:child_process';

// Builds the main process (and the assets it loads). Many test suites start
// with this step; scripts/run-tests.mjs builds once and sets
// AEGIS_TRANSPILED=1 so the suites after it skip the identical rebuild.
if (process.env.AEGIS_TRANSPILED === '1') {
  console.log('[transpile:electron] already built for this test run');
  process.exit(0);
}

const steps = [
  'node scripts/patch-bubble-sdk.mjs',
  'tsc -p src/electron/tsconfig.json',
  'node scripts/build-design-assets.mjs',
  'node scripts/remote/build-crypto.mjs',
  'node scripts/build-liquid-glass.mjs',
];

for (const step of steps) {
  const result = spawnSync(step, { stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

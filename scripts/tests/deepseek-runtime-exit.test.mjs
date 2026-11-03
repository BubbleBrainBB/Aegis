// The bundled Harness runtime exits when its client goes away without sending
// `shutdown`, as when Aegis crashes or a script calls process.exit. Real runtime,
// local Messages API mock. stdin EOF is what such a runtime sees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const require = createRequire(import.meta.url);
const { writeMessagesStream } = require('../fixtures/deepseek-messages-mock.cjs');
const profile = join(resolve('.'), 'dev-fixtures/deepseek-harness');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-dsh-exit-')));
const cwd = join(temp, 'workspace'); mkdirSync(cwd);
const EXIT_LIMIT_MS = 20_000;

let responses = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    void writeMessagesStream(res, { model: body.model, ...(responses.shift() ?? { text: 'done' }) });
  });
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

async function startRuntime() {
  const harness = new DeepSeekHarness({
    dshBin: join(profile, 'runtime-bin.mjs'), profile: 'sdk', patches: [join(profile, 'cordis.yml')], processCwd: profile,
    cwd, provider: 'deepseek-official', model: 'deepseek-flash', requestTimeoutMs: 30_000,
    env: { ...process.env, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'), DSH_HOME: join(temp, 'home/.dsh'),
      DSH_CWD: cwd, DSH_PERMISSION_MODE: 'workspace-write', DSH_SESSION_ROOT: join(temp, 'sessions'),
      AEGIS_DSH_PROJECT_ROOTS: '', AEGIS_DSH_AGENT_PRESET: 'standard', DEEPSEEK_API_KEY: 'local-exit-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, ELECTRON_RUN_AS_NODE: '1' },
  });
  await harness.start();
  return { harness, child: harness.client.child };
}

/** Close stdin without `shutdown`, then wait for the process. */
function exitAfterEof(child) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`runtime still alive ${EXIT_LIMIT_MS}ms after stdin EOF`));
    }, EXIT_LIMIT_MS);
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    child.stdin.end();
  });
}

const running = (pattern) => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  .split('\n').some((line) => line.includes(pattern));
async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    assert(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

const runtimes = [];
try {
  // 1. After a finished turn the session keeps the event loop alive.
  responses = [{ text: 'hello' }];
  const idle = await startRuntime(); runtimes.push(idle);
  assert.equal((await idle.harness.run('Say hello.')).finalResponse, 'hello');
  assert.deepEqual(await exitAfterEof(idle.child), { code: 0, signal: null }, 'idle runtime exits cleanly');

  // 2. During a turn the runtime stops the turn and its running command too.
  const seconds = 3000 + (process.pid % 1000);
  responses = [{ toolCalls: [{ id: 'long-bash', name: 'bash', input: { command: `sleep ${seconds}`, description: 'wait' } }] }];
  const busy = await startRuntime(); runtimes.push(busy);
  void busy.harness.run('Wait.').catch(() => {});
  await waitFor(() => running(`sleep ${seconds}`), 'the running command');
  assert.deepEqual(await exitAfterEof(busy.child), { code: 0, signal: null }, 'runtime exits during a turn');
  await waitFor(() => !running(`sleep ${seconds}`), 'the command to stop with the runtime');

  console.log('deepseek-runtime-exit: runtime exits on client loss, idle and mid-turn');
} finally {
  for (const { harness } of runtimes) await harness.close().catch(() => {});
  await new Promise((closed) => server.close(closed));
  rmSync(temp, { recursive: true, force: true });
}

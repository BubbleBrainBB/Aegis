import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startShellEnvironment, type ShellEnvironmentCache } from '../../src/electron/libs/shell-environment';

// startShellEnvironment: the shell environment of the last launch is used at
// once when it can be trusted, and the shell is asked again in the
// background. The shell itself is replaced here by a function the test
// answers; nothing reads the real shell's environment.

if (process.platform === 'win32') {
  process.stdout.write('shell-environment-cache: nothing to check on Windows\n');
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'aegis-shell-env-'));
const home = path.join(dir, 'home');
mkdirSync(home);
writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');

const KEYS = ['PATH', 'HOME', 'SHELL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NVM_DIR', 'npm_lifecycle_event'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
/** The environment a GUI app starts with: no shell startup file has run. */
const bare = () => {
  for (const key of KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  process.env.PATH = '/usr/bin:/bin';
  // A proxy of its own, so the proxy macOS is set to on this machine plays no part.
  process.env.NO_PROXY = 'localhost';
};

/** A keychain stand-in: reversible, and nothing like the text it hides. */
const cacheFile = path.join(dir, 'profile', 'shell-environment.enc');
const cache: ShellEnvironmentCache = {
  file: cacheFile,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8'),
};

const SECRET = 'sk-ant-test-0123456789';
const shellSays = (extra: Record<string, string> = {}) => ({
  env: { PATH: '/opt/tools/bin:/usr/bin:/bin', HOME: home, SHELL: '/bin/zsh', ANTHROPIC_API_KEY: SECRET, HTTPS_PROXY: 'http://user:pw@proxy.test:8080', NVM_DIR: '/opt/nvm', IGNORED: 'x', ...extra },
  source: 'interactive-login' as const,
});
// The module logs a line each time it applies an environment, also from the
// background refresh: quiet for the whole run.
console.log = () => {};
const silence = <T>(work: () => T): T => work();

async function main(): Promise<void> {
  let now = Date.UTC(2026, 10, 23, 8, 0, 0);
  let asked = 0;
  let askedInBackground = 0;
  const start = (answer: ReturnType<typeof shellSays> | { env: Record<string, string>; source: 'none' }, background = answer) =>
    silence(() =>
      startShellEnvironment({
        cache,
        now: () => now,
        probe: () => {
          asked += 1;
          return answer;
        },
        probeAsync: async () => {
          askedInBackground += 1;
          return background;
        },
      })
    );

  // ── The first launch: the shell is asked, and everything waits for it ────
  bare();
  let started = start(shellSays());
  assert.equal(started.source, 'interactive-login');
  assert.deepEqual([asked, askedInBackground], [1, 0]);
  assert.equal(process.env.ANTHROPIC_API_KEY, SECRET);
  assert.ok(process.env.PATH!.startsWith('/opt/tools/bin:/usr/bin:/bin'), 'the shell PATH leads');
  assert.equal(process.env.IGNORED, undefined, 'only the keys Aegis inherits');
  await started.refreshed;

  // What is kept for the next launch: encrypted, and for this user only.
  assert.ok(existsSync(cacheFile));
  const stored = readFileSync(cacheFile);
  assert.equal(stored.includes(SECRET), false, 'the API key is not on disk in the clear');
  assert.equal(stored.includes('proxy.test'), false, 'nor the proxy with its password');
  assert.equal(stored.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(statSync(cacheFile).mode & 0o077, 0, 'readable by nobody else');
  assert.ok(cache.decrypt(stored).includes(SECRET), 'and it is all there for the keychain to give back');
  assert.equal(JSON.parse(cache.decrypt(stored)).env.IGNORED, undefined);

  // ── The next launch: last launch's answer at once, the shell asked behind ─
  bare();
  now += 60_000;
  let release: () => void = () => {};
  const changed = shellSays({ ANTHROPIC_API_KEY: 'sk-ant-rotated', PATH: '/opt/new/bin:/usr/bin:/bin' });
  delete (changed.env as Record<string, string>).NVM_DIR;
  delete (changed.env as Record<string, string>).HTTPS_PROXY;
  started = silence(() =>
    startShellEnvironment({
      cache,
      now: () => now,
      probe: () => {
        asked += 1;
        return shellSays();
      },
      probeAsync: () => new Promise((resolve) => { release = () => resolve(changed); }),
    })
  );
  assert.equal(started.source, 'cache');
  assert.equal(asked, 1, 'nothing waited for the shell');
  assert.equal(process.env.ANTHROPIC_API_KEY, SECRET, 'the key is there before the shell has answered');
  assert.equal(process.env.NVM_DIR, '/opt/nvm');
  assert.equal(process.env.HTTPS_PROXY, 'http://user:pw@proxy.test:8080');
  assert.ok(process.env.PATH!.startsWith('/opt/tools/bin:'));
  // The shell answers: what changed replaces what was used, what is gone is removed.
  silence(() => release());
  await started.refreshed;
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-rotated');
  assert.ok(process.env.PATH!.startsWith('/opt/new/bin:'));
  assert.equal(process.env.NVM_DIR, undefined, 'a key the shell no longer has does not linger');
  // (On a Mac with a system proxy that one takes its place; the shell's own is gone either way.)
  assert.notEqual(process.env.HTTPS_PROXY, 'http://user:pw@proxy.test:8080');
  assert.ok(cache.decrypt(readFileSync(cacheFile)).includes('sk-ant-rotated'), 'and the next launch starts from the new answer');
  assert.equal(cache.decrypt(readFileSync(cacheFile)).includes('proxy.test'), false);

  // A key set since by someone else is not removed just because the cache once held another value.
  bare();
  now += 60_000;
  const without = shellSays({ ANTHROPIC_API_KEY: 'sk-ant-rotated', PATH: '/opt/new/bin:/usr/bin:/bin' });
  delete (without.env as Record<string, string>).ANTHROPIC_API_KEY;
  started = silence(() =>
    startShellEnvironment({
      cache,
      now: () => now,
      probe: () => { throw new Error('the cache was expected to be used'); },
      probeAsync: () => new Promise((resolve) => { release = () => resolve(without); }),
    })
  );
  process.env.ANTHROPIC_API_KEY = 'set-by-the-app-meanwhile';
  silence(() => release());
  await started.refreshed;
  assert.equal(process.env.ANTHROPIC_API_KEY, 'set-by-the-app-meanwhile');

  // The shell cannot be asked in the background this time: last launch's answer stays, and stays cached.
  rmSync(cacheFile);
  bare();
  start(shellSays());
  bare();
  now += 60_000;
  const before = readFileSync(cacheFile);
  started = start(shellSays(), { env: {}, source: 'none' });
  await started.refreshed;
  assert.equal(started.source, 'cache');
  assert.equal(process.env.ANTHROPIC_API_KEY, SECRET);
  assert.deepEqual(readFileSync(cacheFile), before);

  // ── When last launch's answer is not trusted, the shell is asked first ────
  const asksTheShell = (label: string, arrange: () => void) => {
    bare();
    arrange();
    const count = asked;
    const result = start(shellSays());
    assert.equal(result.source, 'interactive-login', label);
    assert.equal(asked, count + 1, label);
    // Each case leaves a fresh cache behind for the next one.
  };
  now += 60_000;
  asksTheShell('a startup file was edited', () => {
    writeFileSync(path.join(home, '.zshrc'), 'export FOO=2 # edited\n');
  });
  asksTheShell('a startup file appeared', () => {
    writeFileSync(path.join(home, '.zprofile'), 'export BAR=1\n');
  });
  asksTheShell('a startup file kept its size but was saved again', () => {
    const file = path.join(home, '.zshrc');
    const later = new Date(statSync(file).mtimeMs + 5_000);
    utimesSync(file, later, later);
  });
  asksTheShell('another shell', () => {
    process.env.SHELL = '/bin/bash';
  });
  // (back to zsh, with a cache written for bash: asked again, then cached for zsh)
  asksTheShell('the shell changed back', () => undefined);
  asksTheShell('older than a day', () => {
    now += 24 * 60 * 60 * 1000 + 1;
  });
  asksTheShell('saved in the future (the clock was set back)', () => {
    now -= 60 * 60 * 1000;
  });
  asksTheShell('the file is not what was written', () => {
    writeFileSync(cacheFile, 'not an encrypted cache');
  });
  asksTheShell('the keychain cannot read it any more', () => {
    writeFileSync(cacheFile, Buffer.from('{"shell":"/bin/zsh"}', 'utf8'));
  });
  // And with all of that as it was, the cache is used again.
  bare();
  assert.equal(start(shellSays()).source, 'cache');

  // ── No way to encrypt: nothing is kept, and the shell is asked every time ─
  rmSync(cacheFile);
  bare();
  const count = asked;
  const plain = silence(() =>
    startShellEnvironment({
      cache: null,
      probe: () => { asked += 1; return shellSays(); },
      probeAsync: () => { throw new Error('with nothing cached there is nothing to refresh'); },
    })
  );
  assert.equal(plain.source, 'interactive-login');
  assert.equal(asked, count + 1);
  assert.equal(existsSync(cacheFile), false);
  assert.equal(process.env.ANTHROPIC_API_KEY, SECRET);

  // The shell gives nothing at all: nothing is cached, and the fallback PATH still applies.
  bare();
  const nothing = start({ env: {}, source: 'none' });
  assert.equal(nothing.source, 'none');
  assert.equal(existsSync(cacheFile), false);
  assert.ok(process.env.PATH!.includes('/usr/bin'));

  process.stdout.write('shell-environment-cache: all checks passed\n');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

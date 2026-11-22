import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * DeepSeek API balance query (Settings > Usage). Covers where the balance API
 * is looked for, how responses are read, that every failure becomes a status
 * instead of an exception, and that the key reaches neither the report nor
 * the log. Nothing here talks to the network beyond a local test server.
 */

const KEY = 'sk-balance-test-key-0123456789';
const OFFICIAL_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
};

// The key store path is computed from HOME when the module loads.
const home = mkdtempSync(path.join(tmpdir(), 'deepseek-balance-test-'));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, key: process.env.DEEPSEEK_API_KEY, base: process.env.DEEPSEEK_BASE_URL, profile: process.env.AEGIS_DSH_PROFILE_DIR };
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_BASE_URL;
delete process.env.AEGIS_DSH_PROFILE_DIR;

const cli = require('../../src/electron/libs/deepseek-cli.ts') as typeof import('../../src/electron/libs/deepseek-cli');
const balance = require('../../src/electron/libs/deepseek-balance.ts') as typeof import('../../src/electron/libs/deepseek-balance');

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url));
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function main() {
  // --- Where the balance API is looked for ---
  assert.deepEqual(balance.resolveDeepseekBalanceEndpoint('https://api.deepseek.com/anthropic'),
    { url: 'https://api.deepseek.com/user/balance', official: true });
  assert.deepEqual(balance.resolveDeepseekBalanceEndpoint('https://api.deepseek.com'),
    { url: 'https://api.deepseek.com/user/balance', official: true });
  assert.deepEqual(balance.resolveDeepseekBalanceEndpoint('https://proxy.example.com/deepseek/anthropic/'),
    { url: 'https://proxy.example.com/deepseek/user/balance', official: false });
  assert.deepEqual(balance.resolveDeepseekBalanceEndpoint('http://127.0.0.1:8080'),
    { url: 'http://127.0.0.1:8080/user/balance', official: false });
  assert.equal(balance.resolveDeepseekBalanceEndpoint('https://api.deepseek.com.evil.example/anthropic')?.official, false,
    'a look-alike host is not the official API');
  assert.equal(balance.resolveDeepseekBalanceEndpoint('https://api.deepseek.com:8443/anthropic')?.official, false);
  assert.equal(balance.resolveDeepseekBalanceEndpoint("process.env.BASE ?? 'https://x'"), null, 'a !!js expression is not a URL');
  assert.equal(balance.resolveDeepseekBalanceEndpoint('https://user:pass@proxy.example.com'), null);
  assert.equal(balance.resolveDeepseekBalanceEndpoint('file:///etc/passwd'), null);

  // --- The Harness's effective endpoint: profile baseURL, then env, then the public API ---
  const profile = (baseUrl: string) => `- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    thinking: enabled\n${baseUrl}`;
  assert.equal(cli.parseDeepseekBaseUrl(null, undefined), 'https://api.deepseek.com/anthropic');
  assert.equal(cli.parseDeepseekBaseUrl(profile(''), '  '), 'https://api.deepseek.com/anthropic');
  assert.equal(cli.parseDeepseekBaseUrl(profile(''), 'https://env.example.com/anthropic'), 'https://env.example.com/anthropic');
  assert.equal(cli.parseDeepseekBaseUrl(profile('    baseURL: https://profile.example.com/anthropic\n'), 'https://env.example.com/anthropic'),
    'https://profile.example.com/anthropic', 'the profile wins over the environment, as in the runtime');
  assert.equal(
    balance.resolveDeepseekBalanceEndpoint(cli.parseDeepseekBaseUrl(profile('    baseURL: !!js "process.env.X"\n'), undefined)),
    null, 'a computed baseURL is never guessed at');
  assert.equal(cli.parseDeepseekBaseUrl('::: not yaml [', 'https://env.example.com'), 'https://env.example.com');

  // --- Reading responses ---
  assert.deepEqual(balance.parseDeepseekBalance(OFFICIAL_BODY), {
    isAvailable: true,
    balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00', remainingPercent: null, referenceBalance: null }],
  });
  assert.deepEqual(balance.parseDeepseekBalance({ is_available: false, balance: { currency: 'usd', total_balance: 0 } }), {
    isAvailable: false,
    balances: [{ currency: 'USD', totalBalance: '0', grantedBalance: null, toppedUpBalance: null, remainingPercent: null, referenceBalance: null }],
  }, 'a single `balance` object and numeric amounts are accepted');
  assert.deepEqual(balance.parseDeepseekBalance({ is_available: true, balance_infos: [
    { currency: '<b>', total_balance: '1' }, { currency: 'CNY', total_balance: 'lots' }, null, 'x',
  ] }), { isAvailable: true, balances: [] }, 'malformed entries are dropped');
  for (const notBalance of [null, 'ok', [], {}, { error: { message: 'Not Found' } }, { is_available: 'yes' }]) {
    assert.equal(balance.parseDeepseekBalance(notBalance), null);
  }

  // --- The share left: measured against the balance when it last rose ---
  const firstSeen = balance.advanceDeepseekBalanceGauge(null, '200.00');
  assert.deepEqual(firstSeen, { gauge: { peak: '200.00', last: '200.00' }, remainingPercent: 100 });
  const spent = balance.advanceDeepseekBalanceGauge(firstSeen.gauge, '128.50');
  assert.deepEqual(spent.gauge, { peak: '200.00', last: '128.50' });
  assert.equal(Math.round(spent.remainingPercent), 64);
  assert.deepEqual(balance.advanceDeepseekBalanceGauge(spent.gauge, '128.50'), spent, 'an unchanged balance changes nothing');
  assert.deepEqual(balance.advanceDeepseekBalanceGauge(spent.gauge, '150.00'), { gauge: { peak: '150.00', last: '150.00' }, remainingPercent: 100 },
    'a small top-up is a new full mark, even below the old one');
  assert.equal(balance.advanceDeepseekBalanceGauge(spent.gauge, '-0.16').remainingPercent, 0, 'an overdrawn balance has nothing left');
  assert.equal(balance.advanceDeepseekBalanceGauge(null, '0.00').remainingPercent, 0);
  assert.equal(balance.advanceDeepseekBalanceGauge({ peak: '-0.16', last: '-0.16' }, '50.00').remainingPercent, 100, 'topping up an overdrawn account fills it');

  // --- Official endpoint ---
  const official = { apiKey: KEY, baseUrl: 'https://api.deepseek.com/anthropic', now: () => 5_000 };
  const ok = fakeFetch(() => json(OFFICIAL_BODY));
  const okResult = await balance.queryDeepseekBalance({ ...official, fetchImpl: ok.fetchImpl });
  assert.deepEqual(okResult, {
    report: { source: 'deepseek-api', fetchedAt: 5_000, status: 'ok', isAvailable: true, balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00', remainingPercent: null, referenceBalance: null }] },
    failure: null,
  });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(ok.calls[0].init.method, 'GET');
  assert.equal((ok.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.equal(ok.calls[0].init.redirect, 'error', 'the key is never carried to a redirect target');

  const exhausted = await balance.queryDeepseekBalance({ ...official, fetchImpl: fakeFetch(() => json({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] })).fetchImpl });
  assert.equal(exhausted.report.status, 'ok');
  assert.equal(exhausted.report.isAvailable, false, 'is_available=false is reported, not thrown');

  const cases: Array<[string, () => Response | Promise<Response>, string, string]> = [
    ['rejected key', () => json({ error: { message: `Authentication Fails, key ${KEY} is invalid` } }, 401), 'unauthorized', 'HTTP 401'],
    ['server error', () => new Response('upstream down', { status: 503 }), 'unavailable', 'HTTP 503'],
    ['not JSON', () => new Response('<html>hello</html>', { status: 200 }), 'unavailable', 'invalid response'],
    ['wrong shape', () => json({ data: [] }), 'unavailable', 'invalid response'],
    ['oversized body', () => new Response(`{"is_available":true,"pad":"${'x'.repeat(70_000)}"}`, { status: 200 }), 'unavailable', 'invalid response'],
    ['network error', () => { throw new TypeError(`fetch failed for Bearer ${KEY}`); }, 'unavailable', 'network error'],
  ];
  for (const [name, respond, status, failure] of cases) {
    const result = await balance.queryDeepseekBalance({ ...official, fetchImpl: fakeFetch(respond).fetchImpl });
    assert.equal(result.report.status, status, `official, ${name}: status`);
    assert.equal(result.failure, failure, `official, ${name}: failure`);
    assert.deepEqual(result.report.balances, [], `official, ${name}: no balances`);
    assert.equal(JSON.stringify(result).includes(KEY), false, `official, ${name}: the key stays out of the result`);
  }

  const hang = fakeFetch(() => new Promise<Response>(() => {}));
  const slow = ((url: string, init?: RequestInit) => {
    void hang.fetchImpl(url, init);
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const timedOut = await balance.queryDeepseekBalance({ ...official, fetchImpl: slow, timeoutMs: 20 });
  assert.equal(timedOut.report.status, 'unavailable');
  assert.equal(timedOut.failure, 'timeout');

  // --- No key: nothing is sent anywhere ---
  const noKey = fakeFetch(() => json(OFFICIAL_BODY));
  const noKeyResult = await balance.queryDeepseekBalance({ apiKey: null, baseUrl: official.baseUrl, fetchImpl: noKey.fetchImpl });
  assert.equal(noKeyResult.report.status, 'no-key');
  assert.equal(noKeyResult.failure, null);
  assert.equal(noKey.calls.length, 0);

  // --- Third-party proxy: every failure reads as "not supported" ---
  const proxy = { apiKey: KEY, baseUrl: 'https://proxy.example.com/v1/anthropic' };
  for (const [name, respond] of [
    ['404', () => json({ error: 'not found' }, 404)],
    ['401', () => json({ error: 'unauthorized' }, 401)],
    ['HTML 200', () => new Response('<html>Welcome</html>', { status: 200 })],
    ['unrelated JSON 200', () => json({ status: 'ok' })],
    ['network error', () => { throw new TypeError('fetch failed'); }],
  ] as Array<[string, () => Response]>) {
    const probe = fakeFetch(respond);
    const result = await balance.queryDeepseekBalance({ ...proxy, fetchImpl: probe.fetchImpl });
    assert.equal(result.report.status, 'unsupported', `proxy, ${name}`);
    assert.equal(probe.calls[0].url, 'https://proxy.example.com/v1/user/balance');
  }
  const proxyOk = await balance.queryDeepseekBalance({ ...proxy, fetchImpl: fakeFetch(() => json(OFFICIAL_BODY)).fetchImpl });
  assert.equal(proxyOk.report.status, 'ok', 'a proxy that serves the balance API is shown');
  const computed = fakeFetch(() => json(OFFICIAL_BODY));
  const computedResult = await balance.queryDeepseekBalance({ apiKey: KEY, baseUrl: 'process.env.BASE', fetchImpl: computed.fetchImpl });
  assert.equal(computedResult.report.status, 'unsupported');
  assert.equal(computed.calls.length, 0, 'the key is not sent to a guessed endpoint');

  // --- The cached entry point, against a local server standing in for a proxy ---
  let mode: 'ok' | 'missing' | 'down' = 'ok';
  let total = '110.00';
  const hits: Array<{ url: string | undefined; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization });
    if (mode === 'ok' && req.url === '/gateway/user/balance') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...OFFICIAL_BODY, balance_infos: [{ ...OFFICIAL_BODY.balance_infos[0], total_balance: total }] }));
    } else {
      res.writeHead(mode === 'down' ? 502 : 404).end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const logged: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.DEEPSEEK_BASE_URL = `${origin}/gateway/anthropic`;

    assert.equal((await balance.getDeepseekBalance()).status, 'no-key');
    assert.equal(hits.length, 0);

    process.env.DEEPSEEK_API_KEY = KEY;
    const first = await balance.getDeepseekBalance();
    assert.equal(first.status, 'ok', 'a newly configured key is queried at once, not served from the no-key answer');
    assert.equal(first.balances[0].totalBalance, '110.00');
    assert.deepEqual(hits, [{ url: '/gateway/user/balance', auth: `Bearer ${KEY}` }]);
    assert.equal(await balance.getDeepseekBalance(), first, 'a polling page reuses the saved report');
    const [a, b] = await Promise.all([balance.getDeepseekBalance(true), balance.getDeepseekBalance(true)]);
    assert.equal(a, b, 'concurrent callers share one request');
    assert.equal(hits.length, 2);

    // The share left survives in ~/.aegis, as amounts under a hashed account name.
    assert.deepEqual([first.balances[0].remainingPercent, first.balances[0].referenceBalance], [100, '110.00'], 'first sight is the full mark');
    total = '55.00';
    const half = (await balance.getDeepseekBalance(true)).balances[0];
    assert.deepEqual([half.totalBalance, half.remainingPercent, half.referenceBalance], ['55.00', 50, '110.00']);
    total = '80.00';
    const toppedUp = (await balance.getDeepseekBalance(true)).balances[0];
    assert.deepEqual([toppedUp.remainingPercent, toppedUp.referenceBalance], [100, '80.00']);
    const gaugeFile = path.join(home, '.aegis', 'deepseek-balance-gauge.json');
    const gaugeText = readFileSync(gaugeFile, 'utf8');
    const accounts = Object.entries(JSON.parse(gaugeText).accounts) as Array<[string, { currencies: unknown }]>;
    assert.equal(accounts.length, 1);
    assert.match(accounts[0][0], /^[0-9a-f]{16}$/);
    assert.deepEqual(accounts[0][1].currencies, { CNY: { peak: '80.00', last: '80.00' } });
    assert.equal(gaugeText.includes(KEY), false, 'the key is not written with the gauge');
    assert.equal(statSync(gaugeFile).mode & 0o077, 0, 'the gauge file is private');
    assert.equal(hits.length, 4);

    mode = 'missing';
    process.env.DEEPSEEK_BASE_URL = `${origin}/other/anthropic`;
    const unsupported = await balance.getDeepseekBalance();
    assert.equal(unsupported.status, 'unsupported', 'a proxy without the balance API degrades instead of failing');
    assert.equal(hits.length, 5);
    assert.equal((await balance.getDeepseekBalance()).status, 'unsupported');
    assert.equal(hits.length, 5, 'an unsupported endpoint is not probed again on every poll');

    assert.equal(logged.length, 1, 'one line per distinct failure');
    assert.match(logged[0], /^\[deepseek-balance\] balance query failed: HTTP 404$/);
    assert.equal(logged.join('\n').includes(KEY), false, 'the key is never logged');
    assert.equal(JSON.stringify([first, unsupported]).includes(KEY), false, 'the key is never in what the renderer receives');
  } finally {
    console.warn = realWarn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log('deepseek-balance: all assertions passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const [name, value] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['DEEPSEEK_API_KEY', saved.key], ['DEEPSEEK_BASE_URL', saved.base], ['AEGIS_DSH_PROFILE_DIR', saved.profile]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

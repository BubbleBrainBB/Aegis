import { createHash } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { DeepseekBalanceInfo, DeepseekBalanceReport, DeepseekBalanceStatus } from '../../shared/types';
import { resolveDeepseekApiKey, resolveDeepseekBaseUrl } from './deepseek-cli';

const BALANCE_TTL_MS = 45_000;
// A third-party endpoint without the balance API will not grow one mid-session.
const UNSUPPORTED_TTL_MS = 10 * 60_000;
const BALANCE_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 64 * 1024;
const OFFICIAL_HOST = 'api.deepseek.com';
const AMOUNT_PATTERN = /^-?\d{1,15}(\.\d{1,8})?$/;

// What each account's balance was when it last rose, so a balance can be shown
// as a share left. Holds amounts only; accounts are named by a truncated hash.
const GAUGE_FILE = path.join(homedir(), '.aegis', 'deepseek-balance-gauge.json');
const MAX_GAUGE_ACCOUNTS = 8;

export interface DeepseekBalanceEndpoint {
  url: string;
  /** False for a third-party proxy, which may not serve the balance API at all. */
  official: boolean;
}

/**
 * Where the balance API lives for a Harness Messages base URL. The official
 * API serves it at the host root; for a proxy the trailing `/anthropic`
 * Messages segment is dropped and the same path is probed. Returns null when
 * the base URL is not a plain HTTP(S) root.
 */
export function resolveDeepseekBalanceEndpoint(baseUrl: string): DeepseekBalanceEndpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (parsed.protocol === 'https:' && parsed.host === OFFICIAL_HOST) {
    return { url: `https://${OFFICIAL_HOST}/user/balance`, official: true };
  }
  const root = parsed.pathname.replace(/\/+$/, '').replace(/\/anthropic$/i, '');
  return { url: `${parsed.origin}${root}/user/balance`, official: false };
}

/**
 * Read a balance response. The documented list is `balance_infos`; a single
 * `balance` object is accepted too. Returns null for anything that is not a
 * balance response, so a proxy's unrelated 200 page is not taken for one.
 */
export function parseDeepseekBalance(
  payload: unknown
): Pick<DeepseekBalanceReport, 'isAvailable' | 'balances'> | null {
  const root = asRecord(payload);
  if (!root || typeof root.is_available !== 'boolean') return null;
  const raw = root.balance_infos ?? root.balance;
  const entries = Array.isArray(raw) ? raw : asRecord(raw) ? [raw] : [];
  const balances: DeepseekBalanceInfo[] = [];
  for (const entry of entries) {
    const info = asRecord(entry);
    const currency = typeof info?.currency === 'string' ? info.currency.trim().toUpperCase() : '';
    const totalBalance = asAmount(info?.total_balance);
    if (!/^[A-Z]{3,5}$/.test(currency) || totalBalance === null) continue;
    balances.push({
      currency,
      totalBalance,
      grantedBalance: asAmount(info?.granted_balance),
      toppedUpBalance: asAmount(info?.topped_up_balance),
      remainingPercent: null,
      referenceBalance: null,
    });
  }
  return { isAvailable: root.is_available, balances };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Amounts arrive as decimal strings ("110.00"); keep them as text so no precision is lost. */
function asAmount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return AMOUNT_PATTERN.test(text) ? text : null;
}

/** One currency's gauge: the balance when it last rose, and the last one seen. */
export interface DeepseekBalanceGauge {
  peak: string;
  last: string;
}

/**
 * Move a gauge on by one observation. A balance above the last one seen is a
 * top-up or a grant and becomes the new full mark; anything else is spending
 * measured against the mark already held.
 */
export function advanceDeepseekBalanceGauge(
  previous: DeepseekBalanceGauge | null,
  total: string
): { gauge: DeepseekBalanceGauge; remainingPercent: number } {
  const now = Number(total);
  const peak = !previous || now > Number(previous.last) ? total : previous.peak;
  const full = Number(peak);
  const remainingPercent = now <= 0 || full <= 0 ? 0 : Math.max(0, Math.min(100, (now / full) * 100));
  return { gauge: { peak, last: total }, remainingPercent };
}

type GaugeStore = Record<string, { updatedAt: number; currencies: Record<string, DeepseekBalanceGauge> }>;

function readGaugeStore(): GaugeStore {
  const store: GaugeStore = {};
  try {
    const accounts = asRecord(asRecord(JSON.parse(readFileSync(GAUGE_FILE, 'utf8')))?.accounts);
    for (const [account, value] of Object.entries(accounts ?? {})) {
      const entry = asRecord(value);
      const currencies: Record<string, DeepseekBalanceGauge> = {};
      for (const [currency, raw] of Object.entries(asRecord(entry?.currencies) ?? {})) {
        const peak = asAmount(asRecord(raw)?.peak);
        const last = asAmount(asRecord(raw)?.last);
        if (peak !== null && last !== null) currencies[currency] = { peak, last };
      }
      store[account] = { updatedAt: typeof entry?.updatedAt === 'number' ? entry.updatedAt : 0, currencies };
    }
  } catch { /* No file yet, or an unreadable one: every gauge starts again from full. */ }
  return store;
}

function writeGaugeStore(store: GaugeStore): void {
  const kept = Object.entries(store)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_GAUGE_ACCOUNTS);
  try {
    mkdirSync(path.dirname(GAUGE_FILE), { recursive: true });
    const temp = `${GAUGE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, accounts: Object.fromEntries(kept) }));
    chmodSync(temp, 0o600);
    renameSync(temp, GAUGE_FILE);
  } catch { /* The share left is a convenience; without the file it restarts with the app. */ }
}

/** Fill in each balance's share left, remembering the marks under `account`. */
function gaugeBalances(report: DeepseekBalanceReport, account: string): DeepseekBalanceReport {
  const store = readGaugeStore();
  const currencies = { ...store[account]?.currencies };
  let changed = false;
  const balances = report.balances.map((balance) => {
    const previous = currencies[balance.currency] ?? null;
    const { gauge, remainingPercent } = advanceDeepseekBalanceGauge(previous, balance.totalBalance);
    if (gauge.peak !== previous?.peak || gauge.last !== previous?.last) changed = true;
    currencies[balance.currency] = gauge;
    return { ...balance, remainingPercent, referenceBalance: gauge.peak };
  });
  if (changed) writeGaugeStore({ ...store, [account]: { updatedAt: report.fetchedAt, currencies } });
  return { ...report, balances };
}

export interface DeepseekBalanceQuery {
  apiKey: string | null;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface DeepseekBalanceQueryResult {
  report: DeepseekBalanceReport;
  /** Why the query failed, in fixed words that are safe to log. */
  failure: string | null;
}

/**
 * One balance query. Never throws: every failure becomes a report status, and
 * `failure` holds only a status code or a fixed phrase, never the key, the
 * request or a response body.
 */
export async function queryDeepseekBalance(query: DeepseekBalanceQuery): Promise<DeepseekBalanceQueryResult> {
  const now = query.now ?? Date.now;
  const done = (
    status: DeepseekBalanceStatus,
    failure: string | null,
    data: Pick<DeepseekBalanceReport, 'isAvailable' | 'balances'> = { isAvailable: false, balances: [] }
  ): DeepseekBalanceQueryResult => ({
    report: { source: 'deepseek-api', fetchedAt: now(), status, ...data },
    failure,
  });

  if (!query.apiKey) return done('no-key', null);
  const endpoint = resolveDeepseekBalanceEndpoint(query.baseUrl);
  if (!endpoint) return done('unsupported', 'endpoint is not an HTTP(S) URL');
  // Whatever goes wrong at a proxy reads as "this endpoint has no balance API".
  const failed = (status: DeepseekBalanceStatus, failure: string) =>
    done(endpoint.official ? status : 'unsupported', failure);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), query.timeoutMs ?? BALANCE_TIMEOUT_MS);
  try {
    const response = await (query.fetchImpl ?? fetch)(endpoint.url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${query.apiKey}` },
      // The key goes to the configured endpoint only, never on to a redirect target.
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return failed('unauthorized', `HTTP ${response.status}`);
    }
    if (!response.ok) return failed('unavailable', `HTTP ${response.status}`);
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null;
    } catch { /* Not JSON: handled as an invalid response below. */ }
    const parsed = parseDeepseekBalance(payload);
    return parsed ? done('ok', null, parsed) : failed('unavailable', 'invalid response');
  } catch {
    // The error is dropped on purpose: only a fixed phrase may reach the log.
    return failed('unavailable', controller.signal.aborted ? 'timeout' : 'network error');
  } finally {
    clearTimeout(timer);
  }
}

let cached: { fingerprint: string; report: DeepseekBalanceReport } | null = null;
let inflight: { fingerprint: string; promise: Promise<DeepseekBalanceReport> } | null = null;
let lastLoggedFailure: string | null = null;

/**
 * The balance of the DeepSeek API account behind the Harness's own key,
 * queried from the main process so the key never reaches the renderer.
 *
 * Results are cached briefly so a polling Usage page does not hit the API on
 * every tick, and per key and endpoint so a changed key is queried at once.
 * Always resolves; see DeepseekBalanceReport.status for the failure cases.
 */
export function getDeepseekBalance(force = false): Promise<DeepseekBalanceReport> {
  const apiKey = resolveDeepseekApiKey();
  const baseUrl = resolveDeepseekBaseUrl();
  const fingerprint = createHash('sha256').update(`${baseUrl}\n${apiKey ?? ''}`).digest('hex');
  const saved = cached?.fingerprint === fingerprint ? cached.report : null;
  if (!force && saved) {
    const age = Date.now() - saved.fetchedAt;
    if (saved.status === 'unsupported' && age < UNSUPPORTED_TTL_MS) {
      // Still the current answer; restamp it so it does not read as a stale balance.
      return Promise.resolve({ ...saved, fetchedAt: Date.now() });
    }
    if (age < BALANCE_TTL_MS) return Promise.resolve(saved);
  }
  if (inflight?.fingerprint === fingerprint) return inflight.promise;

  const promise = queryDeepseekBalance({ apiKey, baseUrl })
    .then(({ report, failure }) => {
      const failureKey = failure ? `${fingerprint}:${failure}` : null;
      if (failureKey && failureKey !== lastLoggedFailure) {
        console.warn(`[deepseek-balance] balance query failed: ${failure}`);
      }
      lastLoggedFailure = failureKey;
      // A passing outage keeps the last good balance on screen (its fetchedAt marks it as saved).
      if (report.status === 'unavailable' && saved?.status === 'ok') return saved;
      const gauged = report.status === 'ok' ? gaugeBalances(report, fingerprint.slice(0, 16)) : report;
      cached = { fingerprint, report: gauged };
      return gauged;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { fingerprint, promise };
  return promise;
}

import assert from 'node:assert/strict';
import {
  claudePlan, codexPlan, formatReset, formatTier, formatTokens, grokPlan, qoderPlan, reportTokens, usageTone,
} from '../../src/ui/utils/usage-menu-model';
import type { ClaudePlanUsageReport, CodexRateLimitReport, GrokPlanUsageReport, QoderPlanUsageReport, ClaudeUsageReport } from '../../src/ui/types';

// Claude: 5-hour and weekly windows, tier from the subscription; API accounts have no plan.
const claude = {
  rateLimitsAvailable: true, subscriptionType: 'max',
  fiveHour: { utilization: 28, resetsAt: 1_800_000_000 }, sevenDay: { utilization: 62, resetsAt: null },
} as ClaudePlanUsageReport;
assert.deepEqual(claudePlan(claude), {
  tier: 'Max',
  windows: [
    { label: '5-hour', remaining: 72, resetsAt: 1_800_000_000_000 },
    { label: 'Weekly', remaining: 38, resetsAt: null },
  ],
}, 'second timestamps become ms');
assert.equal(claudePlan({ ...claude, rateLimitsAvailable: false }), null, 'API accounts do not get invented plan quotas');
assert.equal(claudePlan({ ...claude, fiveHour: null, sevenDay: null }), null);
assert.equal(claudePlan({ ...claude, fiveHour: { utilization: 100, resetsAt: null }, sevenDay: null })?.windows[0].remaining, 0, 'exhausted quotas stay visible');
assert.equal(claudePlan({ ...claude, subscriptionType: null })?.tier, null);

// Codex: the main bucket's windows, labelled by their real duration.
const codex = { fetchedAt: 1, rateLimits: null, rateLimitsByLimitId: { codex: {
  planType: 'plus',
  primary: { usedPercent: 15, remainingPercent: 85, windowDurationMins: 300, resetsAt: null },
  secondary: { usedPercent: 36, remainingPercent: 64, windowDurationMins: 10080, resetsAt: null },
} } } as unknown as CodexRateLimitReport;
assert.deepEqual(codexPlan(codex)?.windows.map((w) => [w.label, w.remaining]), [['5-hour', 85], ['Weekly', 64]]);
assert.equal(codexPlan(codex)?.tier, 'Plus');
const exhausted = { ...codex, rateLimitsByLimitId: { codex: { ...codex.rateLimitsByLimitId.codex, primary: { usedPercent: 110, remainingPercent: -10, windowDurationMins: 60, resetsAt: null }, secondary: null } } };
assert.deepEqual(codexPlan(exhausted)?.windows, [{ label: '1-hour', remaining: 0, resetsAt: null }], 'actual window, clamped');
assert.equal(codexPlan({ ...codex, rateLimitsByLimitId: {} }), null);

// Grok and Qoder: one window each; a tier that is already a name passes through.
assert.deepEqual(grokPlan({ creditUsagePercent: 10, subscriptionTier: 'SuperGrok', currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', startsAt: null, endsAt: 1_900_000_000_000 } } as GrokPlanUsageReport),
  { tier: 'SuperGrok', windows: [{ label: 'Weekly', remaining: 90, resetsAt: 1_900_000_000_000 }] });
assert.equal(grokPlan({ creditUsagePercent: null } as GrokPlanUsageReport), null);
assert.deepEqual(qoderPlan({ totalUsagePercentage: null, userQuota: { percentage: 40 }, userType: 'pro', expiresAt: null } as unknown as QoderPlanUsageReport),
  { tier: 'Pro', windows: [{ label: 'Quota', remaining: 60, resetsAt: null }] });
assert.equal(qoderPlan(null), null);
assert.equal(formatTier('claude_max'), 'Claude Max');
assert.equal(formatTier('  '), null);

// Tone thresholds.
assert.deepEqual([100, 60, 59, 25, 24, 0].map(usageTone), ['ok', 'ok', 'watch', 'watch', 'low', 'low']);

// Reset times: relative within a day, weekday within a week, date beyond.
const now = new Date('2026-10-20T10:00:00').getTime();
assert.equal(formatReset(null, now), null);
assert.equal(formatReset(now + 30_000, now), 'now');
assert.equal(formatReset(now + 14 * 60_000, now), 'in 14m');
assert.equal(formatReset(now + (2 * 60 + 14) * 60_000, now), 'in 2h 14m');
assert.equal(formatReset(new Date('2026-10-22T09:00:00').getTime(), now), 'Thu 09:00');
assert.equal(formatReset(new Date('2026-11-01T00:00:00').getTime(), now), 'Nov 1');

// Tokens use the daily series, as the detail page does.
const usage = { totals: { sessionCount: 2, totalTokens: 999 }, daily: [{ date: '2026-09-20', totalTokens: 1200000 }] } as ClaudeUsageReport;
assert.deepEqual(reportTokens(usage), { tokens: 1200000, sessions: 2 });
assert.deepEqual(reportTokens(null), { tokens: 0, sessions: 0 });
assert.equal(formatTokens(118_500_000), '118.5M');
assert.equal(formatTokens(1_500_000), '1.5M');
console.log('usage-menu-model: all assertions passed');

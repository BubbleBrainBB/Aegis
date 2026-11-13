import assert from 'node:assert/strict';
import { buildUsageOverview, costAxis, overviewBucketDays } from '../../src/ui/utils/usage-overview-model';
import type { ClaudeUsageReport, UsageCostByType } from '../../src/ui/types';

const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const DAYS = 30;
const dates = Array.from({ length: DAYS }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
const split = (input: number, read: number, write: number, output: number, tokens = 1000): UsageCostByType => ({
  inputTokens: tokens, cacheReadTokens: tokens * 8, cacheWriteTokens: tokens, outputTokens: tokens,
  inputCostUsd: input, cacheReadCostUsd: read, cacheWriteCostUsd: write, outputCostUsd: output, unsplitCostUsd: 0,
});

/** A report whose cost falls on the given days (index → dollars per model). */
function report(options: {
  costMode?: ClaudeUsageReport['costMode'];
  models: Array<{ model: string; tokens: number; cost: number; sessions: number; messages?: number; credits?: number }>;
  dayCosts?: Record<number, Record<string, number>>;
  billing?: ClaudeUsageReport['billing'];
  costByType?: UsageCostByType;
  unpriced?: string[];
}): ClaudeUsageReport {
  const totalTokens = options.models.reduce((sum, model) => sum + model.tokens, 0);
  return {
    rangeDays: 30,
    costMode: options.costMode ?? 'actual',
    ...(options.unpriced ? { costCoverage: { pricedTokens: 0, unpricedTokens: 0, unpricedModels: options.unpriced } } : {}),
    totals: {
      inputTokens: totalTokens / 2, outputTokens: totalTokens / 2, totalTokens,
      totalCostUsd: options.models.reduce((sum, model) => sum + model.cost, 0),
      sessionCount: options.models.reduce((sum, model) => sum + model.sessions, 0),
      cacheReadTokens: totalTokens, cacheHitRate: 0.5,
    },
    ...(options.billing ? { billing: options.billing } : {}),
    ...(options.costByType ? { costByType: options.costByType } : {}),
    models: options.models.map((model) => ({
      model: model.model, inputTokens: model.tokens / 2, outputTokens: model.tokens / 2, totalTokens: model.tokens,
      totalCostUsd: model.cost, sessionCount: model.sessions, cacheReadTokens: model.tokens,
      ...(model.messages ? { agentMessages: model.messages } : {}), ...(model.credits ? { credits: model.credits } : {}),
    })),
    daily: dates.map((date, index) => ({
      date,
      totalTokens: index === DAYS - 1 ? totalTokens : 0,
      byModel: index === DAYS - 1 ? Object.fromEntries(options.models.map((model) => [model.model, model.tokens])) : {},
      byModelCostUsd: options.dayCosts?.[index] ?? {},
    })),
  };
}

const claude = report({ costMode: 'estimated', models: [{ model: 'claude-opus-5-5', tokens: 8000, cost: 300, sessions: 5 }, { model: 'shared', tokens: 1000, cost: 40, sessions: 1 }],
  dayCosts: { 5: { 'claude-opus-5-5': 200 }, 29: { 'claude-opus-5-5': 100, shared: 40 } }, costByType: split(10, 200, 60, 70) });
const codex = report({ costMode: 'estimated', models: [{ model: 'gpt-5.6-sol', tokens: 4000, cost: 80, sessions: 3 }], dayCosts: { 5: { 'gpt-5.6-sol': 80 } }, costByType: split(8, 40, 0, 32) });
const kimi = report({ costMode: 'partial', models: [{ model: 'K3', tokens: 2000, cost: 20, sessions: 2 }, { model: 'mystery', tokens: 50, cost: 0, sessions: 1 }], dayCosts: { 29: { K3: 20 } }, costByType: split(2, 8, 0, 10) });
const bubble = report({ models: [{ model: 'shared', tokens: 500, cost: 10, sessions: 2 }], dayCosts: { 5: { shared: 10 } }, costByType: { ...split(1, 4, 0, 3), unsplitCostUsd: 2 } });
const opencode = report({ models: [{ model: 'big-pickle', tokens: 300, cost: 5, sessions: 1 }], dayCosts: { 6: { 'big-pickle': 5 } } });
const deepseek = report({ costMode: 'estimated', models: [{ model: 'deepseek-v4-pro', tokens: 200, cost: 2, sessions: 1 }], dayCosts: { 5: { 'deepseek-v4-pro': 2 } }, costByType: split(.5, .5, 0, 1) });
// Devin bills messages: its dollars (an API estimate for one model) stay out of every total.
const devin = report({ costMode: 'partial', models: [{ model: 'swe-2-high', tokens: 700, cost: 9, sessions: 4, messages: 12 }], dayCosts: { 5: { 'swe-2-high': 9 } },
  billing: { agentMessages: 12, credits: 0 }, costByType: split(3, 3, 0, 3) });
const qoder = report({ costMode: 'unavailable', models: [{ model: 'Auto', tokens: 0, cost: 0, sessions: 2, credits: 12.4 }], billing: { agentMessages: 0, credits: 12.4 } });
// An agent with tokens and no price shows its tokens.
const mimo = report({ costMode: 'unavailable', models: [{ model: 'mimo-v2', tokens: 900, cost: 0, sessions: 1 }] });
const idle = report({ models: [] });

const inputs = [
  ['claude', 'Claude Code', claude], ['codex', 'Codex CLI', codex], ['opencode', 'OpenCode', opencode], ['kimi', 'Kimi Code', kimi],
  ['grok', 'Grok Build', idle], ['pi', 'Pi', null], ['qoder', 'Qoder', qoder], ['bubble', 'Bubble', bubble],
  ['deepseek', 'DeepSeek Harness', deepseek], ['devin', 'Devin', devin], ['mimo', 'MiMo Code', mimo],
].map(([provider, title, range]) => ({ provider, title, range, year: range })) as Parameters<typeof buildUsageOverview>[0];

const overview = buildUsageOverview(inputs, 30);
near(overview.totalCostUsd, 457);
assert.equal(overview.estimated, true, 'any estimated agent makes the total an estimate');
assert.equal(overview.totalTokens, 9000 + 4000 + 2050 + 500 + 300 + 200 + 700 + 0 + 900, 'tokens count every agent, own-unit ones too');
assert.equal(overview.sessionCount, 6 + 3 + 3 + 2 + 1 + 1 + 4 + 2 + 1);

// By agent: dollars first, most expensive first; own-unit agents after, without a share or a color.
assert.deepEqual(overview.agents.map((row) => row.provider), ['claude', 'codex', 'kimi', 'bubble', 'opencode', 'deepseek', 'qoder', 'devin', 'mimo']);
assert.deepEqual(overview.agents.map((row) => row.series), [0, 1, 2, 3, null, null, null, null, null], 'four colors, then gray');
assert.deepEqual(overview.agents.map((row) => row.estimated), [true, true, true, false, false, true, false, false, false], 'reported amounts carry no ≈');
near(overview.agents[0].share!, 340 / 457);
near(overview.agents.reduce((sum, row) => sum + (row.share ?? 0), 0), 1);
const own = Object.fromEntries(overview.agents.filter((row) => row.own).map((row) => [row.provider, row]));
assert.deepEqual(own.devin.own, { messages: 12, credits: 0, tokens: 700, sessions: 4 });
assert.deepEqual(own.qoder.own, { messages: 0, credits: 12.4, tokens: 0, sessions: 2 });
assert.equal(own.mimo.own!.tokens, 900);
assert.equal(own.devin.costUsd, null); assert.equal(own.devin.share, null);
assert.equal(overview.agents.some((row) => row.provider === 'grok' || row.provider === 'pi'), false, 'agents with nothing in the range are left out');

// Daily cost: one point a day, in the list's order, without the own-unit agents' dollars.
assert.equal(overview.buckets.length, 30);
const day5 = overview.buckets[5];
assert.equal(day5.start, '2026-10-06'); assert.equal(day5.end, '2026-10-06');
assert.deepEqual(day5.agents, [{ provider: 'claude', costUsd: 200 }, { provider: 'codex', costUsd: 80 }, { provider: 'bubble', costUsd: 10 }, { provider: 'deepseek', costUsd: 2 }]);
near(day5.totalCostUsd, 292);
near(overview.buckets.reduce((sum, bucket) => sum + bucket.totalCostUsd, 0), 457);
assert.deepEqual(overview.buckets[0].agents, []);

// Cost by type adds the dollar agents that carry a split.
near(overview.costByType!.inputCostUsd, 10 + 8 + 2 + 1 + .5);
near(overview.costByType!.cacheReadCostUsd, 200 + 40 + 8 + 4 + .5);
near(overview.costByType!.unsplitCostUsd, 2);
assert.equal(overview.costByType!.cacheReadTokens, 5 * 8000);

// One model table: same-named rows add up, and its total is the headline.
const models = Object.fromEntries(overview.report.models.map((model) => [model.model, model]));
near(models.shared.totalCostUsd, 50); assert.equal(models.shared.totalTokens, 1500); assert.equal(models.shared.sessionCount, 3);
near(models['swe-2-high'].totalCostUsd, 0);
assert.equal('agentMessages' in models['swe-2-high'], false, 'billed counts stay on the agent rows');
assert.equal(overview.report.billing, undefined);
assert.deepEqual([...overview.report.costCoverage!.unpricedModels].sort(), ['Auto', 'mimo-v2', 'mystery', 'swe-2-high']);
near(overview.report.totals.totalCostUsd, overview.totalCostUsd);
near(overview.report.models.reduce((sum, model) => sum + model.totalCostUsd, 0), 457);
assert.equal(overview.report.models[0].model, 'claude-opus-5-5', 'most tokens first');
assert.equal(overview.report.costMode, 'estimated');
// Cache hit: split agents by their own buckets (8 of 10), the rest by their reported rate.
assert(overview.report.totals.cacheHitRate > 0.5 && overview.report.totals.cacheHitRate < 0.8);
// Activity: every agent's tokens on the day they were used.
assert.equal(overview.yearDaily.length, 30);
assert.equal(overview.yearDaily[29].totalTokens, overview.totalTokens);
assert.equal(overview.yearDaily[29].byModel.shared, 1500);
assert.equal(overview.yearDaily[5].byModelCostUsd!['swe-2-high'], undefined);

// Only reported amounts: no ≈ anywhere.
const actual = buildUsageOverview(inputs.filter((input) => input.provider === 'bubble' || input.provider === 'opencode'), 30);
assert.equal(actual.estimated, false); assert.equal(actual.report.costMode, 'actual');
// Nothing used: an empty overview, not a crash.
const empty = buildUsageOverview([{ provider: 'claude', title: 'Claude Code', range: idle, year: idle }, { provider: 'pi', title: 'Pi', range: null, year: null }], 30);
assert.equal(empty.agents.length, 0); assert.equal(empty.totalCostUsd, 0); assert.equal(empty.costByType, null);

// Long ranges fold days into weeks counted back from today: the newest point is a full week.
assert.equal(overviewBucketDays(7), 1); assert.equal(overviewBucketDays(30), 1); assert.equal(overviewBucketDays(90), 7); assert.equal(overviewBucketDays(365), 7);
const weekly = buildUsageOverview(inputs, 90);
assert.equal(weekly.buckets.length, 4, '30 days of data: four whole weeks; the two days before them would draw as a dip');
assert.deepEqual([weekly.buckets[3].start, weekly.buckets[3].end], ['2026-10-24', '2026-10-30']);
assert.deepEqual([weekly.buckets[0].start, weekly.buckets[0].end], ['2026-10-03', '2026-10-09']);
near(weekly.buckets[3].totalCostUsd, 160);
near(weekly.buckets.reduce((sum, bucket) => sum + bucket.totalCostUsd, 0), 457);

// Axis: round steps, at most four above zero, headroom above the tallest bar.
assert.deepEqual(costAxis(310.96).ticks, [100, 200, 300]);
assert.deepEqual(costAxis(95).ticks, [25, 50, 75]);
assert.deepEqual(costAxis(1240).ticks, [500, 1000]);
assert(costAxis(310.96).top > 310.96);
assert.deepEqual(costAxis(0), { ticks: [], top: 1 });
for (const max of [0.004, 0.4, 3, 7.5, 42, 999, 18_500]) {
  const { ticks } = costAxis(max);
  assert(ticks.length >= 1 && ticks.length <= 4, `${max}: ${ticks}`);
  assert(ticks[ticks.length - 1] <= max * 1.0001);
}
console.log('usage overview model: totals, agent order, own units, daily and weekly points, cost by type, merged models and axis passed');

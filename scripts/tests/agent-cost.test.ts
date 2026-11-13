import assert from 'node:assert/strict';
import {
  addAgentCost, addCostByType, apiCostWeights, costFields, emptyCostByType, emptyCostDetails, estimateAgentApiCost, usageTokenParts,
} from '../../src/electron/libs/agent-cost';
const usage = { input_tokens: 100000, output_tokens: 1000, cache_read_input_tokens: 50000 };
const near = (a: number | null, b: number) => assert(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
near(estimateAgentApiCost('bubble', 'openai:gpt-5.5', usage), .305);
near(estimateAgentApiCost('pi', 'openai/gpt-5.5', usage), .555);
near(estimateAgentApiCost('pi', 'zai/glm-5.3-flash', usage), .017);
for (const model of ['kimi-code/k3', 'kimi-for-coding/k3', 'kimi-code/kimi-for-coding']) {
  near(estimateAgentApiCost('kimi', model, usage), .33);
  near(estimateAgentApiCost('kimi', model, {...usage, cache_creation_input_tokens: 10000}), .36);
}
near(estimateAgentApiCost('kimi', 'kimi-for-coding/kimi-for-coding-highspeed', usage), .217);
near(estimateAgentApiCost('bubble', 'kimi-for-coding:k3', usage), .18);
assert.equal(estimateAgentApiCost('pi', 'custom/k3', usage), null);
near(estimateAgentApiCost('kimi', 'kimi-code/k3', {input_tokens:0,output_tokens:0}), 0);
assert.equal(estimateAgentApiCost('kimi', 'kimi-code/k3', {input_tokens:0,output_tokens:0,total_tokens:50000}), null);
near(estimateAgentApiCost('kimi', 'moonshot-cn/kimi-k2.7-code-highspeed', usage), .217);
near(estimateAgentApiCost('kimi', 'moonshot-cn/kimi-k2.7-code-highspeed', {...usage, cache_creation_input_tokens: 10000}), .236);
near(estimateAgentApiCost('kimi', 'kimi-k3', usage), .33);
// K3.1 Pro: $2 in, $0.20 cached, $10 out; cache writes $2 for 5 minutes and $4 for an hour (twice that for highspeed).
for (const model of ['kimi-code/k3.1-pro', 'kimi-for-coding/k3.1-pro', 'kimi-k3.1-pro']) {
  near(estimateAgentApiCost('kimi', model, usage), .22);
  near(estimateAgentApiCost('kimi', model, {...usage, cache_creation_input_tokens: 10000}), .24);
  near(estimateAgentApiCost('kimi', model, {...usage, cache_creation_input_tokens: 10000, cache_creation: {ephemeral_1h_input_tokens: 4000}} as typeof usage), .248);
}
near(estimateAgentApiCost('kimi', 'kimi-code/k3.1-pro-highspeed', usage), .43);
near(estimateAgentApiCost('kimi', 'kimi-code/k3.1-pro-highspeed', {...usage, cache_creation_input_tokens: 10000}), .47);
// The K3 write tiers are still $3 and $6.
near(estimateAgentApiCost('kimi', 'kimi-code/k3', {...usage, cache_creation_input_tokens: 10000, cache_creation: {ephemeral_1h_input_tokens: 4000}} as typeof usage), .33 + (6000 * 3 + 4000 * 6) / 1e6);
// Claude's current models, for agents that return no cost of their own.
near(estimateAgentApiCost('opencode', 'anthropic/claude-opus-5-5', usage), (100000 * 4 + 50000 * .2 + 1000 * 20) / 1e6);
near(estimateAgentApiCost('opencode', 'claude-fable-5-2', usage), .85);
near(estimateAgentApiCost('pi', 'anthropic/claude-sonnet-5-5', usage), .215);
// Haiku 5.5 is priced by one request's prompt length: a turn total past 100K cannot be tiered.
const shortPrompt = { input_tokens: 10000, output_tokens: 100 };
near(estimateAgentApiCost('opencode', 'claude-haiku-5-5', shortPrompt), (10000 * .1 + 100 * .5) / 1e6);
assert.equal(estimateAgentApiCost('opencode', 'claude-haiku-5-5', usage), null);
near(estimateAgentApiCost('opencode', 'claude-haiku-5-5', usage, Date.now(), true), (100000 * .5 + 50000 * .05 + 1000 * 2.5) / 1e6);
// Devin bills in messages; its tokens are priced as the API model behind its id: the thinking level comes
// off the end, version dashes are dots, and its input count includes the cache reads.
near(estimateAgentApiCost('devin', 'claude-opus-5-5-medium', usage), (50000 * 4 + 50000 * .2 + 1000 * 20) / 1e6);
near(estimateAgentApiCost('devin', 'claude-opus-5-5-high', usage), .23);
near(estimateAgentApiCost('devin', 'gpt-6-1-sol-medium', usage), (50000 * 2 + 50000 * .1 + 1000 * 10) / 1e6);
near(estimateAgentApiCost('devin', 'claude-opus-4-7', usage), (50000 * 5 + 50000 * .5 + 1000 * 25) / 1e6);
assert.equal(estimateAgentApiCost('devin', 'swe-2-high', usage), null, 'Cognition\'s own model has no API price');
assert.equal(estimateAgentApiCost('devin', 'gpt-6-1-sol-high', {input_tokens: 300000, output_tokens: 100, cache_read_input_tokens: 250000}), null, 'a turn total past the long-context boundary');
assert.deepEqual(usageTokenParts('devin', usage), { input: 50000, cacheRead: 50000, cacheWrite: 0, output: 1000 });
// A name that is not a priced API id stays unknown, and the prefix rule is Kimi's alone.
assert.equal(estimateAgentApiCost('kimi', 'kimi-code/k9-ultra', usage), null);
assert.equal(estimateAgentApiCost('pi', 'custom/k3.1-pro', usage), null);
assert.equal(estimateAgentApiCost('qoder', 'auto', { input_tokens: 0, output_tokens: 0, total_tokens: 50000 }), null);
assert.equal(estimateAgentApiCost('pi', 'openai/gpt-5.5', {input_tokens: 300000, output_tokens: 100}), null);
near(estimateAgentApiCost('pi', 'openai/gpt-5.5', {input_tokens: 300000, output_tokens: 100}, Date.now(), true), 3.0045);
near(estimateAgentApiCost('grok', 'grok-4.6', {input_tokens: 200000, output_tokens: 100}, Date.now(), true), .8012);
assert.equal(estimateAgentApiCost('grok', 'grok-4.6', usage), null);
// MiniMax: mcode's select value names the model; M3 doubles past 512K input per request.
const minimaxUsage = { input_tokens: 21937, output_tokens: 179, cache_read_input_tokens: 66048 };
near(estimateAgentApiCost('minimax', 'm:minimax:MiniMax-M3.1-Flash:v:thinking', minimaxUsage), (21937 * .15 + 66048 * .015 + 179 * .6) / 1e6);
near(estimateAgentApiCost('minimax', 'MiniMax-M3.1-Flash', minimaxUsage), (21937 * .15 + 66048 * .015 + 179 * .6) / 1e6);
near(estimateAgentApiCost('minimax', 'm:minimax:MiniMax-M3:v:', minimaxUsage), (21937 * .3 + 66048 * .06 + 179 * 1.2) / 1e6);
near(estimateAgentApiCost('minimax', 'MiniMax-M3', {...minimaxUsage, cache_creation_input_tokens: 1000}), (22937 * .3 + 66048 * .06 + 179 * 1.2) / 1e6);
const longM3 = { input_tokens: 100000, output_tokens: 1000, cache_read_input_tokens: 450000 };
near(estimateAgentApiCost('minimax', 'MiniMax-M3', longM3, Date.now(), true), (100000 * .6 + 450000 * .12 + 1000 * 2.4) / 1e6);
assert.equal(estimateAgentApiCost('minimax', 'MiniMax-M3', longM3), null, 'a turn aggregate past 512K cannot be tiered');
near(estimateAgentApiCost('minimax', 'MiniMax-M3.1-Flash', longM3), (100000 * .15 + 450000 * .015 + 1000 * .6) / 1e6);
assert.equal(estimateAgentApiCost('minimax', 'm:minimax:MiniMax-M4:v:', minimaxUsage), null, 'unknown models stay unpriced');
const details = emptyCostDetails();
addAgentCost(details, 'bubble', 'openai:gpt-5.5', usage, 42);
addAgentCost(details, 'bubble', 'openai:gpt-5.5', usage, undefined);
addAgentCost(details, 'bubble', 'openai:gpt-5.5', usage, 0);
near(costFields(details).total_cost_usd, 42.305);
assert.equal(details.reportedCount, 2);
assert.equal(details.estimatedCount, 1);
addAgentCost(details, 'bubble', 'unknown', usage, undefined);
assert.equal(costFields(details).costSource, 'unavailable');
near(costFields(details).total_cost_usd, 42.305);
for (const invalid of [-1, NaN, Infinity, '3', null]) {
  const d = emptyCostDetails(); addAgentCost(d, 'bubble', 'openai:gpt-5.5', usage, invalid);
  assert.equal(d.estimatedCount, 1);
}
near(estimateAgentApiCost('claude', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 }), .003);
assert.equal(estimateAgentApiCost('claude', 'claude-sonnet-5', {input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 10}), null);
assert.equal(costFields(emptyCostDetails()).costDetails.unpricedCount, 1);

// Cost by type: the weights are the estimate, split four ways.
const sumOf = (parts: { input: number; cacheRead: number; cacheWrite: number; output: number } | null) =>
  parts === null ? null : parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
const writes = { ...usage, cache_creation_input_tokens: 10000 };
for (const [provider, model, record] of [
  ['bubble', 'openai:gpt-5.5', usage], ['pi', 'openai/gpt-5.5', usage], ['pi', 'zai/glm-5.3-flash', usage],
  ['kimi', 'kimi-code/k3', usage], ['kimi', 'kimi-code/k3', writes], ['kimi', 'kimi-code/k3.1-pro', usage], ['kimi', 'kimi-for-coding/k3.1-pro', writes], ['devin', 'claude-opus-5-5-medium', usage], ['devin', 'gpt-6-1-sol-medium', usage], ['opencode', 'claude-fable-5-2', usage], ['kimi', 'moonshot-cn/kimi-k2.7-code-highspeed', writes],
  ['minimax', 'm:minimax:MiniMax-M3.1-Flash:v:thinking', minimaxUsage], ['minimax', 'MiniMax-M3', { ...minimaxUsage, cache_creation_input_tokens: 1000 }],
  ['opencode', 'claude-sonnet-4-6', usage], ['codex', 'gpt-5.6-sol', { input_tokens: 100000, output_tokens: 2000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000 }],
] as const) {
  near(sumOf(apiCostWeights(provider, model, record)), estimateAgentApiCost(provider, model, record)!);
}
// Bubble and Codex count cached input inside input; the split takes it back out.
assert.deepEqual(usageTokenParts('bubble', usage), { input: 50000, cacheRead: 50000, cacheWrite: 0, output: 1000 });
assert.deepEqual(usageTokenParts('pi', usage), { input: 100000, cacheRead: 50000, cacheWrite: 0, output: 1000 });
// A Claude model that is not in the price list splits by Anthropic's rate structure.
const shape = apiCostWeights('claude', 'claude-next-9', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 })!;
near(shape.cacheRead / shape.input, 0.1); near(shape.cacheWrite / shape.input, 1.25); near(shape.output / shape.input, 5);
// An unknown cache TTL refuses a price but still gives proportions.
assert.equal(estimateAgentApiCost('claude', 'claude-sonnet-4-6', writes), null);
assert(sumOf(apiCostWeights('claude', 'claude-sonnet-4-6', writes))! > 0);
assert.equal(apiCostWeights('pi', 'custom/k3', usage), null, 'no rates, no proportions');
const split = emptyCostByType();
addCostByType(split, usageTokenParts('pi', usage), 10, apiCostWeights('pi', 'openai/gpt-5.5', usage));
near(split.inputCostUsd + split.cacheReadCostUsd + split.cacheWriteCostUsd + split.outputCostUsd, 10);
near(split.inputCostUsd, 10 * .5 / .555); near(split.cacheReadCostUsd, 10 * .025 / .555);
assert.deepEqual([split.inputTokens, split.cacheReadTokens, split.cacheWriteTokens, split.outputTokens], [100000, 50000, 0, 1000]);
addCostByType(split, usageTokenParts('pi', usage), 4, null);
near(split.unsplitCostUsd, 4); assert.equal(split.inputTokens, 200000, 'tokens count even when the cost cannot be split');
addCostByType(split, usageTokenParts('pi', usage), 0, null);
near(split.unsplitCostUsd, 4);
console.log('agent cost: native priority, zero, partial steps, cache semantics and unknown prices, cost by type passed');

import assert from 'node:assert/strict';
import { addAgentCost, costFields, emptyCostDetails, estimateAgentApiCost } from '../../src/electron/libs/agent-cost';
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
console.log('agent cost: native priority, zero, partial steps, cache semantics and unknown prices passed');

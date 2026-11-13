import type { AgentProvider, ProviderCostDetails, Usage, UsageCostByType } from '../../shared/types';
import { estimateCodexUsageCost, estimateCodexUsageCostParts, getCodexPriceEntry } from './codex-pricing';
import { estimateDeepseekUsageCost, getDeepseekPrice } from './deepseek-pricing';

export const validUsd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function emptyCostDetails(): ProviderCostDetails {
  return { reportedUsd: 0, estimatedUsd: 0, reportedCount: 0, estimatedCount: 0, unpricedCount: 0 };
}

/** Public API rates. Subscription aliases below use explicit estimate proxies.
 * USD / million, verified 2026-09-20:
 * https://docs.z.ai/guides/overview/pricing
 * https://docs.x.ai/developers/models (default US region, excluding tool fees)
 * https://platform.kimi.ai/docs/pricing/chat (international API equivalent)
 */
const API_PRICES: Record<string, [number, number, number]> = {
  'glm-5.3': [1.4, 0.26, 4.4],
  'glm-5.3-flash': [0.15, 0.03, 0.5],
  'glm-5.3-flashx': [0.37, 0.075, 1.25],
  'glm-5.2': [1.4, 0.26, 4.4],
  'glm-5.1': [1.4, 0.26, 4.4],
  'glm-5': [1, 0.2, 3.2],
  'grok-4.6': [2, 0.5, 6],
  'grok-4.5': [2, 0.3, 6],
  'kimi-k3': [3, 0.3, 15],
  'kimi-k2.7-code': [0.95, 0.19, 4],
  'kimi-k2.7-code-highspeed': [1.9, 0.38, 8],
  'kimi-k2.6': [0.95, 0.16, 4],
};

/** Current API equivalents for Kimi subscription names, not a claim about
 * the historical backend behind a rolling alias. Keep unknown names unknown. */
const KIMI_ESTIMATE_MODELS: Record<string, string> = {
  k3: 'kimi-k3',
  'kimi-for-coding': 'kimi-k3',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
};

// https://platform.claude.com/docs/en/about-claude/pricing, verified 2026-09-20.
const CLAUDE_PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 0.25, 50], 'claude-mythos-5-1': [10, 0.25, 50],
  'claude-fable-5': [10, 1, 50], 'claude-mythos-5': [10, 1, 50],
  'claude-opus-5': [5, 0.5, 25], 'claude-opus-4-8': [5, 0.5, 25],
  'claude-opus-4-7': [5, 0.5, 25], 'claude-opus-4-6': [5, 0.5, 25],
  'claude-opus-4-5': [5, 0.5, 25], 'claude-sonnet-5': [2, 0.2, 10],
  'claude-sonnet-4-6': [3, 0.3, 15], 'claude-sonnet-4-5': [3, 0.3, 15],
  'claude-haiku-4-5': [1, 0.1, 5],
};

/** MiniMax pay-as-you-go text rates, USD / million [input, cache read, output],
 * standard service tier, verified 2026-10-20:
 * https://platform.minimax.io/docs/pricing/overview
 * Mainland rates (https://platform.minimaxi.com/docs/pricing/overview) are the
 * same list in CNY at 7x. Thinking and non-thinking bill alike; no cache-write
 * tier is listed, so written tokens bill as input. M3 doubles every rate once
 * a request's input (cache hits included) exceeds 512K tokens. */
const MINIMAX_PRICES: Record<string, { rates: [number, number, number]; longContext?: [number, number, number] }> = {
  'minimax-m3': { rates: [0.3, 0.06, 1.2], longContext: [0.6, 0.12, 2.4] },
  'minimax-m3.1-flash': { rates: [0.15, 0.015, 0.6] },
};
const MINIMAX_LONG_CONTEXT_TOKENS = 512_000;

const count = (n: unknown) => validUsd(n) ? n : 0;

/** The id a model is priced under: the bare model name, with Kimi's subscription names mapped to API ones. */
function pricedModelId(provider: AgentProvider, model: string): string {
  const qualifiedModel = model.trim().toLowerCase();
  // MiniMax Code records its select value, `m:<provider>:<model>:v:<variant>`.
  const mcodeModel = /^m:[^:]+:([^:]+):[uv]\b/.exec(qualifiedModel)?.[1];
  const rawId = mcodeModel ? decodeURIComponent(mcodeModel) : qualifiedModel.split(/[/:]/).pop() || '';
  const kimiModel = provider === 'kimi' || /^(kimi-code|kimi-for-coding|moonshot(?:-cn|-ai)?)[/:]/.test(qualifiedModel);
  return kimiModel ? KIMI_ESTIMATE_MODELS[rawId] || rawId : rawId;
}

/** Tokens or dollars by what was billed: uncached input, cache reads, cache writes and output. */
export interface UsageTypeParts { input: number; cacheRead: number; cacheWrite: number; output: number }

/** A usage record's tokens by type, with uncached input apart from the cache buckets. */
export function usageTokenParts(provider: AgentProvider, usage: Usage | null | undefined): UsageTypeParts {
  const cacheRead = count(usage?.cache_read_input_tokens);
  const cacheWrite = count(usage?.cache_creation_input_tokens);
  // Bubble SDK promptTokens includes cached input; Pi/Claude/OpenCode/Kimi
  // expose uncached input and cache buckets separately.
  const includesCache = provider === 'bubble' || provider === 'codex';
  return {
    input: Math.max(0, count(usage?.input_tokens) - (includesCache ? cacheRead + cacheWrite : 0)),
    cacheRead,
    cacheWrite,
    output: count(usage?.output_tokens),
  };
}

export function estimateAgentApiCost(
  provider: AgentProvider, model: string, usage: Usage | null | undefined,
  atMs = Date.now(), perRequest = false,
): number | null {
  if (!usage) return null;
  const id = pricedModelId(provider, model);
  const { input, cacheRead: read, cacheWrite: write, output } = usageTokenParts(provider, usage);
  // Grok's legacy Claude-compatible records and native ACP records do not
  // yet carry a cache-bucket accounting version. A missing-cost cached turn
  // cannot safely establish whether input includes those buckets.
  if (provider === 'grok' && (read > 0 || write > 0)) return null;
  const allInput = input + read + write;
  // A known model's explicitly reported zero usage contributes zero; context
  // occupancy alone still cannot be used as billable usage.
  if (allInput + output === 0 && (count(usage.total_tokens) > 0
    || !validUsd(usage.input_tokens) || !validUsd(usage.output_tokens))) return null;
  const claude = CLAUDE_PRICES[id.replace(/-\d{8}$/, '').replaceAll('.', '-')];
  if (claude) {
    // Older Sonnet 4.5 has per-request long-context pricing; aggregated
    // records above its boundary cannot be reconstructed safely.
    if (id.startsWith('claude-sonnet-4-5') && allInput > 200_000) return null;
    const cache = (usage as Usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation;
    const hour = Math.min(write, count(cache?.ephemeral_1h_input_tokens));
    // Without a TTL split do not silently price unknown writes at 5m rates.
    if (write > 0 && !cache) return null;
    return (input * claude[0] + read * claude[1] + (write - hour) * claude[0] * 1.25
      + hour * claude[0] * 2 + output * claude[2]) / 1_000_000;
  }
  const openai = getCodexPriceEntry(id);
  if (openai) {
    // A turn aggregate cannot tell whether any individual request crossed
    // the long-context boundary. Never apply a per-request premium to it.
    if (!perRequest && openai.longContext && allInput > 272_000) return null;
    return estimateCodexUsageCost(id, { inputTokens: allInput, cachedInputTokens: read,
      cacheWriteInputTokens: write, outputTokens: output });
  }
  const deepseek = write === 0 ? estimateDeepseekUsageCost(id,
    { inputTokens: input, outputTokens: output, cacheReadTokens: read }, atMs) : null;
  if (deepseek !== null) return deepseek;
  const minimax = MINIMAX_PRICES[id];
  if (minimax) {
    const long = allInput > MINIMAX_LONG_CONTEXT_TOKENS;
    // A turn aggregate cannot tell whether one request crossed the boundary.
    if (long && minimax.longContext && !perRequest) return null;
    const rates = long && minimax.longContext ? minimax.longContext : minimax.rates;
    return ((input + write) * rates[0] + read * rates[1] + output * rates[2]) / 1_000_000;
  }
  const price = API_PRICES[id];
  if (id === 'kimi-k3' && price) {
    const cache = (usage as Usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation;
    // Estimate unspecified TTL at the official API default of 5 minutes.
    const hour = Math.min(write, count(cache?.ephemeral_1h_input_tokens));
    return (input * price[0] + read * price[1] + (write - hour) * 3 + hour * 6 + output * price[2]) / 1_000_000;
  }
  if (!price) return null;
  const grok = id.startsWith('grok-');
  if (grok && !perRequest && allInput >= 200_000) return null;
  const multiplier = grok && allInput >= 200_000 ? 2 : 1;
  // These APIs have no separate cache-write token tier: newly written
  // tokens are ordinary cache-miss input (cache storage is not a token fee).
  return ((input + write) * price[0] + read * price[1] + output * price[2]) * multiplier / 1_000_000;
}

/** Anthropic's rate structure, relative to a model's input rate: cache reads
 * 0.1x, 5-minute cache writes 1.25x (1-hour 2x), output 5x. Splits the cost of
 * a Claude model that is not in the price list yet. */
const CLAUDE_RATE_SHAPE: [number, number, number] = [1, 0.1, 5];

/**
 * What each type of token would cost at list prices, for splitting an amount
 * by type. Only the proportions are used, so it answers where
 * estimateAgentApiCost refuses to name a price (an unknown cache TTL, a turn
 * past a long-context boundary). Null when the model has no listed rates.
 */
export function apiCostWeights(
  provider: AgentProvider, model: string, usage: Usage | null | undefined, atMs = Date.now(),
): UsageTypeParts | null {
  if (!usage) return null;
  const id = pricedModelId(provider, model);
  const { input, cacheRead, cacheWrite, output } = usageTokenParts(provider, usage);
  const at = (inputRate: number, readRate: number, writeRate: number, outputRate: number): UsageTypeParts => ({
    input: input * inputRate / 1_000_000,
    cacheRead: cacheRead * readRate / 1_000_000,
    cacheWrite: cacheWrite * writeRate / 1_000_000,
    output: output * outputRate / 1_000_000,
  });
  const hourWrites = Math.min(cacheWrite,
    count((usage as Usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation?.ephemeral_1h_input_tokens));
  // A cache-write rate that blends the 5-minute and 1-hour tiers this record used.
  const tiered = (short: number, hour: number) =>
    cacheWrite > 0 ? ((cacheWrite - hourWrites) * short + hourWrites * hour) / cacheWrite : short;
  const claudeId = id.replace(/-\d{8}$/, '').replaceAll('.', '-');
  const claude = CLAUDE_PRICES[claudeId] ?? (claudeId.startsWith('claude-') ? CLAUDE_RATE_SHAPE : undefined);
  if (claude) return at(claude[0], claude[1], tiered(claude[0] * 1.25, claude[0] * 2), claude[2]);
  if (getCodexPriceEntry(id)) {
    return estimateCodexUsageCostParts(id, { inputTokens: input + cacheRead + cacheWrite,
      cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens: output });
  }
  const deepseek = getDeepseekPrice(id, atMs);
  if (deepseek) {
    return at(deepseek.cacheMissInputUsdPerMillion, deepseek.cacheHitInputUsdPerMillion,
      deepseek.cacheMissInputUsdPerMillion, deepseek.outputUsdPerMillion);
  }
  const minimax = MINIMAX_PRICES[id];
  if (minimax) return at(minimax.rates[0], minimax.rates[1], minimax.rates[0], minimax.rates[2]);
  const price = API_PRICES[id];
  if (!price) return null;
  return at(price[0], price[1], id === 'kimi-k3' ? tiered(3, 6) : price[0], price[2]);
}

export function emptyCostByType(): UsageCostByType {
  return {
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    inputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: 0,
    unsplitCostUsd: 0,
  };
}

/** Count a record's tokens by type and share its cost out in the weights' proportions. */
export function addCostByType(
  target: UsageCostByType, tokens: UsageTypeParts, usd: number, weights: UsageTypeParts | null,
): void {
  target.inputTokens += tokens.input;
  target.cacheReadTokens += tokens.cacheRead;
  target.cacheWriteTokens += tokens.cacheWrite;
  target.outputTokens += tokens.output;
  if (!(usd > 0)) return;
  const sum = weights ? weights.input + weights.cacheRead + weights.cacheWrite + weights.output : 0;
  if (!weights || !(sum > 0)) {
    target.unsplitCostUsd += usd;
    return;
  }
  target.inputCostUsd += usd * weights.input / sum;
  target.cacheReadCostUsd += usd * weights.cacheRead / sum;
  target.cacheWriteCostUsd += usd * weights.cacheWrite / sum;
  target.outputCostUsd += usd * weights.output / sum;
}

/** Resolve each request before summing: preserve returned zero and never
 * replace a partially reported turn with an estimate of the entire turn. */
export function addAgentCost(
  details: ProviderCostDetails, provider: AgentProvider, model: string,
  usage: Usage | null | undefined, reportedUsd: unknown, atMs = Date.now(), perRequest = true,
): void {
  if (validUsd(reportedUsd)) {
    details.reportedUsd += reportedUsd;
    details.reportedCount += 1;
    return;
  }
  const estimate = estimateAgentApiCost(provider, model, usage, atMs, perRequest);
  if (estimate === null) details.unpricedCount += 1;
  else { details.estimatedUsd += estimate; details.estimatedCount += 1; }
}

export function costFields(details: ProviderCostDetails) {
  const snapshot = { ...details };
  if (!(snapshot.reportedCount + snapshot.estimatedCount + snapshot.unpricedCount)) snapshot.unpricedCount = 1;
  return {
    total_cost_usd: details.reportedUsd + details.estimatedUsd,
    costSource: details.unpricedCount || !(details.reportedCount + details.estimatedCount)
      ? 'unavailable' as const : details.estimatedCount ? 'estimated' as const : 'reported' as const,
    costDetails: snapshot,
  };
}

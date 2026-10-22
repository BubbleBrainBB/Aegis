import assert from 'node:assert/strict';
import { withClaudeContextUsage, type ClaudeContextSnapshot } from '../../src/ui/utils/context-usage';
import type { ClaudeContextUsage } from '../../src/shared/types';

const estimate: ClaudeContextSnapshot = {
  model: 'claude-opus-5-5',
  used: 1200,
  total: 200000,
  percent: 1,
  costUSD: 0.42,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  maxOutputTokens: 64000,
  webSearchRequests: 0,
};
const reported: ClaudeContextUsage = {
  model: 'claude-opus-5-5',
  totalTokens: 250000,
  maxTokens: 1000000,
  percentage: 25,
  categories: [
    { name: 'System tools', tokens: 22000, kind: 'used' },
    { name: 'Messages', tokens: 228000, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 717000, kind: 'free' },
    { name: 'MCP tools (deferred)', tokens: 85400, kind: 'deferred' },
  ],
  counts: { mcpTools: 0, memoryFiles: 2, agents: 3, skills: 132 },
};

// Claude Code's own figures replace the estimate's window numbers and bring the breakdown along.
{
  const merged = withClaudeContextUsage(estimate, reported, 'claude-opus-5-5');
  assert.equal(merged?.used, 250000);
  assert.equal(merged?.total, 1000000);
  assert.equal(merged?.percent, 25);
  assert.equal(merged?.costUSD, 0.42);
  assert.equal(merged?.inputTokens, 1000);
  assert.deepEqual(merged?.categories?.map((c) => c.kind), ['used', 'used', 'buffer', 'free', 'deferred']);
  assert.deepEqual(merged?.counts, { mcpTools: 0, memoryFiles: 2, agents: 3, skills: 132 });
}

// Without an estimate (a fresh window) the reported figures still show.
{
  const merged = withClaudeContextUsage(null, reported, 'claude-opus-5-5');
  assert.equal(merged?.percent, 25);
  assert.equal(merged?.costUSD, 0);
}

// Another model's report, or none, leaves the estimate alone.
assert.equal(withClaudeContextUsage(estimate, reported, 'claude-sonnet-4-6'), estimate);
assert.equal(withClaudeContextUsage(estimate, undefined, 'claude-opus-5-5'), estimate);
assert.equal(withClaudeContextUsage(estimate, { ...reported, maxTokens: 0 }, 'claude-opus-5-5'), estimate);
assert.equal(withClaudeContextUsage(null, undefined, 'claude-opus-5-5'), null);

console.log('claude sdk signals: context usage merge passed');

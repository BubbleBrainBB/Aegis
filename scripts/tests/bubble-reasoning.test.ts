import assert from 'node:assert/strict';
import {
  carriedBubbleThinkingLevel,
  getDefaultBubbleThinkingLevel,
} from '../../src/ui/utils/bubble-reasoning';
import type { BubbleModelConfig } from '../../src/ui/types';

const entry = (name: string, reasoningLevels: string[], defaultReasoningLevel: string | null = null) => ({
  name, label: name, provider: null, enabled: true, isDefault: false, maxContextSize: null, capabilities: [],
  reasoningLevels, defaultReasoningLevel,
});
const models: BubbleModelConfig['availableModels'] = [
  entry('moss:nex-n2.6', []),
  entry('openai:graded', ['low', 'medium', 'high'], 'high'),
];

// A model that always thinks lists no level: nothing is preselected or sent,
// and the "medium" an older session carries for it is dropped.
assert.equal(getDefaultBubbleThinkingLevel(models, 'moss:nex-n2.6'), null);
assert.equal(carriedBubbleThinkingLevel(models, 'moss:nex-n2.6', 'medium'), null);

// A graded model keeps what the session carries, and a model the catalog has
// not listed yet keeps it too (its levels may arrive with live discovery).
assert.equal(carriedBubbleThinkingLevel(models, 'openai:graded', 'low'), 'low');
assert.equal(carriedBubbleThinkingLevel(models, 'openai:not-listed', 'high'), 'high');
assert.equal(carriedBubbleThinkingLevel(undefined, 'openai:graded', 'high'), 'high');
assert.equal(carriedBubbleThinkingLevel(models, 'openai:graded', undefined), null);
assert.equal(getDefaultBubbleThinkingLevel(models, 'openai:graded'), 'high');

console.log('Bubble reasoning: no level for an always-thinking model, carried levels kept elsewhere passed');

import assert from 'node:assert/strict';
import {
  bubbleThinkingChipLabel,
  carriedBubbleThinkingLevel,
  formatBubbleThinkingLevelLabel,
  getDefaultBubbleThinkingLevel,
  isBubbleThinkingToggle,
} from '../../src/ui/utils/bubble-reasoning';
import { bubbleThinkingLevelName, bubbleThinkingLevelNames, bubbleThinkingWireLevel } from '../../src/shared/bubble-reasoning';
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

// A model that only switches thinking lists exactly "off" and "medium" (the
// SDK's isThinkingToggleLevels rule). "medium" is what is sent for on, so it
// reads "On"; the same level on a graded model is a grade and reads "Medium".
const toggle = ['off', 'medium'];
const graded = ['low', 'medium', 'high'];
assert.equal(isBubbleThinkingToggle(toggle), true);
assert.equal(isBubbleThinkingToggle(['medium', 'off']), true, 'in either order');
for (const levels of [graded, ['off', 'low', 'medium'], ['off', 'high'], ['off'], ['medium'], ['max'], [], undefined, null]) {
  assert.equal(isBubbleThinkingToggle(levels), false, `${JSON.stringify(levels)} is not a switch`);
}
assert.equal(formatBubbleThinkingLevelLabel('medium', toggle), 'On');
assert.equal(formatBubbleThinkingLevelLabel('off', toggle), 'Off');
assert.equal(formatBubbleThinkingLevelLabel('medium', graded), 'Medium');
assert.equal(formatBubbleThinkingLevelLabel('medium', ['off', 'low', 'medium']), 'Medium');
assert.equal(formatBubbleThinkingLevelLabel('medium'), 'Medium', 'levels not known: the grade name');
assert.equal(formatBubbleThinkingLevelLabel('xhigh', graded), 'X-High');
assert.equal(formatBubbleThinkingLevelLabel('max', ['max']), 'Max');

// The composer chip names a switch by what it switches: "Thinking" while on,
// nothing while off. A graded model's chip still shows its grade.
assert.equal(bubbleThinkingChipLabel('medium', toggle), 'Thinking');
assert.equal(bubbleThinkingChipLabel('off', toggle), null);
assert.equal(bubbleThinkingChipLabel('medium', graded), 'Medium');
assert.equal(bubbleThinkingChipLabel('off', ['off', 'low', 'medium']), 'Off');
assert.equal(bubbleThinkingChipLabel('max', ['max']), 'Max');

// Only the name changes: what a turn sends for on is still "medium".
assert.deepEqual(bubbleThinkingLevelNames(toggle), ['off', 'on']);
assert.deepEqual(bubbleThinkingLevelNames(graded), graded);
assert.equal(bubbleThinkingLevelName('medium', toggle), 'on');
assert.equal(bubbleThinkingLevelName('medium', graded), 'medium');
assert.equal(bubbleThinkingWireLevel('on'), 'medium');
assert.equal(bubbleThinkingWireLevel('off'), 'off');
assert.equal(bubbleThinkingWireLevel('high'), 'high');
assert.equal(getDefaultBubbleThinkingLevel([entry('zhipuai-coding-plan:glm-5.1', toggle)], 'zhipuai-coding-plan:glm-5.1'), 'medium');

console.log('Bubble reasoning: no level for an always-thinking model, On/Off for a thinking switch, carried levels kept elsewhere passed');

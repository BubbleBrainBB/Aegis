// A Bubble model that always thinks and has no grades offers no reasoning
// level: the SDK's catalog marks it with a lone "medium", a placeholder that
// must not reach a picker. Read through the real SDK catalog.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-bubble-thinking-only-'));
const previousHome = process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME = path.join(tmp, 'bubble');
fs.mkdirSync(process.env.BUBBLE_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.BUBBLE_HOME, 'config.json'), JSON.stringify({
  providers: [
    { id: 'moss', name: 'MOSS', baseURL: 'https://api.mosi.cn/v1', apiKey: 'test-key', enabled: true },
    { id: 'alibaba', name: 'Alibaba DashScope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-key', enabled: true },
    { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'test-key', enabled: true },
  ],
  defaultProvider: 'moss',
  defaultModel: 'moss:nex-n2.6',
}));

const original = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? { app: { getPath: () => tmp } } : original.call(this, name, ...args);
};

(async () => {
  const settings = require('../../dist-electron/electron/libs/bubble-settings.js');

  const pick = settings.bubbleSelectableReasoningLevels;
  assert.deepEqual(pick(['medium']), [], 'a lone medium is the always-thinking placeholder');
  assert.deepEqual(pick(['max']), ['max'], 'another lone level is a real fixed grade');
  assert.deepEqual(pick(['off']), ['off']);
  assert.deepEqual(pick(['off', 'medium']), ['off', 'medium'], 'a thinking toggle keeps both of its states');
  assert.deepEqual(pick(['low', 'medium', 'high']), ['low', 'medium', 'high']);
  assert.deepEqual(pick(['medium', '', null]), [], 'blank entries are not levels');
  assert.deepEqual(pick(undefined), []);

  const { isThinkingOnlyLevels } = await import('@bubblebrain-ai/bubble/dist/variant/variant-resolver.js');
  for (const levels of [['medium'], ['max'], ['off'], ['off', 'medium'], ['low', 'medium', 'high'], []]) {
    assert.equal(pick(levels).length === 0 && levels.length > 0, isThinkingOnlyLevels(levels),
      `same rule as the SDK for ${JSON.stringify(levels)}`);
  }

  const config = await settings.getBubbleModelConfig();
  const model = (suffix) => {
    const found = config.availableModels.find((entry) => entry.name.endsWith(suffix));
    assert(found, `${suffix} is listed (${config.availableModels.map((entry) => entry.name).join(', ')})`);
    return found;
  };
  const nex = model(':nex-n2.6');
  assert.deepEqual(nex.reasoningLevels, [], 'Nex-N2.6 always thinks: no level to choose');
  assert.equal(nex.defaultReasoningLevel, null);
  assert.equal(nex.maxContextSize, 1000000);

  const kimiCode = model(':kimi-k2.7-code');
  assert.deepEqual(kimiCode.reasoningLevels, [], 'Kimi K2.7 Code always thinks too');

  const fixed = model(':kimi/kimi-k3');
  assert.deepEqual(fixed.reasoningLevels, ['max'], 'a fixed real grade is still shown');
  assert.equal(fixed.defaultReasoningLevel, 'max');

  // GLM-5.4 (SDK 0.0.74, Zhipu Coding Plan only) has three real grades and
  // starts at the highest; the picker lists them as the catalog gives them.
  const glm = model('zhipuai-coding-plan:glm-5.4');
  assert.deepEqual(glm.reasoningLevels, ['low', 'high', 'max']);
  assert.equal(glm.defaultReasoningLevel, 'max');
  assert.equal(glm.maxContextSize, 1000000);
  assert.deepEqual(model('zhipuai-coding-plan:glm-5.1').reasoningLevels, ['off', 'medium'], 'an on/off GLM keeps its switch');

  // A model that only switches thinking keeps both states, "off" and the
  // "medium" a turn sends for on, and Aegis shows them as Off and On. Its
  // rule for telling such a model from a graded one is the SDK's.
  const { isBubbleThinkingToggle } = require('../../dist-electron/shared/bubble-reasoning.js');
  const { isThinkingToggleModel } = await import('@bubblebrain-ai/bubble/dist/variant/variant-resolver.js');
  const sdkVersion = require('@bubblebrain-ai/bubble/package.json').version.split('.').map(Number);
  // Before 0.0.73 the SDK told switches apart by a list of names that left GLM out.
  const sdkKnowsGlmSwitches = sdkVersion[0] > 0 || sdkVersion[1] > 0 || sdkVersion[2] >= 73;
  const sameAsSdk = (entry) => {
    const [providerId, ...rest] = entry.name.split(':');
    assert.equal(isBubbleThinkingToggle(entry.reasoningLevels), isThinkingToggleModel(providerId, rest.join(':')),
      `same rule as the SDK for ${entry.name} ${JSON.stringify(entry.reasoningLevels)}`);
  };
  const kimiSwitch = model('alibaba:kimi-k2.6');
  assert.deepEqual(kimiSwitch.reasoningLevels, ['off', 'medium']);
  assert.equal(isBubbleThinkingToggle(kimiSwitch.reasoningLevels), true);
  sameAsSdk(kimiSwitch);
  const glmSwitch = model('zhipuai-coding-plan:glm-5.1');
  assert.deepEqual(glmSwitch.reasoningLevels, ['off', 'medium']);
  assert.equal(isBubbleThinkingToggle(glmSwitch.reasoningLevels), true);
  if (sdkKnowsGlmSwitches) sameAsSdk(glmSwitch);
  // Every listed model with levels to choose from: a switch here is a switch there.
  for (const entry of config.availableModels) {
    const glm = /^(zhipuai|zai)/.test(entry.name);
    if (entry.reasoningLevels.length > 0 && (sdkKnowsGlmSwitches || !glm)) sameAsSdk(entry);
  }
  assert.equal(isBubbleThinkingToggle(fixed.reasoningLevels), false, 'a fixed grade is not a switch');
  assert.equal(isBubbleThinkingToggle(nex.reasoningLevels), false, 'a model that always thinks has no switch');

  const graded = config.availableModels.filter((entry) => entry.reasoningLevels.length > 1);
  assert(graded.length > 0, 'models with grades keep them');
  for (const entry of config.availableModels) {
    assert.notDeepEqual(entry.reasoningLevels, ['medium'], `${entry.name} does not offer the placeholder`);
  }

  console.log('Bubble thinking-only models: no placeholder level, switches told apart as the SDK does, fixed grades and graded models unchanged passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = original;
  if (previousHome === undefined) delete process.env.BUBBLE_HOME; else process.env.BUBBLE_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

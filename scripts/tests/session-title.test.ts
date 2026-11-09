import assert from 'node:assert/strict';
import {
  generateSessionTitleLocally,
  getSessionTitleDisplay,
  parseGeneratedTitle,
  sessionTitlePrompt,
  truncateSessionTitle,
} from '../../src/shared/session-title';

const prompt = '你帮我看下这个项目，我刚刚做了一些功能，在这个分支上，并且发生过对话的我记得，但是为啥好像我本地有这个功能却看不到之前的聊天记录';
const legacy = prompt.slice(0, 50);
assert.equal(generateSessionTitleLocally(prompt), prompt.slice(0, 49) + '…');
assert.equal(getSessionTitleDisplay(legacy, prompt), legacy + '…');
assert.equal(getSessionTitleDisplay(legacy), legacy, 'unloaded history is not proof of truncation');
assert.equal(getSessionTitleDisplay(legacy, '另一条完全不同的消息'), legacy, 'custom titles stay intact');
assert.equal(getSessionTitleDisplay(legacy, legacy), legacy, 'exactly 50 characters can be a complete title');
assert.equal(generateSessionTitleLocally('修复侧栏。然后检查测试'), '修复侧栏');
assert.equal(generateSessionTitleLocally('  **Fix** the sidebar  '), 'Fix the sidebar');
assert.equal(generateSessionTitleLocally('   '), '');
assert.equal(truncateSessionTitle('短标题'), '短标题');
assert.equal(truncateSessionTitle('中'.repeat(50)), '中'.repeat(50));
assert.equal(truncateSessionTitle('🧠'.repeat(51)), '🧠'.repeat(49) + '…', 'do not split emoji surrogate pairs');
const marked = truncateSessionTitle(prompt);
assert.equal(getSessionTitleDisplay(marked, prompt), marked, 'do not append ellipsis twice');
// What an agent replies when asked for a title.
assert.equal(parseGeneratedTitle('<title>侧边栏改动卡片丢失</title>'), '侧边栏改动卡片丢失');
assert.equal(parseGeneratedTitle('Sure!\n<title>Sidebar task order</title>\nAnything else?'), 'Sidebar task order', 'only the tag counts');
assert.equal(parseGeneratedTitle('<reasoning_effort>15</reasoning_effort> Agent 改完代码后改动卡片消失'), 'Agent 改完代码后改动卡片消失',
  'a context tag the model echoed is dropped');
assert.equal(parseGeneratedTitle('<title><reasoning_effort>15</reasoning_effort>Change card missing</title>'), 'Change card missing');
assert.equal(parseGeneratedTitle('"Fix login button."'), 'Fix login button', 'quotes and a closing period go');
assert.equal(parseGeneratedTitle('Title: Release notes'), 'Release notes');
assert.equal(parseGeneratedTitle('**Usage menu**'), 'Usage menu');
assert.equal(parseGeneratedTitle('Use a <Button> here'), 'Use a here', 'stray tags are not a title');
assert.equal(parseGeneratedTitle('<title></title>'), null);
assert.equal(parseGeneratedTitle('  \n '), null);
assert.equal(parseGeneratedTitle('标'.repeat(60)), '标'.repeat(49) + '…');
assert.ok(sessionTitlePrompt('fix the sidebar').includes('<request>\nfix the sidebar\n</request>'));
console.log('session-title tests passed');

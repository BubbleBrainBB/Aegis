import assert from 'node:assert/strict';
import {
  buildClaudeModelOptions,
  formatClaudeModelLabel,
  isOfficialClaudeModel,
  listedClaudeAliasFor,
} from '../../src/ui/utils/claude-model';

// The composer shows the id a listed alias resolved to as that alias, not as
// Default (a session stores the concrete id after its first turn).
assert.equal(listedClaudeAliasFor('claude-haiku-5-5', ['haiku', 'opus']), 'haiku', 'resolved id reads as its alias');
assert.equal(listedClaudeAliasFor('claude-haiku-5-5', ['opus', 'haiku']), 'haiku');
assert.equal(listedClaudeAliasFor('claude-haiku-4-5', ['haiku', 'claude-haiku-5-5']), null, 'an older pinned id stays itself');
assert.equal(listedClaudeAliasFor('claude-sonnet-5-5', ['haiku', 'opus']), null, 'no alias listed for its family');
assert.equal(listedClaudeAliasFor('claude-fable-5-1', ['haiku']), null, 'not a family model');
assert.equal(listedClaudeAliasFor(null, ['haiku']), null);

// A model is named from its id whatever its family: no list of families to keep.
assert.equal(formatClaudeModelLabel('claude-fable-5-2'), 'Fable 5.2', 'a family the picker has never heard of');
assert.equal(formatClaudeModelLabel('claude-opus-5-5[1m]'), 'Opus 5.5');
assert.equal(formatClaudeModelLabel('claude-opus-5'), 'Opus 5', 'no minor version, none shown');
assert.equal(formatClaudeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5', 'a date is not a version');
assert.equal(formatClaudeModelLabel('claude-opus-4-20250514'), 'Opus 4');
assert.equal(formatClaudeModelLabel('opus'), 'Opus (latest)', 'an alias nobody resolved');
assert.equal(formatClaudeModelLabel('glm-5'), 'glm-5', 'not a Claude id: shown as is');

// Claude Code's own rows, as its model list returns them.
const rows = [
  { id: 'default', resolvedModel: 'claude-fable-5-2', label: 'Default (recommended)' },
  { id: 'opus', resolvedModel: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', label: 'Fable 5.2' },
  { id: 'sonnet', resolvedModel: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'haiku', resolvedModel: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'fable', resolvedModel: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-opus-5', resolvedModel: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', resolvedModel: 'claude-fable-5', label: 'Fable 5' },
];
const config = (listed: typeof rows | undefined, list = rows) => ({
  defaultModel: null,
  options: [...new Set(list.flatMap((row) => [row.id, row.resolvedModel]))],
  listed,
});
const picker = (value: ReturnType<typeof config>) =>
  buildClaudeModelOptions(value)
    .filter(isOfficialClaudeModel)
    .map((id) => formatClaudeModelLabel(id, value.listed));

assert.deepEqual(
  picker(config(rows)),
  ['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'],
  'one entry per family; an alias reads as the version it resolves to'
);

// A Claude Code that cannot see the account lists bare names and a '[1m]' id.
const bare = [
  { id: 'default', resolvedModel: 'claude-opus-5-5', label: 'Default (recommended)' },
  { id: 'opus', resolvedModel: 'claude-opus-5-5', label: 'Opus' },
  { id: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', label: 'Fable' },
  { id: 'sonnet', resolvedModel: 'claude-sonnet-5-5', label: 'Sonnet' },
  { id: 'haiku', resolvedModel: 'claude-haiku-5-5', label: 'Haiku' },
];
assert.deepEqual(picker(config(bare, bare)), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5']);
assert.equal(formatClaudeModelLabel('opus[1m]', [{ id: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]' }]), 'Opus 5.5');
assert.equal(
  formatClaudeModelLabel('claude-next', [{ id: 'claude-next', label: 'Next' }]),
  'Next',
  'an id with no version to read takes the name Claude Code gives it'
);
assert.deepEqual(
  picker(config(undefined)),
  ['Fable 5.2', 'Opus (latest)', 'Sonnet (latest)', 'Haiku (latest)'],
  'ids alone (Claude Code did not answer, or an older host) still collapse and read well'
);

// An alias that lags behind a listed model does not hide that model.
const lagging = [...rows, { id: 'claude-opus-6', resolvedModel: 'claude-opus-6', label: 'Opus 6' }];
assert.deepEqual(picker(config(lagging, lagging)), ['Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 6']);

// The selected model stays listed even when a newer one exists.
assert.ok(buildClaudeModelOptions(config(rows), ['claude-fable-5']).includes('claude-fable-5'));

console.log('claude-model-alias.test: all assertions passed');

import assert from 'node:assert/strict';
import { listedClaudeAliasFor } from '../../src/ui/utils/claude-model';

// The composer shows the id a listed alias resolved to as that alias, not as
// Default (a session stores the concrete id after its first turn).
assert.equal(listedClaudeAliasFor('claude-haiku-5-5', ['haiku', 'opus']), 'haiku', 'resolved id reads as its alias');
assert.equal(listedClaudeAliasFor('claude-haiku-5-5', ['opus', 'haiku']), 'haiku');
assert.equal(listedClaudeAliasFor('claude-haiku-4-5', ['haiku', 'claude-haiku-5-5']), null, 'an older pinned id stays itself');
assert.equal(listedClaudeAliasFor('claude-sonnet-5-5', ['haiku', 'opus']), null, 'no alias listed for its family');
assert.equal(listedClaudeAliasFor('claude-fable-5-1', ['haiku']), null, 'not a family model');
assert.equal(listedClaudeAliasFor(null, ['haiku']), null);

console.log('claude-model-alias.test: all assertions passed');

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chatFolderInstructions,
  chatFolderParts,
  createChatFolder,
  noteChatFolderInstructionsDelivered,
  takeChatFolderInstructions,
} from '../../src/electron/libs/chat-folders';
import { normalizeAppPreferences } from '../../src/shared/app-preferences';

const now = new Date(2026, 9, 31, 9, 5, 7);

// Named by date and the first words of the message.
assert.deepEqual(
  chatFolderParts('Compare SQLite and DuckDB for a 2 GB analytics workload', now),
  { day: '2026-10-31', name: 'compare-sqlite-and-duckdb-for-a' },
);
// A message without Latin words is named by the time.
assert.deepEqual(chatFolderParts('比较一下这两个数据库', now), { day: '2026-10-31', name: 'chat-090507' });
assert.equal(chatFolderParts('', now).name, 'chat-090507');

const root = mkdtempSync(path.join(tmpdir(), 'aegis-chats-'));
try {
  const first = createChatFolder('Rewrite the launch email', root, now);
  assert.equal(first, path.join(realpathSync(root), '2026-10-31', 'rewrite-the-launch-email'));
  assert.ok(statSync(path.join(first, 'outputs')).isDirectory());
  assert.ok(statSync(path.join(first, 'work')).isDirectory());
  // The same words on the same day get their own folder.
  const second = createChatFolder('Rewrite the launch email', root, now);
  assert.equal(second, `${first}-2`);
  assert.ok(existsSync(path.join(second, 'outputs')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// A date folder that links elsewhere must not move a chat out of the chats folder.
const linked = mkdtempSync(path.join(tmpdir(), 'aegis-chats-'));
const outside = mkdtempSync(path.join(tmpdir(), 'aegis-outside-'));
try {
  symlinkSync(outside, path.join(linked, '2026-10-31'));
  assert.throws(() => createChatFolder('Write a report', linked, now), /is a link to another folder/);
  assert.equal(existsSync(path.join(outside, 'write-a-report')), false, 'nothing is created outside');
} finally {
  rmSync(linked, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// The folder note goes out once per chat, and never to a project session.
assert.equal(takeChatFolderInstructions('project-session', '/work/repo', false), '');
const note = takeChatFolderInstructions('chat-a', '/chats/a', true);
assert.ok(note.includes(chatFolderInstructions('/chats/a')));
assert.ok(note.includes('outputs/') && note.includes('work/'));
assert.equal(takeChatFolderInstructions('chat-a', '/chats/a', true), '');
noteChatFolderInstructionsDelivered('chat-b');
assert.equal(takeChatFolderInstructions('chat-b', '/chats/b', true), '');

// Settings keep only an absolute chats folder; empty means the default.
assert.equal(normalizeAppPreferences({ chatsFolder: '/Users/me/Chats' }).chatsFolder, '/Users/me/Chats');
assert.equal(normalizeAppPreferences({ chatsFolder: 'relative/dir' }).chatsFolder, '');
assert.equal(normalizeAppPreferences({}).chatsFolder, '');

console.log('chat-folders: ok');

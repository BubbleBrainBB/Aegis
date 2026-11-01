// Chats keep their kind when a session is copied: forks, handoffs and
// sub-sessions in a chat's folder are chats; moving one into a project is not.
// Run under Electron's Node (ELECTRON_RUN_AS_NODE) for its native SQLite build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-chat-sessions-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => userData }, BrowserWindow: { getAllWindows: () => [] } };
  return load.call(this, id, ...args);
};
const sessions = require('../../dist-electron/electron/libs/session-store.js');
Module._load = load;

try {
  sessions.initialize();
  const chatFolder = path.join(userData, 'chats', '2026-10-31', 'compare-sqlite-and-duckdb');
  fs.mkdirSync(chatFolder, { recursive: true });
  const chat = sessions.createSession({ title: 'Compare', cwd: chatFolder, projectCwd: chatFolder, provider: 'claude', isChat: true });
  assert.equal(chat.is_chat, 1);

  // A fork or provider handoff is created from the source row without isChat.
  const fork = sessions.createSession({ title: 'Compare (fork)', cwd: chat.cwd, projectCwd: chat.project_cwd, provider: 'codex' });
  assert.equal(fork.is_chat, 1, 'a fork of a chat is a chat');

  const project = sessions.createSession({ title: 'Fix bug', cwd: '/projects/coworker', provider: 'claude' });
  assert.equal(project.is_chat, 0, 'a project session stays a project session');

  // The chat's folder is never offered as a project.
  assert.ok(!sessions.listRecentCwds(20).includes(chatFolder));
  assert.ok(sessions.listRecentCwds(20).includes('/projects/coworker'));

  // Moving a chat into a project makes it one of the project's sessions.
  sessions.moveSessionWithProjectSources(fork.id, '/projects/coworker', [chatFolder]);
  assert.equal(sessions.getSession(fork.id).is_chat, 0);
  assert.equal(sessions.getSession(chat.id).is_chat, 1, 'the original chat stays a chat');
  // A fork still in flight keeps the kind it captured from its source, even
  // when the source chat is moved into a project before the fork is saved.
  const otherFolder = path.join(userData, 'chats', '2026-10-31', 'rewrite-the-launch-email');
  fs.mkdirSync(otherFolder, { recursive: true });
  const lone = sessions.createSession({ title: 'Rewrite', cwd: otherFolder, projectCwd: otherFolder, provider: 'claude', isChat: true });
  const captured = sessions.getSession(lone.id);
  sessions.moveSessionWithProjectSources(lone.id, '/projects/site', [otherFolder]);
  assert.equal(sessions.isChatFolder(otherFolder), false, 'no stored chat is left in that folder');
  const lateFork = sessions.createSession({ title: 'Rewrite (fork)', cwd: captured.cwd, projectCwd: captured.project_cwd, provider: 'codex', isChat: captured.is_chat === 1 });
  assert.equal(lateFork.is_chat, 1, 'the late fork is still a chat');
  assert.ok(!sessions.listRecentCwds(20).includes(otherFolder), 'its folder is not offered as a project');

  // A fork of a chat already moved into a project stays a project session,
  // even while another chat still works in that folder.
  const keeper = sessions.createSession({ title: 'Keeper', cwd: otherFolder, projectCwd: otherFolder, provider: 'claude', isChat: true });
  const moved = sessions.getSession(lone.id);
  const projectFork = sessions.createSession({ title: 'Moved (fork)', cwd: otherFolder, projectCwd: moved.project_cwd, provider: 'codex', isChat: moved.is_chat === 1 });
  assert.equal(projectFork.is_chat, 0, 'an explicit project fork is not re-marked as a chat');
  // Without a say from the caller (sub-sessions, workflow members) the folder decides.
  const member = sessions.createSession({ title: 'Member', cwd: otherFolder, provider: 'claude' });
  assert.equal(member.is_chat, 1);
  assert.equal(keeper.is_chat, 1);

  sessions.close();
  console.log('chat-sessions: ok');
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}

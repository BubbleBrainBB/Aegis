// Task numbers against real SQLite: the session store hands them out, and the
// window fan-out puts them on status events. Electron is stubbed.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-task-numbers-'));
const electron = {
  app: { getPath: () => tmp, isPackaged: false, getAppPath: () => path.resolve(__dirname, '../..') },
  BrowserWindow: class {},
  ipcMain: { removeHandler: () => {}, handle: () => {} },
  shell: { openExternal: () => {} },
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args); };
const root = path.resolve(__dirname, '../../dist-electron/electron');
const sessions = require(path.join(root, 'libs/session-store.js'));
const { broadcastSessionEvent } = require(path.join(root, 'ipc/session-windows.js'));
const { readReferencedSession, readSessionTool } = require(path.join(root, 'libs/session-reference.js'));
const Database = require('better-sqlite3');

const create = (title, extra = {}) => sessions.createSession({ title, cwd: tmp, provider: 'codex', ...extra });
const numberOf = id => sessions.getSession(id).task_number;

sessions.initialize();
// Tasks count up from 1; sessions kept out of the lists take no number.
const first = create('First');
const member = create('Workflow member', { hiddenFromThreads: true });
const second = create('Second');
assert.equal(first.task_number, 1);
assert.equal(member.task_number, null);
assert.equal(second.task_number, 2);

// A deleted task's number is not handed out again.
sessions.deleteSession(second.id);
const third = create('Third');
assert.equal(third.task_number, 3);

// An agent reads a task by the number the user typed, with or without its "#".
sessions.addMessage(first.id, { type: 'user_prompt', prompt: 'the code word is pineapple-42', createdAt: 10 });
for (const reference of ['1', '#1', ' #1 ', first.id]) {
  const read = readReferencedSession(reference);
  assert.deepEqual([read.session.id, read.session.number, read.messages[0].text], [first.id, 1, 'the code word is pineapple-42'], reference);
}
// Paging continues from a number as it does from an id.
for (let i = 0; i < 3; i++) sessions.addMessage(first.id, { type: 'user_prompt', prompt: 'more ' + i, createdAt: 20 + i });
const page = readReferencedSession('#1', undefined, 2);
assert.equal(readReferencedSession('1', page.page.nextCursor, 2).messages.length, 2);
// A number that names no task here, a deleted one, a session kept out of the lists.
assert.throws(() => readReferencedSession('#999'), /no task #999 on this Mac/);
assert.throws(() => readReferencedSession('2'), /no task #2/);
assert.throws(() => readReferencedSession(member.id), /no longer available/);
assert.throws(() => readReferencedSession('1e3'), /no longer available/);
(async () => assert.equal((await readSessionTool({ sessionId: '#999' })).isError, true))();

// Every status event a window receives carries the task's number, unless the
// sender set one or the task runs on another Mac.
const sent = [];
const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_, json) => sent.push(JSON.parse(json)) } };
const status = payload => { broadcastSessionEvent(win, { type: 'session.status', payload }); return sent.pop().payload; };
assert.equal(status({ sessionId: third.id, status: 'running' }).number, 3);
assert.equal(status({ sessionId: member.id, status: 'running' }).number, undefined);
assert.equal(status({ sessionId: 'not-here', status: 'idle' }).number, undefined);
assert.equal(status({ sessionId: third.id, status: 'idle', device: { id: 'mac', name: 'Studio', online: true } }).number, undefined);
broadcastSessionEvent(win, { type: 'session.renamed', payload: { sessionId: third.id, title: 'Renamed', updatedAt: 1 } });
assert.deepEqual(sent.pop().payload, { sessionId: third.id, title: 'Renamed', updatedAt: 1 });

// A database from before numbers existed: its tasks get theirs in the order
// they were created, after the numbers already given, and keep them from then on.
sessions.close();
const raw = new Database(path.join(tmp, 'sessions.db'));
raw.prepare('UPDATE sessions SET task_number = NULL WHERE id IN (?, ?)').run(first.id, third.id);
raw.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(1, third.id);
raw.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(2, first.id);
raw.close();
sessions.initialize();
assert.equal(numberOf(third.id), 4);
assert.equal(numberOf(first.id), 5);
assert.equal(numberOf(member.id), null);
sessions.close();
sessions.initialize();
assert.equal(numberOf(third.id), 4);
assert.equal(create('Fourth').task_number, 6);
sessions.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('task-numbers.test.cjs passed');

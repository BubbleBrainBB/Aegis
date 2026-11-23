// The session store's passes over stored rows run once per database.
//
// Three passes used to read every stored message at every launch, to mend
// rows an older version wrote: about a second on a database of 220,000
// messages. They now run once per database and are remembered by name. This
// checks, against the real store (SQLite) under Node with Electron stubbed:
// - a database an older version left behind is mended on its first launch;
// - the next launch does not read the rows again;
// - schema work is not part of that: a missing column comes back at every
//   launch, whatever has been remembered;
// - rows written since need no mending.
// Requires the main process to be compiled (npm run transpile:electron).
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-stored-row-passes-')));

const anything = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
const loose = (known) => new Proxy(known, { get: (target, key) => (key in target ? target[key] : anything) });
const electron = loose({ app: loose({ getPath: () => profile, isPackaged: false, getName: () => 'Aegis', getVersion: () => '0.0.0', on() {}, once() {} }) });
const load = Module._load;
Module._load = function (name, ...rest) { return name === 'electron' ? electron : load.call(this, name, ...rest); };
const log = console.log;
console.log = () => {};

let passed = false;
try {
  const store = require(path.join(root, 'dist-electron/electron/libs/session-store.js'));
  const Database = require(path.join(root, 'node_modules/better-sqlite3'));
  const raw = () => new Database(path.join(profile, 'sessions.db'));
  const PASSES = ['externalized-message-payloads', 'message-metadata', 'search-index-text'];
  const remembered = () => {
    const db = raw();
    const names = db.prepare('SELECT name FROM stored_row_passes ORDER BY name').all().map((row) => row.name);
    db.close();
    return names;
  };

  // ── A new database: nothing to mend, and that is remembered. ──
  store.initialize();
  assert.deepEqual(remembered(), PASSES);
  const task = store.createSession({ title: 'Old task', cwd: profile, provider: 'claude' });

  // ── A database as an older version left it. ──
  // No record of any pass, a message without the columns added later, a
  // payload of 100 KB stored in its row, and search text longer than is kept now.
  const big = { type: 'assistant', uuid: 'old-big', message: { content: [{ type: 'text', text: 'x'.repeat(100_000) }] } };
  const small = { type: 'assistant', uuid: 'old-small', message: { content: [{ type: 'text', text: 'an answer from long ago' }] } };
  {
    const db = raw();
    db.exec('DELETE FROM stored_row_passes');
    const insert = db.prepare('INSERT INTO messages (id, session_id, data, created_at) VALUES (?, ?, ?, ?)');
    insert.run('old-small', task.id, JSON.stringify(small), 1_700_000_000_000);
    insert.run('old-big', task.id, JSON.stringify(big), 1_700_000_000_001);
    store.addMessage(task.id, { type: 'assistant', uuid: 'old-long-search', createdAt: 1_700_000_000_002, message: { content: [{ type: 'text', text: 'short' }] } });
    db.prepare('UPDATE search_index SET text = ? WHERE message_id = ?').run('y'.repeat(30_000), 'old-long-search');
    db.close();
  }
  store.initialize();
  {
    const db = raw();
    const row = (id) => db.prepare('SELECT message_type, source_origin, search_text, sort_key, data FROM messages WHERE id = ?').get(id);
    const mended = row('old-small');
    assert.equal(mended.message_type, 'assistant');
    assert.ok(mended.source_origin, 'where the row came from is filled in');
    assert.match(mended.search_text, /an answer from long ago/);
    assert.equal(mended.sort_key, 1_700_000_000_000);
    const pointer = JSON.parse(row('old-big').data);
    assert.equal(pointer.__aegisStorage, 'external-message-payload-v1', 'the large payload moved out of its row');
    assert.equal(JSON.parse(fs.readFileSync(pointer.artifactPath, 'utf8')).message.content[0].text.length, 100_000);
    assert.ok(db.prepare('SELECT LENGTH(text) AS n FROM search_index WHERE message_id = ?').get('old-long-search').n <= 12_000, 'over-long search text is cut to what is kept now');
    db.close();
  }
  assert.deepEqual(remembered(), PASSES);
  assert.equal(store.getSessionHistory(task.id).find((message) => message.uuid === 'old-big').message.content[0].text.length, 100_000, 'and the conversation reads as before');

  // ── The next launch reads none of it again. ──
  // A row no version writes any more would be mended by a pass that ran; it is left alone.
  {
    const db = raw();
    db.prepare('INSERT INTO messages (id, session_id, data, created_at) VALUES (?, ?, ?, ?)').run('untouched', task.id, JSON.stringify(small), 1_700_000_000_003);
    db.close();
  }
  store.initialize();
  {
    const db = raw();
    assert.equal(db.prepare('SELECT message_type FROM messages WHERE id = ?').get('untouched').message_type, null, 'no pass ran a second time');
    db.close();
  }

  // ── Schema work is never skipped. ──
  {
    const db = raw();
    db.exec('ALTER TABLE sessions DROP COLUMN antigravity_permission_mode');
    db.close();
  }
  store.initialize();
  {
    const db = raw();
    const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((column) => column.name);
    assert.ok(columns.includes('antigravity_permission_mode'), 'a missing column is added at every launch');
    db.close();
  }

  // ── A pass that ran under another name runs again under its new one. ──
  {
    const db = raw();
    db.prepare("UPDATE stored_row_passes SET name = 'message-metadata-before' WHERE name = 'message-metadata'").run();
    db.close();
  }
  store.initialize();
  {
    const db = raw();
    assert.equal(db.prepare('SELECT message_type FROM messages WHERE id = ?').get('untouched').message_type, 'assistant');
    db.close();
  }

  // ── Rows written since are stored the way the passes leave them. ──
  store.addMessage(task.id, { type: 'assistant', uuid: 'new-big', createdAt: Date.now(), message: { content: [{ type: 'text', text: 'z'.repeat(100_000) }] } });
  {
    const db = raw();
    const written = db.prepare('SELECT message_type, source_origin, search_text, sort_key, data FROM messages WHERE id = ?').get('new-big');
    assert.equal(written.message_type, 'assistant');
    assert.ok(written.source_origin && typeof written.sort_key === 'number');
    assert.ok(written.search_text.length <= 12_000);
    assert.equal(JSON.parse(written.data).__aegisStorage, 'external-message-payload-v1');
    db.close();
  }

  passed = true;
  log('stored-row-passes: all checks passed');
} catch (failure) {
  console.error(failure);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
}

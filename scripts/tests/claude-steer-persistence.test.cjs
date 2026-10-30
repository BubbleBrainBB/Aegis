// Steer persistence against the real session store (SQLite): a late steer
// moved to where its turn opened, with its echo, reloads in arrival order even
// when every message lands in the same millisecond; a withdrawn steer leaves
// no row behind. Requires transpile:electron.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-steer-persistence-'));
app.setPath('userData', scratch);
app.whenReady().then(() => {
  const sessions = require('../../dist-electron/electron/libs/session-store.js');
  const { claudeTimestamp } = require('../../dist-electron/electron/libs/claude-session-clock.js');
  const { findClaudeRewindAnchor } = require('../../dist-electron/shared/claude-rewind-anchor.js');
  try {
    sessions.initialize();
    const session = sessions.createSession({ title: 'Steer persistence', provider: 'claude', cwd: scratch });
    const id = session.id;
    const at = 1_800_000_000_000; // every message in the same millisecond
    const stamp = () => claudeTimestamp(id, at);
    const prompt = (promptId, text, steer) => ({ type: 'user_prompt', prompt: text, promptId, ...(steer ? { steer: true } : {}) });
    const echo = (promptId, text) => ({ type: 'user', uuid: promptId, hostEcho: true, message: { content: [{ type: 'text', text }] } });
    const add = (message, rowId) => { const stored = { ...message, createdAt: stamp() }; sessions.addMessage(id, stored, rowId); return stored; };
    const label = (m) => m.type === 'user_prompt' ? `prompt ${m.promptId}${m.steer ? ' (steer)' : ''}`
      : m.type === 'user' ? `echo ${m.uuid}` : m.type === 'system' ? `init ${m.session_id}` : m.type === 'result' ? `result ${m.uuid}` : `${m.type} ${m.uuid}`;

    add(prompt('pA', 'Run the checks'), 'user_prompt:pA');
    add(echo('pA', 'Run the checks'));
    add({ type: 'system', subtype: 'init', session_id: 'turn-A', uuid: 'init-A' });
    const steerB = add(prompt('pB', 'One more thing', true), 'user_prompt:pB');   // sent mid-turn
    const echoB = add(echo('pB', 'One more thing'));
    add({ type: 'assistant', uuid: 'answer-A', message: { content: [{ type: 'text', text: 'Done.' }] } });
    add({ type: 'result', uuid: 'result-A', subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
    // B started after A ended: it opened a turn of its own. Moved (same rows)
    // to this point, its echo right behind it.
    const { steer: _steer, ...opener } = steerB;
    add(opener, 'user_prompt:pB');
    add(echoB);
    // A steer withdrawn on Stop: its rows are deleted.
    add(prompt('pW', 'Never mind', true), 'user_prompt:pW');
    add(echo('pW', 'Never mind'));
    sessions.deleteMessagesById(id, ['user_prompt:pW', 'pW']);
    add({ type: 'system', subtype: 'init', session_id: 'turn-B', uuid: 'init-B' });
    add({ type: 'assistant', uuid: 'answer-B', message: { content: [{ type: 'text', text: 'Paris.' }] } });

    sessions.close();
    sessions.initialize();
    const history = sessions.getSessionHistory(id);
    assert.deepEqual(history.map(label), [
      'prompt pA', 'echo pA', 'init turn-A', 'assistant answer-A', 'result result-A',
      'prompt pB', 'echo pB', 'init turn-B', 'assistant answer-B',
    ], 'reload keeps arrival order: the moved prompt opens its turn, the withdrawn one is gone');
    const indexB = history.findIndex((m) => m.type === 'user_prompt' && m.promptId === 'pB');
    assert.equal(findClaudeRewindAnchor(history, indexB), 'pB', 'the moved prompt still rewinds to its own checkpoint');
    assert.equal(findClaudeRewindAnchor(history, 0), 'pA');
    const stamps = history.map((m) => m.createdAt);
    assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, 'stored timestamps strictly follow arrival');
    assert.equal(new Set(stamps).size, stamps.length);
    console.log('claude-steer-persistence: same-millisecond reload order, moved prompt + echo, withdrawal, rewind anchor passed');
    sessions.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

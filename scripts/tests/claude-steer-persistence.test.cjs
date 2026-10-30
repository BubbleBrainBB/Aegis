// Prompts sent into a busy Claude runner are stored where the CLI takes them
// (claude-prompt-lifecycle `started`), against the real session store
// (SQLite). Replays Devin's R3 race — Stop between turns while a steer is
// parked, then a follow-up — with every message in the same millisecond:
// history reloads in the order the agent actually read things, the
// follow-up's answer stays under the follow-up, a withdrawn prompt never
// reaches the store, and each stored prompt rewinds to its own echo.
// Requires transpile:electron.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-steer-persistence-'));
app.setPath('userData', scratch);
app.whenReady().then(() => {
  const sessions = require('../../dist-electron/electron/libs/session-store.js');
  const { claudeSortKey } = require('../../dist-electron/electron/libs/claude-session-clock.js');
  const { ClaudePromptLifecycle } = require('../../dist-electron/electron/libs/claude-prompt-lifecycle.js');
  const { findClaudeRewindAnchor } = require('../../dist-electron/shared/claude-rewind-anchor.js');
  try {
    sessions.initialize();
    const session = sessions.createSession({ title: 'Steer persistence', provider: 'claude', cwd: scratch });
    const id = session.id;
    const at = 1_800_000_000_000; // every message in the same millisecond
    const store = (message) => sessions.addMessage(id, { ...message, createdAt: at }, { sortKey: claudeSortKey(id, at) });
    const prompt = (promptId, text, extra = {}) => ({ type: 'user_prompt', prompt: text, ...(promptId ? { promptId } : {}), ...extra });
    const echo = (uuid, text) => ({ type: 'user', uuid, hostEcho: true, message: { content: [{ type: 'text', text }] } });
    const lifecycle = new ClaudePromptLifecycle();
    // Deferred prompts and their pending echoes, as ipc-handlers and the
    // runner hold them until the CLI takes them.
    const deferred = new Map();
    const echoes = new Map();
    const interrupts = [];
    const send = (promptId, text, steer) => {
      lifecycle.sent(promptId, true);
      deferred.set(promptId, prompt(promptId, text, steer ? { steer: true } : {}));
      echoes.set(promptId, echo(promptId, text));
    };
    const frame = (wire) => {
      const out = lifecycle.observe(wire);
      if (out.withdrawn) { deferred.delete(out.withdrawn); echoes.delete(out.withdrawn); }
      if (out.started) {
        // storeStartedClaudePrompt, then the runner's echo.
        const message = deferred.get(out.started.promptId);
        deferred.delete(out.started.promptId);
        if (message) {
          const { steer, ...ordinary } = message;
          store(out.started.mode === 'opened' ? ordinary : { ...ordinary, steer: true });
        }
        const e = echoes.get(out.started.promptId);
        echoes.delete(out.started.promptId);
        if (e) store(e);
      }
      if (out.interrupt) interrupts.push(out.started?.promptId);
      if (wire.type !== 'command_lifecycle') store(wire);
    };
    const lc = (state, uuid) => ({ type: 'command_lifecycle', state, command_uuid: uuid });
    const init = (turn) => ({ type: 'system', subtype: 'init', session_id: turn, uuid: `init-${turn}` });
    const answer = (uuid, text) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
    const result = (uuid, answered) => ({ type: 'result', uuid, subtype: 'success', duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, user_message_uuids: answered });

    // Turn A opens at once (stored at send, like any prompt into an idle runner).
    store(prompt(null, 'Run the checks'));
    lifecycle.sent('pA', false);
    store(echo('pA', 'Run the checks'));
    frame(lc('started', 'pA')); frame(init('A'));
    send('pF', 'Also lint', true);                        // a steer that folds in
    frame(lc('queued', 'pF')); frame(lc('started', 'pF'));
    frame(answer('answer-A', 'Checks and lint pass.'));
    frame(result('result-A', ['pA', 'pF']));
    send('pB', 'One more thing', true);                   // steer, parked for the next turn
    frame(lc('queued', 'pB'));
    const stop = lifecycle.beginStop();                   // Stop between turns
    lifecycle.stopReceipt(stop.generation, ['pB']);      // the interrupt could not reach B
    send('pC', 'Reply with just: AFTER', false);          // follow-up after Stop
    frame(lc('queued', 'pC'));
    send('pW', 'Never mind', true);                       // sent, then withdrawn by a later Stop
    frame(lc('queued', 'pW'));
    frame(lc('started', 'pB')); frame(init('B'));        // B runs (and is interrupted)
    frame(result('result-B', ['pB']));
    frame(lc('cancelled', 'pW'));                         // W never ran
    frame(lc('started', 'pC')); frame(init('C'));
    frame(answer('answer-C', 'AFTER'));
    frame(result('result-C', ['pC']));
    assert.deepEqual(interrupts, ['pB'], 'only the parked stopped steer is interrupted, never the follow-up');

    sessions.close();
    sessions.initialize();
    const history = sessions.getSessionHistory(id);
    const label = (m) => m.type === 'user_prompt' ? `prompt ${m.promptId ?? 'A'}${m.steer ? ' (steer)' : ''}`
      : m.type === 'user' ? `echo ${m.uuid}` : m.type === 'system' ? `init ${m.session_id}` : `${m.type} ${m.uuid}`;
    assert.deepEqual(history.map(label), [
      'prompt A', 'echo pA', 'init A',
      'prompt pF (steer)', 'echo pF', 'assistant answer-A', 'result result-A',
      'prompt pB', 'echo pB', 'init B', 'result result-B',
      'prompt pC', 'echo pC', 'init C', 'assistant answer-C', 'result result-C',
    ], 'stored where the CLI took each prompt; the follow-up answer stays under the follow-up; W never stored');
    for (const promptId of ['pB', 'pC']) {
      const index = history.findIndex((m) => m.type === 'user_prompt' && m.promptId === promptId);
      assert.equal(findClaudeRewindAnchor(history, index), promptId, `${promptId} rewinds to its own checkpoint`);
    }
    assert(history.every((m) => m.createdAt === at), 'timestamps stay wall-clock time: only the sort key orders');
    console.log('claude-steer-persistence: stored where taken, R3 race order, withdrawal, rewind anchors, same-millisecond reload passed');
    sessions.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

// A message sent while a Bubble turn runs joins that turn. Runs the adapter
// against the real SDK (pinned version) with a scripted model, so an SDK
// upgrade that changes how steers, queued turns or the session log behave
// fails here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// Each fixture builds its own SDK, and each SDK listens for the process to exit.
process.setMaxListeners(64);
const home = mkdtempSync(join(tmpdir(), 'aegis-bubble-steer-'));
const previousHome = process.env.BUBBLE_HOME;
process.env.BUBBLE_HOME = home;
const loader = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
const originalSdk = loader.getBubbleSdk;

const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Wait for something the adapter does after reading a file or loading a module. */
const until = async (condition, what) => {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const USAGE = { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
const text = (content) => [{ type: 'text', content }, USAGE, { type: 'done' }];
const toolCall = (id) => [
  { type: 'tool_call', id, name: 'fixture_mcp', arguments: '{}', isStart: true, isEnd: true },
  USAGE,
  { type: 'done' },
];
/** What the model was last told by the user, as text. */
const lastUserText = (messages) => {
  const content = messages.filter((message) => message.role === 'user').at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
};

try {
  const { BubbleSdk, SessionManager, ExternalHookController, parseSkillInvocation } = await import('@bubblebrain-ai/bubble');
  const { registerDynamicModelMetadata } = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
  const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
  registerDynamicModelMetadata({ providerId: 'openai', id: 'aegis-steer-test', contextWindow: 128000 });

  /**
   * One adapter on one real SDK. `steps[i]` answers the model's i-th call:
   * chunks, or a function of the messages returning them (it may wait).
   */
  function fixture(name, steps) {
    const cwd = join(home, name);
    mkdirSync(cwd, { recursive: true });
    const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
    const adapter = new BubbleSdkAdapter();
    const events = [];
    const calls = [];
    const tool = { started: gate(), release: gate(), runs: 0 };
    adapter.events.on('event', (event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest(name, event.requestId, { behavior: 'allow' });
      }
    });
    sdk.getModelConfig = () => ({
      defaultProviderId: 'openai',
      defaultModel: 'openai:aegis-steer-test',
      providers: [{ id: 'openai', hasApiKey: true }],
    });
    sdk.mcpToolsFor = async () => [{
      name: 'fixture_mcp',
      description: 'fixture',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        tool.runs += 1;
        tool.started.open();
        await tool.release.promise;
        return { content: 'ok' };
      },
    }];
    sdk.resolveProvider = () => ({
      providerId: 'openai',
      model: 'aegis-steer-test',
      provider: {
        async *streamChat(messages) {
          const step = steps[calls.length];
          calls.push(messages);
          yield* typeof step === 'function' ? await step(messages) : step ?? text('Nothing more to say');
        },
      },
    });
    // What the adapter asked the SDK for, and the receipts of its steers.
    const asked = { runTurn: [], steer: [], stop: [] };
    const receipts = [];
    const stoppedIds = [];
    for (const method of Object.keys(asked)) {
      const original = sdk[method].bind(sdk);
      sdk[method] = (sessionId, argument) => {
        asked[method].push(argument);
        const returned = original(sessionId, argument);
        if (method === 'steer') receipts.push(returned);
        if (method === 'stop') stoppedIds.push(sessionId);
        return returned;
      };
    }
    // Hold this open to stop the adapter where it waits for the SDK to load
    // (`once`: only the next caller waits).
    const sdkLoad = { hold: null, once: false };
    loader.getBubbleSdk = async () => {
      const hold = sdkLoad.hold;
      if (hold) {
        if (sdkLoad.once) sdkLoad.hold = null;
        await hold.promise;
      }
      return sdk;
    };
    const start = (prompt, extra = {}) =>
      adapter.startSession({ provider: 'bubble', threadId: name, cwd, prompt, ...extra });
    const send = (prompt, extra = {}) => adapter.sendTurn({ threadId: name, prompt, ...extra });
    const session = () => adapter.sessions.get(name);
    const messages = () => events.filter((event) => event.type === 'message').map((event) => event.message);
    const results = () => messages().filter((message) => message.type === 'result');
    const answers = () =>
      messages()
        .filter((message) => message.type === 'assistant')
        .flatMap((message) => message.message.content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text);
    const statuses = () => events.filter((event) => event.type === 'status_change').map((event) => event.status);
    const errors = () => events.filter((event) => event.type === 'error').map((event) => event.error.message);
    /** Until the adapter reports the turn over, n times so far. */
    const finished = async (count = 1) => {
      for (let i = 0; i < 400; i += 1) {
        if (statuses().filter((status) => status === 'completed' || status === 'error').length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${name}: the turn never finished: ${JSON.stringify({ statuses: statuses(), errors: errors() })}`);
    };
    const userTurns = (sessionId) => {
      const file = sdk.listSessions().find((summary) => summary.name === sessionId).file;
      return new SessionManager(file).listUserTurns().map((turn) => turn.text);
    };
    const runState = (sessionId) => sdk.getSessionRunState(sessionId);
    /** What the model was told by the user in each call after the first, in order. */
    const heard = () => calls.slice(1).map(lastUserText);
    return { sdk, adapter, cwd, events, calls, tool, asked, receipts, stoppedIds, sdkLoad, heard, start, send, session, messages, results, answers, statuses, errors, finished, userTurns, runState };
  }

  // 1. A steer reaches the running turn at its next model call. The composer's
  //    model and mode for that message do not touch the running turn.
  {
    const f = fixture('steered', [toolCall('tool-1'), text('Done, tests included')]);
    await f.start('Fix the bug', { bubblePermissionMode: 'default' });
    const id = f.session().providerSessionId;
    await f.tool.started.promise;
    await f.send('Also check the tests', { model: 'openai:another-model', bubblePermissionMode: 'bypassPermissions' });
    assert.equal(f.asked.steer.length, 1, 'a message sent mid-turn is steered');
    assert.equal(f.asked.steer[0], 'Also check the tests');
    assert.equal(f.runState(id).pendingSteers, 1);
    assert.equal(f.session().permissionMode, 'default', 'a steer leaves the running turn in its mode');
    f.tool.release.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.equal(f.calls.length, 2);
    assert.equal(lastUserText(f.calls[1]), 'Also check the tests', 'the model reads the steer at its next call');
    assert.equal(f.asked.runTurn.length, 1, 'no second turn was started');
    assert.deepEqual(f.statuses(), ['running', 'completed']);
    assert.equal(f.results().length, 1, 'one result for the turn and its steer');
    assert.equal(f.results()[0].usage.total_tokens, 220);
    assert.equal(f.session().model, 'aegis-steer-test', 'the running turn keeps its model');
    assert.equal(f.session().permissionMode, 'default');
    assert.deepEqual(f.userTurns(id), ['Fix the bug', 'Also check the tests']);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
    // Idle again: the next message opens a turn of its own, on what it carries.
    await f.send('And now?', { bubblePermissionMode: 'bypassPermissions' });
    await f.finished(2);
    assert.equal(f.asked.runTurn.length, 2);
    assert.equal(f.asked.runTurn[1].mode, 'bypassPermissions');
    assert.equal(f.results().length, 2);
  }

  // 2. A steer the turn never reads (no model call left) becomes a turn the
  //    SDK starts itself. The adapter follows it in the session log and
  //    reports both as one turn.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('too-late', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Second answer'),
    ]);
    await f.start('Explain the module');
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('And its tests?');
    assert.equal(f.asked.steer.length, 1);
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.equal(f.calls.length, 2, 'the SDK ran a turn for the unread steer');
    assert.equal(lastUserText(f.calls[1]), 'And its tests?');
    assert.equal(f.asked.runTurn.length, 1, 'the adapter did not start that turn; the SDK did');
    assert.deepEqual(f.answers(), ['First answer', 'Second answer'], 'the follow-up turn is shown');
    assert.deepEqual(f.statuses(), ['running', 'completed'], 'the session stays running until both are done');
    assert.equal(f.results().length, 1);
    assert.equal(f.results()[0].usage.total_tokens, 220, 'billing covers both turns');
    assert.equal(f.messages().at(-1).type, 'result', 'the result closes the batch, after the follow-up');
    assert.equal(f.events.filter((event) => event.type === 'system_init').length, 2, 'session start and its turn; the follow-up is not announced again');
    assert.deepEqual(f.userTurns(id), ['Explain the module', 'And its tests?']);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
  }

  // 3. An image cannot be steered: the message queues in the SDK behind the
  //    running turn and takes its own model/mode when it starts.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('image', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Saw the image'),
    ]);
    const image = join(f.cwd, 'shot.png');
    writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'));
    await f.start('Look around', { bubblePermissionMode: 'default' });
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('What is in this picture?', {
      attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }],
      bubblePermissionMode: 'bypassPermissions',
    });
    await until(() => f.asked.runTurn.length === 2, 'the image message to queue as a turn');
    assert.equal(f.asked.steer.length, 0, 'an image is not steered');
    assert.equal(f.runState(id).queuedTurns, 1);
    assert.equal(f.session().permissionMode, 'default', 'the running turn keeps its mode until the queued one starts');
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.equal(f.asked.runTurn[1].mode, 'bypassPermissions');
    assert.equal(f.session().permissionMode, 'bypassPermissions', 'the queued turn brought its mode');
    assert.match(lastUserText(f.calls[1]), /image_url/);
    assert.match(lastUserText(f.calls[1]), /What is in this picture\?/);
    assert.deepEqual(f.answers(), ['First answer', 'Saw the image']);
    assert.equal(f.results().length, 1);
    assert.deepEqual(f.statuses(), ['running', 'completed']);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
  }

  // 4. "/skill task" is only rewritten by runTurn, so it queues as a turn too.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('skill', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Reviewed'),
    ]);
    f.sdk.listSkills = () => [{ name: 'review', description: 'Review a change' }];
    await f.start('Write the change');
    await reached.promise;
    await f.send('/tmp is full');
    await f.send('/review the diff');
    await tick();
    assert.deepEqual(f.asked.steer, ['/tmp is full'], 'other text starting with a slash is steered');
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.equal(f.asked.runTurn.length, 2, 'a skill invocation queues as a turn');
    assert.match(f.asked.runTurn[1].prompt, /^\/review the diff/);
    assert.deepEqual(f.heard(), ['/tmp is full', '/review the diff'], 'in the order they were sent');
    assert.equal(f.results().length, 1);
  }

  // 5. Two messages sent back to back while idle: the second joins the turn
  //    the first opens, instead of racing it for the session.
  {
    const f = fixture('back-to-back', [toolCall('tool-1'), text('Both done')]);
    await f.start('', {});
    f.tool.release.open();
    const first = f.send('Do the first thing');
    const second = f.send('And the second');
    await Promise.all([first, second]);
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.equal(f.asked.runTurn.length, 1);
    assert.deepEqual(f.asked.steer, ['And the second']);
    assert.equal(f.results().length, 1);
    assert.deepEqual(f.userTurns(f.session().providerSessionId), ['Do the first thing', 'And the second']);
  }

  // 6. Stop ends everything the turn was given: a steer it had not read, a
  //    message still waiting to be handed over, and turns queued behind it.
  for (const how of ['stopSession', 'disposeSession']) {
    for (const first of ['steer', 'picture']) {
      const name = `stopped-${how}-${first}`;
      const answering = gate();
      const reached = gate();
      const f = fixture(name, [
        async () => { reached.open(); await answering.promise; return text('First answer'); },
      ]);
      const image = join(f.cwd, 'shot.png');
      writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'));
      const picture = { attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }] };
      await f.start('Work on it');
      const id = f.session().providerSessionId;
      await reached.promise;
      if (first === 'steer') {
        // The picture waits for the SDK to place the steer before it queues.
        await f.send('Unread steer');
        await f.send('Picture behind the steer', picture);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(f.runState(id).pendingSteers, 1);
        assert.equal(f.runState(id).queuedTurns, 0);
      } else {
        // Text behind a queued turn queues too.
        await f.send('Queued picture', picture);
        await f.send('Text behind the picture');
        await until(() => f.asked.runTurn.length === 3, 'both messages to queue as turns');
        assert.equal(f.runState(id).pendingSteers, 0);
        assert.equal(f.runState(id).queuedTurns, 2);
      }
      const asked = { steer: f.asked.steer.length, runTurn: f.asked.runTurn.length };
      const stopping = f.adapter[how](f.session().threadId);
      // A message that arrives while the stop is under way is not sent anywhere.
      await f.send('Too late').catch(() => undefined);
      await stopping;
      assert.deepEqual(f.asked.stop.at(-1), { cancelQueued: true });
      answering.open();
      for (let i = 0; i < 200 && f.runState(id).active; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
      assert.equal(f.calls.length, 1, `${name}: nothing ran after the stop`);
      assert.equal(f.results().length, 0, `${name}: a stopped turn reports no result`);
      assert.deepEqual(f.errors(), [], `${name}: a stop is not an error`);
      assert.equal(f.adapter.sessions.has(name), false);
      assert.deepEqual({ steer: f.asked.steer.length, runTurn: f.asked.runTurn.length }, asked, `${name}: nothing was handed to the SDK after the stop`);
    }
  }

  // 7. `/compact` rewrites the session, so one sent mid-turn waits for the
  //    turn to end and then runs as its own. It keeps its place: what is sent
  //    after it goes after it, instead of joining the running turn ahead of it.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('compact', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Answer to the later text'),
    ]);
    await f.start('Work on it');
    await reached.promise;
    const compacting = f.send('/compact');
    const later = f.send('TEXT after the compaction');
    await tick();
    assert.equal(f.asked.steer.length, 0, 'neither the compaction nor what follows it is steered into the turn');
    assert.equal(f.results().length, 0);
    answering.open();
    await Promise.all([compacting, later]);
    await f.finished(3);
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(f.answers(), ['First answer', 'Session is already compact enough.', 'Answer to the later text']);
    assert.deepEqual(f.heard(), ['TEXT after the compaction'], 'the model was not asked to compact');
    assert.equal(f.asked.steer.length, 0);
    assert.equal(f.asked.runTurn.length, 2, 'the later text opened a turn of its own after the compaction');
    assert.equal(f.results().length, 3, 'the turn, the compaction and the later turn each report');
    assert.deepEqual(f.statuses(), ['running', 'completed', 'running', 'completed', 'running', 'completed']);
  }

  // 8. A turn that fails ends the batch: one error, and the turn queued
  //    behind it does not run on after the error was reported.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('failed', [
      async () => { reached.open(); await answering.promise; throw new Error('model unavailable'); },
    ]);
    const image = join(f.cwd, 'shot.png');
    writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'));
    await f.start('Work on it');
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('Queued picture', { attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }] });
    await until(() => f.asked.runTurn.length === 2, 'the image message to queue as a turn');
    answering.open();
    await f.finished();
    assert.equal(f.errors().length, 1, JSON.stringify(f.errors()));
    assert.match(f.errors()[0], /model unavailable/);
    assert.deepEqual(f.statuses(), ['running', 'error']);
    assert.equal(f.results().length, 1);
    assert.equal(f.results()[0].subtype, 'error');
    for (let i = 0; i < 200 && f.runState(id).active; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 1, 'the queued turn was cancelled with the failed one');
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
    assert.equal(f.session().batch, null);
  }

  // 9. Messages reach the model in the order they were sent, however long one
  //    takes to prepare. A picture is read from disk before it can queue; a
  //    skill invocation and plain text sent after it wait their turn behind it
  //    (text would otherwise be steered into the running turn, ahead of it).
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('ordered', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Second'), text('Third'), text('Fourth'),
    ]);
    f.sdk.listSkills = () => [{ name: 'review', description: 'Review a change' }];
    const image = join(f.cwd, 'big.png');
    writeFileSync(image, Buffer.alloc(8 * 1024 * 1024, 1));
    await f.start('Write the change');
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('PICTURE', { attachments: [{ kind: 'image', path: image, name: 'big.png', mimeType: 'image/png' }] });
    await f.send('/review SKILL');
    await f.send('PLAIN text');
    await until(() => f.asked.runTurn.length === 4, 'all three messages to queue');
    assert.deepEqual(f.asked.steer, [], 'text behind a queued turn is not steered ahead of it');
    assert.equal(f.runState(id).queuedTurns, 3);
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(f.heard().map((said) => /PICTURE|SKILL|PLAIN/.exec(said)?.[0]), ['PICTURE', 'SKILL', 'PLAIN']);
    assert.equal(f.results().length, 1);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
  }

  // 10. A steer the running turn does not read gets its turn at the end of
  //     the SDK's queue. A picture sent after it queues only once the SDK has
  //     placed the steer, so it does not get ahead of that turn.
  {
    const answering = gate();
    const reached = gate();
    const f = fixture('steer-then-picture', [
      async () => { reached.open(); await answering.promise; return text('First answer'); },
      text('Second'), text('Third'),
    ]);
    const image = join(f.cwd, 'shot.png');
    writeFileSync(image, Buffer.from('iVBORw0KGgo=', 'base64'));
    await f.start('Write the change');
    await reached.promise;
    await f.send('STEER first');
    await f.send('PICTURE second', { attachments: [{ kind: 'image', path: image, name: 'shot.png', mimeType: 'image/png' }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.asked.runTurn.length, 1, 'the picture waits for the steer to be placed');
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(f.heard().map((said) => /STEER|PICTURE/.exec(said)?.[0]), ['STEER', 'PICTURE']);
    assert.equal(f.results().length, 1);
  }

  // 11. Stop while the turn is past its last model call but still running the
  //     hook for a steer it did not read. The SDK reports the unread steer
  //     only after that hook; a turn started for it then would run after
  //     Stop, with no signal to stop it and nobody reading (the SDK patch in
  //     scripts/patch-bubble-sdk.mjs is what prevents it). The same holds
  //     when it is another message's failure that ends the batch.
  {
    const runEvent = ExternalHookController.prototype.runEvent;
    let hook = null;
    ExternalHookController.prototype.runEvent = async function held(request, options) {
      const result = await runEvent.call(this, request, options);
      if (hook && request.eventName === 'QueuedInputRejected') {
        hook.entered.open();
        await hook.release.promise;
      }
      return result;
    };
    try {
      for (const how of ['stopSession', 'disposeSession', 'failure']) {
        hook = { entered: gate(), release: gate() };
        const answering = gate();
        const reached = gate();
        const f = fixture('hook-' + how, [
          async () => { reached.open(); await answering.promise; return text('First answer'); },
        ]);
        await f.start('Work on it');
        const id = f.session().providerSessionId;
        await reached.promise;
        await f.send('Unread steer');
        answering.open();
        await hook.entered.promise;
        if (how === 'failure') {
          // A second message the SDK refuses: the batch fails while the first
          // steer is still in its hook.
          const steer = f.sdk.steer;
          f.sdk.steer = (sessionId, content) =>
            content === 'Refused' ? { accepted: false, disposition: 'rejected', reason: 'ownership_conflict' } : steer(sessionId, content);
          await f.send('Refused');
          await f.finished();
          assert.equal(f.errors().length, 1);
          assert.match(f.errors()[0], /ownership_conflict/);
        } else {
          await f.adapter[how](f.session().threadId);
        }
        assert.deepEqual(f.asked.stop.at(-1), { cancelQueued: true });
        const eventsAtStop = f.events.length;
        hook.release.open();
        const outcome = await f.receipts[0].outcome;
        assert.equal(outcome.type, 'input_rejected', `${how}: the unread steer ends with its turn`);
        assert.equal(outcome.reason, 'turn_cancelled');
        for (let i = 0; i < 200 && f.runState(id).active; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(f.calls.length, 1, `${how}: no turn ran for the steer after the stop`);
        assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
        assert.deepEqual(f.events.slice(eventsAtStop).filter((event) => event.type !== 'status_change' || event.status !== 'stopped'), [], `${how}: nothing more is said to the thread`);
      }
    } finally {
      ExternalHookController.prototype.runEvent = runEvent;
    }
  }

  // 12. Stop while an idle send is still reading its image. The stopped
  //     session must not come back as running, nor report an error to the
  //     thread: the session that replaces it listens there and would be torn
  //     down for a failure that is not its own.
  {
    const f = fixture('stop-while-reading', [text('Answer of the new session')]);
    const image = join(f.cwd, 'big.png');
    writeFileSync(image, Buffer.alloc(8 * 1024 * 1024, 1));
    await f.start('');
    const stopped = f.session();
    const sending = f.send('Look at this', { attachments: [{ kind: 'image', path: image, name: 'big.png', mimeType: 'image/png' }] });
    await f.adapter.stopSession(stopped.threadId);
    assert.deepEqual(f.statuses(), ['stopped']);
    // The thread gets a new session right away, as it does when the user sends again.
    await f.start('Start over');
    await sending;
    await f.finished();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stopped.status, 'stopped', 'the stopped session stays stopped');
    assert.equal(stopped.batch, null);
    assert.deepEqual(f.errors(), [], 'the new session hears no error of the old one');
    assert.deepEqual(f.statuses(), ['stopped', 'running', 'completed']);
    assert.equal(f.asked.runTurn.length, 1, 'only the new session started a turn');
    assert.equal(f.results().length, 1);
    assert.equal(f.results()[0].subtype, 'success');
    assert.deepEqual(f.answers(), ['Answer of the new session']);
  }

  // 13. The same while the SDK is still loading for the turn about to start.
  {
    const f = fixture('stop-while-loading', [text('Never asked')]);
    await f.start('');
    const stopped = f.session();
    f.sdkLoad.hold = gate();
    await f.send('Start working');
    assert.deepEqual(f.statuses(), ['running']);
    f.adapter.disposeSession(stopped.threadId);
    const eventsAtStop = f.events.length;
    f.sdkLoad.hold.open();
    f.sdkLoad.hold = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.asked.runTurn.length, 0, 'no turn is started for a disposed session');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.events.slice(eventsAtStop), [], 'and the thread hears nothing of it');
    assert.equal(stopped.batch, null);
  }

  // 14. The turn the SDK starts for an unread steer is read from the session
  //     log, from where the log stood when the steer was sent: the first
  //     turn's remaining events (thousands here) are replayed and skipped
  //     first. A turn queued behind it is read from its own iterator. Each
  //     turn's answer still comes out whole and in order, and one result
  //     covers all three.
  {
    const answering = gate();
    const reached = gate();
    const long = async () => {
      reached.open();
      await answering.promise;
      return [...Array.from({ length: 3000 }, () => ({ type: 'text', content: 'x' })), USAGE, { type: 'done' }];
    };
    const f = fixture('replay-backlog', [long, text('ANSWER-TO-STEER'), text('ANSWER-TO-SKILL')]);
    f.sdk.listSkills = () => [{ name: 'review', description: 'Review a change' }];
    await f.start('Write a lot');
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('STEER');
    await f.send('/review SKILL');
    answering.open();
    await f.finished();
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(f.heard(), ['STEER', '/review SKILL']);
    assert.deepEqual(f.answers(), ['x'.repeat(3000), 'ANSWER-TO-STEER', 'ANSWER-TO-SKILL']);
    assert.equal(f.results().length, 1);
    assert.equal(f.results()[0].usage.total_tokens, 330);
    assert.equal(f.messages().at(-1).type, 'result');
    assert.deepEqual(f.statuses(), ['running', 'completed']);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
  }

  // 15. That SDK-started turn fails (the connection drops) while another turn
  //     waits in the SDK's queue behind it. The SDK hands the session to the
  //     queued turn the moment the failed one lets go; the adapter learns of
  //     the failure from the log, after the replay. The batch still ends
  //     once, with the one error, and the queued turn is cancelled before it
  //     reaches the model.
  {
    const answering = gate();
    const reached = gate();
    const followUp = { reached: gate(), fail: gate() };
    const long = async () => {
      reached.open();
      await answering.promise;
      return [...Array.from({ length: 3000 }, () => ({ type: 'text', content: 'x' })), USAGE, { type: 'done' }];
    };
    const f = fixture('follow-up-fails', [
      long,
      async () => { followUp.reached.open(); await followUp.fail.promise; throw new Error('connection lost'); },
      text('Never asked'),
    ]);
    f.sdk.listSkills = () => [{ name: 'review', description: 'Review a change' }];
    await f.start('Write a lot');
    const id = f.session().providerSessionId;
    await reached.promise;
    await f.send('STEER');
    await f.send('/review SKILL');
    answering.open();
    // The connection drops only once the skill's turn is really queued behind.
    await followUp.reached.promise;
    await until(() => f.asked.runTurn.length === 2 && f.runState(id).queuedTurns === 1, 'the skill turn to wait in the SDK queue');
    assert.equal(f.runState(id).active, true);
    assert.equal(f.results().length, 0);
    followUp.fail.open();
    await f.finished();
    for (let i = 0; i < 200 && f.runState(id).active; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.errors().length, 1, JSON.stringify(f.errors()));
    assert.match(f.errors()[0], /connection lost/);
    assert.deepEqual(f.heard(), ['STEER'], 'the queued turn never reached the model');
    assert.deepEqual(f.answers(), ['x'.repeat(3000)], 'the first answer is whole; nothing of the cancelled turn is shown');
    assert.deepEqual(f.statuses(), ['running', 'error'], 'the batch ends once');
    assert.equal(f.results().length, 1);
    assert.equal(f.results()[0].subtype, 'error');
    assert.equal(f.messages().at(-1).type, 'result', 'nothing follows the result');
    assert.deepEqual(f.asked.stop.at(-1), { cancelQueued: true });
    assert.deepEqual(f.stoppedIds.at(-1), id);
    assert.deepEqual(f.runState(id), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
    assert.equal(f.session().batch, null);
  }

  // 16. Stop during the very first start, while the SDK is still loading. No
  //     session is registered yet, so Stop has only the start to cancel: it
  //     must not go on to register a session and run its first turn with
  //     nobody listening. A start that follows takes the thread normally.
  for (const how of ['stopSession', 'disposeSession']) {
    for (const again of [false, true]) {
      const name = `cold-${how}-${again ? 'restarted' : 'left'}`;
      const f = fixture(name, [text('Answer of the second start')]);
      f.sdkLoad.hold = gate();
      const first = f.start('First prompt').then(() => 'started', (error) => error.message);
      await tick();
      await f.adapter[how](name);
      const second = again ? f.start('Second prompt') : null;
      f.sdkLoad.hold.open();
      f.sdkLoad.hold = null;
      assert.match(await first, /cancelled/, `${name}: the stopped start gives up`);
      if (!again) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(f.adapter.sessions.has(name), false, `${name}: no session was registered`);
        assert.deepEqual(f.events, [], `${name}: the thread hears nothing`);
        assert.equal(f.asked.runTurn.length, 0);
        assert.equal(f.calls.length, 0);
        continue;
      }
      await second;
      await f.finished();
      assert.deepEqual(f.errors(), []);
      assert.equal(f.asked.runTurn.length, 1, `${name}: only the second start ran a turn`);
      assert.equal(f.asked.runTurn[0].prompt, 'Second prompt');
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.statuses(), ['running', 'completed']);
      assert.deepEqual(f.answers(), ['Answer of the second start']);
    }
  }

  // 17. A Stop still waiting for the SDK when another session takes the
  //     thread stops nothing of that session: it stays registered, its turn
  //     runs on, and the thread is not reported stopped. What the stopped
  //     session had running is ended by the takeover itself, once: its turn
  //     is stopped in the SDK and its signal aborted before the new session
  //     starts, and it says nothing more.
  for (const old of ['idle', 'running']) {
    const name = 'stop-replaced-' + old;
    const answering = gate();
    const reached = gate();
    const f = fixture(name, old === 'running'
      ? [async () => { reached.open(); await answering.promise; return text('Answer of the stopped session'); }, text('Answer of the replacement')]
      : [text('Answer of the replacement')]);
    await f.start(old === 'running' ? 'Old prompt' : '');
    const stopped = f.session();
    const stoppedId = stopped.providerSessionId;
    if (old === 'running') await reached.promise;
    const signal = stopped.abortController?.signal;
    const hold = gate();
    f.sdkLoad.hold = hold;
    f.sdkLoad.once = true;
    const stopping = f.adapter.stopSession(stopped.threadId);
    await f.start('Replacement prompt');
    const replacement = f.session();
    assert.notEqual(replacement, stopped);
    assert.notEqual(replacement.providerSessionId, stoppedId);
    if (old === 'running') {
      assert.deepEqual(f.stoppedIds, [stoppedId], 'the takeover stopped the old turn in the SDK');
      assert.deepEqual(f.asked.stop, [{ cancelQueued: true }]);
      assert.equal(signal.aborted, true, 'and aborted its signal');
    }
    hold.open();
    await stopping;
    answering.open();
    await f.finished();
    for (let i = 0; i < 200 && f.runState(stoppedId).active; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.session(), replacement, `${name}: the replacement stays registered`);
    assert.deepEqual(f.stoppedIds, old === 'running' ? [stoppedId] : [], `${name}: the late Stop stopped nothing in the SDK`);
    assert.deepEqual(f.errors(), []);
    assert.deepEqual(f.statuses(), old === 'running' ? ['running', 'running', 'completed'] : ['running', 'completed'], `${name}: the thread is never reported stopped`);
    assert.deepEqual(f.answers(), ['Answer of the replacement'], `${name}: the stopped session says nothing more`);
    assert.equal(f.results().length, 1);
    assert.equal(stopped.batch ?? null, null);
    assert.deepEqual(f.runState(stoppedId), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
    assert.deepEqual(f.runState(replacement.providerSessionId), { active: false, queuedTurns: 0, pendingSteers: 0, phase: 'idle' });
  }

  // 18. Whether a message sent mid-turn is a skill invocation (which needs a
  //     turn of its own) is read exactly as the SDK reads it when it rewrites
  //     the prompt of a turn.
  {
    const f = fixture('skill-forms', []);
    f.sdk.listSkills = () => [{ name: 'review', description: 'Review a change' }];
    await f.start('');
    const registry = { get: (name) => (name === 'review' ? { meta: { name: 'review' } } : undefined) };
    const forms = [
      '/review the diff', '/review \nthe diff', '/ review the diff', '  /review   the diff  ',
      '/review\nthe diff', '/review\tthe diff', '/review', '/review ', '/ review', '/',
      '/unknown the diff', 'review the diff', '/tmp is full', '/review/x the diff',
    ];
    for (const said of forms) {
      assert.equal(
        f.adapter.invokesSkill(f.sdk, f.session(), said),
        Boolean(parseSkillInvocation(said, registry)),
        `the adapter and the SDK agree on ${JSON.stringify(said)}`
      );
    }
    assert.equal(f.adapter.invokesSkill(f.sdk, f.session(), '/review \nthe diff'), true);
    assert.equal(f.adapter.invokesSkill(f.sdk, f.session(), '/ review the diff'), true);
  }

  // 19. `/compact`, a message, `/compact` again, all sent while the first
  //     compaction runs: they run in that order. (A compaction that runs at
  //     once is a barrier like one that waits; the message would otherwise
  //     end up behind the second compaction.)
  {
    const ran = [];
    const f = fixture('compact-text-compact', [
      text('First answer'),
      async () => { ran.push('message'); return text('Answer to the message'); },
    ]);
    await f.start('Work on it');
    await f.finished();
    const getManager = loader.getBubbleSessionManager;
    const loading = gate();
    let held = true;
    loader.getBubbleSessionManager = async (...args) => {
      ran.push('compact');
      if (held) await loading.promise;
      return getManager(...args);
    };
    try {
      const first = f.send('/compact');
      await until(() => ran.length === 1, 'the first compaction to start');
      const message = f.send('MESSAGE between the compactions');
      const second = f.send('/compact');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(ran, ['compact'], 'nothing overtakes the running compaction');
      held = false;
      loading.open();
      await Promise.all([first, message, second]);
      await f.finished(4);
      assert.deepEqual(f.errors(), []);
      assert.deepEqual(ran, ['compact', 'message', 'compact']);
      assert.deepEqual(f.heard(), ['MESSAGE between the compactions']);
      assert.equal(f.results().length, 4);
      assert.equal(f.session().compactBarrier ?? null, null);
    } finally {
      loader.getBubbleSessionManager = getManager;
    }
  }

  console.log('Bubble steer: applied steer, unread steer followed as an SDK turn, image and skill queued turns, back-to-back sends, stop and dispose cleanup, deferred compact, failed-turn cleanup, send order, no turn for a steer after Stop, silence after a stop mid-read or mid-load, ordered replay and a failed follow-up turn, a stop during the first start or while the thread changes hands, skill detection matching the SDK, and compactions keeping their place passed');
} finally {
  loader.getBubbleSdk = originalSdk;
  if (previousHome === undefined) delete process.env.BUBBLE_HOME;
  else process.env.BUBBLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}

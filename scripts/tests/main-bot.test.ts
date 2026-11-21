// The main bot's rules: where a task goes and to which agent, what a working
// task does with a message, how replies get back to the bot, and what it
// keeps outside its conversation (notes, the record of what it handed out).
// Against an in-memory SQLite database, a fake host and a temporary folder.
// Run: npx tsx scripts/tests/main-bot.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAIN_BOT_BUILTIN_TOOLS, MAIN_BOT_INSTRUCTIONS, MAIN_BOT_LIMITS, isMainBotLookupToolName, isMainBotTaskActionToolName, mainBotReportTitles, mainBotToolKind, mainBotWorkflowCalledOff, parseMainBotTaskResult } from '../../src/shared/main-bot';
import {
  MainBotService,
  NOT_SIGNED_IN,
  claudeForModel,
  localTaskState,
  mainBotContextLimit,
  taskBrief,
  workflowWaitingOn,
  type MainBotAgent,
  type MainBotChatLine,
  type MainBotDevice,
  type MainBotHost,
  type MainBotStart,
  type MainBotTask,
  type ToolOutcome,
} from '../../src/electron/libs/main-bot/service';
import { MAIN_BOT_MEMORY_LIMITS, MainBotMemory } from '../../src/electron/libs/main-bot/memory';
import { STARTUP_FAILED, remoteStartSettings, startTaskSession } from '../../src/electron/libs/main-bot/start';
import { MainBotStore, type MainBotDb } from '../../src/electron/libs/main-bot/store';
import { mainBotTurnOptions } from '../../src/electron/libs/main-bot/tools';

/** The notes listed in full: with the message that opens a context, and now and then after. */
const NOTES_IN_FULL = /Your notes(?:: none yet| \(read_memory shows one in full)/;
const LOCAL_ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(prepare?: (db: MainBotDb) => void) {
  let clock = 1_000_000;
  const db = new DatabaseSync(':memory:') as unknown as MainBotDb;
  prepare?.(db);
  const store = new MainBotStore(db);
  const notesDir = join(mkdtempSync(join(tmpdir(), 'main-bot-notes-')), 'memory');
  const memory = new MainBotMemory(notesDir);
  const world = {
    devices: [
      { id: null, name: 'MacBook', online: true, projects: [{ name: 'coworker', path: '/code/coworker' }, { name: 'notes', path: '/code/notes' }] },
      { id: 'mini', name: 'Mac mini', online: true, projects: [{ name: 'coworker', remoteId: 'p1', isRepo: true }, { name: 'server', remoteId: 'p2', isRepo: false }] },
    ] as MainBotDevice[],
    tasks: [] as MainBotTask[],
    agents: {
      local: [
        { provider: 'claude', label: 'Claude', unavailable: null },
        { provider: 'codex', label: 'Codex', unavailable: null },
        { provider: 'kimi', label: 'Kimi', unavailable: 'not signed in' },
      ] as MainBotAgent[] | null,
      mini: [{ provider: 'codex', label: 'Codex', unavailable: null }] as MainBotAgent[] | null,
    },
    /** The model each question about a Mac's agents came with. */
    agentModels: [] as Array<string | undefined>,
    preferred: 'claude',
    gitRepos: new Set(['/code/coworker']),
    starts: [] as MainBotStart[],
    sends: [] as Array<{ taskId: string; prompt: string }>,
    stops: [] as string[],
    /** Answers given to workflows that waited to be started. */
    workflowDecisions: [] as Array<[string, boolean]>,
    /** The run each decision named, with the revision it was shown at when it came from a card. */
    workflowRuns: [] as Array<{ id: string; revision?: number }>,
    /** Where a run stands now, when a test cares: a decision for another revision is refused. */
    workflowRevisions: new Map<string, number>(),
    told: [] as Array<{ label: string; text: string }>,
    /** What happens while the bot is being told, before its turn has begun. */
    whileTelling: null as null | (() => Promise<void>),
    replies: new Map<string, { asked: string | null; reply: string }>(),
    main: { id: 'main', busy: false, turn: { startedAt: 1, typed: true } as { startedAt: number; typed: boolean } | null },
    sendFails: false,
    tellFails: false,
    nextLocal: 1,
    /** Tasks on this Mac that exist without being listed. */
    archived: new Set<string>(),
    /** Whether the bot's agent can be put on an empty thread now, and how often it was. */
    threadFree: true,
    /** The app fails halfway through putting it there. */
    threadBroken: false,
    freshThreads: [] as boolean[],
    /** Which of those started by themselves. */
    automatic: [] as boolean[],
    /** The bot's conversation by turns: what the person wrote (null: a report came in) and its answer. */
    conversation: [] as Array<{ asked: string | null; reply: string; at?: number }>,
    /** Its lines as they are, when a test needs more than turns. */
    chat: null as MainBotChatLine[] | null,
  };
  const host: MainBotHost = {
    now: () => clock,
    devices: () => world.devices,
    tasks: () => world.tasks,
    agents: async (deviceId, model) => {
      world.agentModels.push(model);
      return deviceId === null ? world.agents.local : world.agents.mini;
    },
    preferredAgent: () => world.preferred,
    isGitRepo: async (path) => world.gitRepos.has(path),
    start: async (input) => {
      world.starts.push(input);
      const local = input.device.id === null;
      const id = local ? LOCAL_ID(world.nextLocal++) : `rh-aaaaaaaaaaaa-s${world.starts.length}`;
      world.tasks.push({
        id,
        ...(local ? { number: 100 + world.starts.length } : {}),
        title: input.title,
        deviceId: input.device.id,
        device: input.device.name,
        project: input.project?.name ?? null,
        agent: input.agent,
        state: 'working',
        updatedAt: clock,
      });
      return { id };
    },
    send: async (taskId, prompt) => {
      if (world.sendFails) return { error: 'The message could not be sent to that task.' };
      world.sends.push({ taskId, prompt });
      const task = world.tasks.find((entry) => entry.id === taskId);
      if (task) task.state = 'working';
      return { ok: true };
    },
    stop: async (taskId) => {
      world.stops.push(taskId);
      return { ok: true };
    },
    decideWorkflow: async (taskId, start, run) => {
      const task = world.tasks.find((entry) => entry.id === taskId);
      const waits = task?.workflowWaits;
      if (!task || waits?.kind !== 'start' || waits.runId !== run.id) return { error: 'That workflow no longer waits to be started.' };
      const stands = world.workflowRevisions.get(run.id);
      if (run.revision !== undefined && stands !== undefined && stands !== run.revision) return { error: 'The workflow changed. Look at it again.' };
      const title = waits.title;
      world.workflowDecisions.push([taskId, start]);
      world.workflowRuns.push(run);
      delete task.workflowWaits;
      if (start) task.runsWorkflow = true;
      task.state = start ? 'working' : 'idle';
      return { ok: true, title };
    },
    lastTurn: async (taskId) => world.replies.get(taskId) ?? null,
    exists: (taskId) => !/^[0-9a-f]{8}-/.test(taskId) || world.archived.has(taskId) || world.tasks.some((task) => task.id === taskId),
    main: () => world.main,
    freshThread: (entering, automatic) => {
      if (world.threadBroken) throw new Error('the thread could not be reset');
      if (!world.threadFree && !entering) return false;
      world.freshThreads.push(entering);
      world.automatic.push(automatic);
      return true;
    },
    conversation: () => {
      if (world.chat) return world.chat;
      const lines: MainBotChatLine[] = [];
      for (const turn of world.conversation) {
        lines.push({ seq: lines.length + 1, at: turn.at ?? clock, who: turn.asked === null ? 'report' : 'person', text: turn.asked ?? 'Task report: Profile the export' });
        if (turn.reply) lines.push({ seq: lines.length + 1, at: turn.at ?? clock, who: 'you', text: turn.reply });
      }
      return lines;
    },
    tellMain: async (label, text) => {
      if (world.tellFails) return false;
      world.told.push({ label, text });
      // Starting the bot's turn takes a moment, in which more can happen.
      await world.whileTelling?.();
      return true;
    },
  };
  const bot = new MainBotService(store, host, memory);
  return { bot, store, world, memory, notesDir, db, host, tick: (ms: number) => { clock += ms; } };
}

const ok = (outcome: ToolOutcome) => {
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  return JSON.parse((outcome as { text: string }).text);
};
const error = (outcome: ToolOutcome) => {
  assert.equal(outcome.ok, false, outcome.ok ? outcome.text : '');
  return (outcome as { error: string }).error;
};
const finish = (task: MainBotTask | undefined, state: MainBotTask['state'] = 'idle') => {
  assert.ok(task);
  task.state = state;
};

async function main() {
  // --- Where a task runs ---
  {
    const { bot, world } = setup();
    // The same project name on two Macs: the bot has to say which.
    assert.match(error(await bot.startTask({ title: 'Fix it', prompt: 'Fix the bug', project: 'coworker' })), /several places.*MacBook.*Mac mini/);
    const here = ok(await bot.startTask({ title: 'Fix it', prompt: 'Fix the bug', project: 'coworker', device: 'this Mac' }));
    assert.equal(here.device, 'MacBook');
    assert.equal(world.starts[0].worktree, true, 'a git project on this Mac gets a worktree');
    assert.equal(world.starts[0].effectivePrompt, taskBrief('Fix the bug'));
    assert.equal(world.starts[0].prompt, 'Fix the bug', 'the conversation shows the bot\'s words only');
    assert.equal(here.link, `aegis://sessions/${LOCAL_ID(1)}`);
    const there = ok(await bot.startTask({ title: 'Deploy', prompt: 'Deploy it', project: 'server' }));
    assert.equal(there.device, 'Mac mini', 'a project on one Mac only needs no device');
    assert.equal(world.starts[1].worktree, false, 'not a repository there: no worktree');
    assert.equal(there.link, undefined, 'a session on another Mac has no link');
    const plain = ok(await bot.startTask({ title: 'Notes', prompt: 'Summarise', project: '/code/notes' }));
    assert.equal(plain.where, 'the project folder');
    const chat = ok(await bot.startTask({ title: 'Research', prompt: 'Look this up' }));
    assert.equal(chat.where, 'a conversation with no project');
    assert.equal(world.starts[3].project, null);
    assert.match(error(await bot.startTask({ title: 'X', prompt: 'Y', project: 'nope' })), /no project "nope".*MacBook: coworker, notes.*Mac mini: coworker, server/);
    assert.match(error(await bot.startTask({ title: 'X', prompt: 'Y', device: 'Mac mini' })), /needs a project/);
    world.devices[1].online = false;
    assert.match(error(await bot.startTask({ title: 'X', prompt: 'Y', project: 'server' })), /Mac mini is offline/);
    assert.match(error(await bot.startTask({ title: '', prompt: 'Y' })), /"title" is required/);
  }

  // --- Which agent ---
  {
    const { bot, world, tick } = setup();
    // Nothing known about the project: the composer's agent.
    assert.equal(ok(await bot.startTask({ title: 'A', prompt: 'a', project: 'notes' })).agent, 'Claude');
    // The agent last used in that project comes first.
    world.tasks.push({ id: LOCAL_ID(50), title: 'Earlier', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Codex', state: 'idle', updatedAt: 2_000_000 });
    tick(10);
    assert.equal(ok(await bot.startTask({ title: 'B', prompt: 'b', project: 'notes' })).agent, 'Codex');
    // A named agent is used, or refused: never swapped.
    assert.equal(ok(await bot.startTask({ title: 'C', prompt: 'c', project: 'notes', agent: 'claude' })).agent, 'Claude');
    assert.match(error(await bot.startTask({ title: 'D', prompt: 'd', project: 'notes', agent: 'Kimi' })), /Kimi can't take work.*not signed in.*Ready there: Claude, Codex/);
    assert.match(error(await bot.startTask({ title: 'D', prompt: 'd', project: 'notes', agent: 'gpt' })), /no agent "gpt"/);
    // The usual one can't take work: the next in line does, and the result says so.
    world.agents.local![1].unavailable = 'at its usage limit';
    const passed = ok(await bot.startTask({ title: 'E', prompt: 'e', project: 'notes' }));
    assert.equal(passed.agent, 'Claude');
    assert.match(passed.note, /Codex can't take work now \(at its usage limit\), so it went to Claude/);
    // Neither can, and nothing else is ready: the person is asked.
    world.agents.local![0].unavailable = 'not signed in';
    assert.match(error(await bot.startTask({ title: 'F', prompt: 'f', project: 'notes' })), /Ask the person which agent to use/);
    // The usual ones are not on that Mac, and one agent is ready there: it takes the task.
    const only = ok(await bot.startTask({ title: 'G', prompt: 'g', project: 'server' }));
    assert.equal(only.agent, 'Codex');
    assert.match(only.note, /Codex is the only agent ready on Mac mini/);
    // With several ready and none of them the usual one, the person is asked.
    world.agents.mini = [{ provider: 'codex', label: 'Codex', unavailable: null }, { provider: 'devin', label: 'Devin', unavailable: null }];
    world.tasks = world.tasks.filter((task) => task.deviceId === null);
    assert.match(error(await bot.startTask({ title: 'G2', prompt: 'g', project: 'server' })), /claude is not set up on Mac mini.*Ready on Mac mini: Codex, Devin/);
    // A Mac that can't list its agents takes the named one as it is.
    world.agents.mini = null;
    assert.equal(world.starts.at(-1)!.agent, 'codex');
    assert.equal(ok(await bot.startTask({ title: 'H', prompt: 'h', project: 'server', agent: 'Devin' })).agent, 'Devin');
    assert.equal(world.starts.at(-1)!.agent, 'devin');
  }

  // --- A reply comes back once, when the turn ends ---
  {
    const { bot, store, world } = setup();
    const started = ok(await bot.startTask({ title: 'Fix it', prompt: 'Fix the bug', project: 'notes' }));
    const id = started.sessionId as string;
    assert.ok(store.get(id), 'the bot waits on a task it started');
    world.replies.set(id, { asked: 'Fix the bug', reply: 'Fixed in ```a.ts```. Tests pass.' });
    finish(world.tasks.find((task) => task.id === id));
    world.main.busy = true;
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 0, 'a busy bot is not interrupted');
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 1);
    assert.deepEqual(mainBotReportTitles(world.told[0].label), ['Fix it']);
    assert.match(world.told[0].text, /\[Report from "Fix it"\] \(aegis:\/\/sessions\//);
    assert.match(world.told[0].text, /````\nFixed in ```a\.ts```\. Tests pass\.\n````/, 'the reply sits in a fence it cannot close');
    assert.equal(store.get(id), null, 'reported: the bot no longer waits on it');
    // The user goes on in the task themselves: nothing more comes to the bot.
    await bot.onTaskTurnEnded(id, 'completed');
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 1);
    // A turn end for a task the bot never touched is not its business.
    await bot.onTaskTurnEnded(LOCAL_ID(999), 'completed');
    assert.equal(world.told.length, 1);
  }

  // --- Several reports go as one message; a failed send keeps them ---
  {
    const { bot, store, world } = setup();
    const a = ok(await bot.startTask({ title: 'One', prompt: 'a', project: 'notes' })).sessionId as string;
    const b = ok(await bot.startTask({ title: 'Two', prompt: 'b', project: 'notes' })).sessionId as string;
    world.replies.set(a, { asked: 'a', reply: 'done a' });
    world.main.busy = true;
    await bot.onTaskTurnEnded(a, 'completed');
    await bot.onTaskTurnEnded(b, 'error', 'The agent crashed');
    world.main.busy = false;
    world.tellFails = true;
    assert.equal(await bot.deliver(), false);
    assert.ok(store.get(a)?.report, 'an undelivered report stays');
    world.tellFails = false;
    assert.equal(await bot.deliver(), true);
    assert.equal(world.told.length, 1);
    assert.deepEqual(mainBotReportTitles(world.told[0].label), ['One', 'Two']);
    assert.match(world.told[0].text, /2 tasks you handed work to/);
    assert.match(world.told[0].text, /\[Report from "Two"\].*It stopped with an error\./);
    assert.match(world.told[0].text, /The agent crashed/);
    assert.equal(store.all().length, 0);
  }

  // --- A working task gets a message when its turn ends ---
  {
    const { bot, store, world } = setup();
    world.tasks.push({ id: LOCAL_ID(7), number: 7, title: 'Refactor', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'working', updatedAt: 1 });
    const held = ok(await bot.messageTask({ task: '#7', message: 'Also update the docs' }));
    assert.match(held.note, /gets this as soon as its current turn ends/);
    assert.equal(world.sends.length, 0);
    ok(await bot.messageTask({ task: 'Refactor', message: 'And the changelog' }));
    assert.deepEqual(store.get(LOCAL_ID(7))?.held, ['Also update the docs', 'And the changelog']);
    world.replies.set(LOCAL_ID(7), { asked: 'x', reply: 'first turn done' });
    finish(world.tasks[0]);
    await bot.onTaskTurnEnded(LOCAL_ID(7), 'completed');
    assert.deepEqual(world.sends, [{ taskId: LOCAL_ID(7), prompt: 'Also update the docs\n\nAnd the changelog' }]);
    assert.equal(world.told.length, 0, 'the first turn is not reported: the task is not done with what the bot asked');
    world.replies.set(LOCAL_ID(7), { asked: 'Also update the docs', reply: 'docs and changelog updated' });
    finish(world.tasks[0]);
    await bot.onTaskTurnEnded(LOCAL_ID(7), 'completed');
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /docs and changelog updated/);
    // An idle task gets a message at once.
    const sent = ok(await bot.messageTask({ task: '7', message: 'One more thing' }));
    assert.match(sent.note, /^Sent/);
    assert.equal(world.sends.length, 2);
    // A stopped task does not get what was waiting; the report says so.
    world.tasks[0].state = 'working';
    ok(await bot.messageTask({ task: '#7', message: 'Never mind the rest' }));
    finish(world.tasks[0]);
    await bot.onTaskTurnEnded(LOCAL_ID(7), 'stopped');
    assert.equal(world.sends.length, 2);
    assert.match(world.told[1].text, /It was stopped\./);
    assert.match(world.told[1].text, /your message to it was not delivered/);
    assert.match(error(await bot.messageTask({ task: 'Nothing like it', message: 'hi' })), /no task "Nothing like it"/);
    assert.match(error(await bot.messageTask({ task: '#999', message: 'hi' })), /no task #999 on this Mac/);
  }

  // --- stop_task: the bot stopped it, so no report follows ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Long job', prompt: 'run', project: 'notes' })).sessionId as string;
    const stopped = ok(await bot.stopTask({ task: 'Long job' }));
    assert.match(stopped.note, /^Stopped\./);
    assert.deepEqual(world.stops, [id]);
    assert.equal(store.get(id), null);
    finish(world.tasks.find((task) => task.id === id));
    await bot.onTaskTurnEnded(id, 'stopped');
    assert.equal(world.told.length, 0);
    assert.match(ok(await bot.stopTask({ task: 'Long job' })).note, /nothing to stop/);
    assert.equal(world.stops.length, 1);
  }

  // --- Tasks on another Mac: seen working, then not ---
  {
    const { bot, store, world, tick } = setup();
    const id = ok(await bot.startTask({ title: 'Deploy', prompt: 'deploy', project: 'server' })).sessionId as string;
    assert.ok(id.startsWith('rh-'));
    assert.equal(bot.waitsOnRemote(), true);
    await bot.checkRemote();
    assert.equal(world.told.length, 0, 'still working');
    world.replies.set(id, { asked: 'deploy', reply: 'deployed' });
    finish(world.tasks.find((task) => task.id === id));
    await bot.checkRemote();
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /\[Report from "Deploy" on Mac mini\] Its reply/);
    assert.equal(bot.waitsOnRemote(), false);
    // One that never showed as working gets a moment before it counts as done.
    ok(await bot.messageTask({ task: id, message: 'again' }));
    finish(world.tasks.find((task) => task.id === id));
    await bot.checkRemote();
    assert.equal(world.told.length, 1, 'it may not have shown up as working yet');
    tick(11_000);
    await bot.checkRemote();
    assert.equal(world.told.length, 2);
    // Out of reach: it keeps waiting.
    ok(await bot.messageTask({ task: id, message: 'once more' }));
    const kept = world.tasks.splice(0);
    tick(60_000);
    await bot.checkRemote();
    assert.ok(store.get(id));
    world.tasks.push(...kept);
    // Still listed, as it stood when its Mac went offline: that says nothing of the turn. It keeps waiting too.
    const mini = world.devices.find((device) => device.id === 'mini');
    assert.ok(mini);
    mini.online = false;
    finish(world.tasks.find((task) => task.id === id));
    world.replies.set(id, { asked: 'once more', reply: 'done once more' });
    tick(60_000);
    await bot.checkRemote();
    assert.equal(world.told.length, 2, 'an offline Mac reports nothing');
    assert.ok(store.get(id));
    assert.equal(bot.waitsOnRemote(), true);
    mini.online = true;
    await bot.checkRemote();
    assert.equal(world.told.length, 3);
    assert.match(world.told[2].text, /done once more/);
  }

  // --- A task on another Mac starts with this Mac's composer permission mode, as one here does ---
  {
    const desktop = {
      'cowork.preferredBubblePermissionMode': 'bypassPermissions',
      'cowork.preferredCodexPermissionMode': 'fullAccess',
      'cowork.preferredClaudePermissionMode': 'plan',
      'cowork.preferredDevinPermissionMode': 'bypass',
      'cowork.preferredKimiPermissionMode': 'yolo',
      // This Mac's models are not the other Mac's: never sent unless the bot named one.
      'cowork.preferredBubbleModel': 'local-only-model',
    };
    // Full Access in the composer here is Full Access there; without it that Mac asks before every command.
    assert.deepEqual(remoteStartSettings('bubble', undefined, desktop), { permissionMode: 'bypassPermissions' });
    assert.deepEqual(remoteStartSettings('bubble', 'kimi-k2', desktop), { model: 'kimi-k2', permissionMode: 'bypassPermissions' });
    assert.deepEqual(remoteStartSettings('codex', undefined, desktop), { permissionMode: 'fullAccess' });
    assert.deepEqual(remoteStartSettings('devin', undefined, desktop), { permissionMode: 'bypass' });
    // Nothing chosen here: nothing said, and that Mac starts the agent on its default.
    assert.equal(remoteStartSettings('bubble', undefined, {}), undefined);
    assert.deepEqual(remoteStartSettings('bubble', 'kimi-k2', {}), { model: 'kimi-k2' });
    assert.equal(remoteStartSettings('minimax', undefined, desktop), undefined);
    // A dispatched task does the work: the composer's leftover plan mode is not a mode to start it in.
    assert.equal(remoteStartSettings('claude', undefined, desktop), undefined);
    // A mode that Mac would not take for this agent is not sent, nor one of an agent it cannot run.
    assert.equal(remoteStartSettings('bubble', undefined, { 'cowork.preferredBubblePermissionMode': 'fullAccess' }), undefined);
    assert.equal(remoteStartSettings('kimi', undefined, desktop), undefined);
  }

  // --- A session that exists but whose agent never started: the bot hears of it ---
  {
    const calls: Array<[string, string]> = [];
    const failed = (sessionId: string, why: string) => void calls.push([sessionId, why]);
    // The id is the answer as soon as the session exists; a start that comes to nothing afterwards is reported.
    assert.equal(await startTaskSession(async (created) => (created('s1'), null), failed), 's1');
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, [['s1', STARTUP_FAILED]]);
    // So is one that throws afterwards, with what it threw.
    calls.length = 0;
    assert.equal(await startTaskSession(async (created) => { created('s2'); throw new Error('no worktree'); }, failed), 's2');
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, [['s2', `${STARTUP_FAILED} (no worktree)`]]);
    // A start that went well, and one that made no session, report nothing here.
    calls.length = 0;
    assert.equal(await startTaskSession(async (created) => (created('s3'), 's3'), failed), 's3');
    assert.equal(await startTaskSession(async () => null, failed), null);
    await assert.rejects(startTaskSession(async () => { throw new Error('refused'); }, failed), /refused/);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, []);

    // With the bot: it waits on the task by the time the failure arrives, and gets a report for it.
    const { bot, store, world, host } = setup();
    const plain = host.start;
    host.start = async (input) => {
      const made = await plain(input);
      if ('error' in made) return made;
      const id = await startTaskSession(
        async (created) => (created(made.id), null),
        // As the app does it: after the rest of the turn's teardown.
        (sessionId, why) => setTimeout(() => {
          finish(world.tasks.find((task) => task.id === sessionId), 'failed');
          void bot.onTaskTurnEnded(sessionId, 'error', why);
        }, 0),
      );
      return id ? { id } : { error: 'The task could not start.' };
    };
    const id = ok(await bot.startTask({ title: 'Never ran', prompt: 'run', project: 'notes' })).sessionId as string;
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(world.told.length, 1, 'the bot is told instead of waiting until the app starts again');
    assert.match(world.told[0].text, /\[Report from "Never ran"\].* It stopped with an error\./);
    assert.ok(world.told[0].text.includes(STARTUP_FAILED));
    assert.equal(store.get(id), null);
  }

  // --- A task that runs a workflow is at work, though no turn of its own runs ---
  {
    const stands = (task: Partial<Parameters<typeof localTaskState>[0]>) =>
      localTaskState({ waitsForApproval: false, running: false, runsWorkflow: false, asks: null, failed: false, ...task });
    assert.deepEqual(stands({}), { state: 'idle' });
    assert.deepEqual(stands({ running: true }), { state: 'working' });
    assert.deepEqual(stands({ runsWorkflow: true }), { state: 'working' });
    // What its last own turn said is behind it once the workflow runs.
    assert.deepEqual(stands({ runsWorkflow: true, asks: 'Which branch?', failed: true }), { state: 'working' });
    // A command waiting for the person comes first, as before.
    assert.deepEqual(stands({ runsWorkflow: true, waitsForApproval: true }), { state: 'needs approval' });
    assert.deepEqual(stands({ asks: 'Which branch?', failed: true }), { state: 'asks', waitingOn: 'Which branch?' });
    assert.deepEqual(stands({ failed: true }), { state: 'failed' });

    // The bot lists it with the tasks at work, and does not claim to have stopped it.
    const { bot, world } = setup();
    world.tasks.push({
      id: LOCAL_ID(7),
      number: 107,
      title: 'Ship the diff fix',
      deviceId: null,
      device: 'MacBook',
      project: 'coworker',
      agent: 'Claude',
      state: 'working',
      closedToMessages: 'It is running a workflow, which sends it its part of the work. Write to it once the workflow has ended.',
      runsWorkflow: true,
      updatedAt: 1_000_000,
    });
    const working = ok(await bot.listTasks({ state: 'working' }));
    assert.equal(JSON.stringify(working).includes('Ship the diff fix'), true);
    assert.match(error(await bot.stopTask({ task: 'Ship the diff fix' })), /is running a workflow, which cannot be stopped from here/);
    assert.deepEqual(world.stops, []);
  }

  // --- A workflow a task prepared waits for the person: the bot hears of it, and passes their answer on ---
  {
    const waits = { runId: 'run-review', kind: 'start' as const, title: 'Codex review', detail: 'Members: codex GPT-6.2-Sol xhigh reviewer, read-only. Runs: npm test.' };
    assert.deepEqual(localTaskState({ waitsForApproval: false, running: false, runsWorkflow: false, workflowWaits: waits, asks: null, failed: false }), {
      state: 'needs approval',
      waitingOn: workflowWaitingOn(waits),
    });
    assert.match(workflowWaitingOn(waits), /^the person to start its workflow "Codex review" \(Members: .*\); confirm_workflow does it once they said so$/);
    assert.match(workflowWaitingOn({ runId: 'run-review', kind: 'answer', title: 'Codex review', detail: 'Which branch?' }), /^the person to answer its workflow "Codex review" in the task: Which branch\?$/);
    assert.equal(mainBotToolKind('confirm_workflow'), 'workflow');
    assert.equal(isMainBotTaskActionToolName('confirm_workflow'), true);
    assert.deepEqual([mainBotWorkflowCalledOff({ decision: 'cancel' }), mainBotWorkflowCalledOff({ decision: 'start' })], [true, false]);

    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Review the SDK bump', prompt: 'have Codex review it', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    // Its turn ends on "the workflow runs in the background", while the workflow waits to be started.
    task.state = 'needs approval';
    task.workflowWaits = waits;
    task.waitingOn = workflowWaitingOn(waits);
    world.replies.set(id, { asked: 'have Codex review it', reply: 'Handed to Codex; the workflow runs in the background.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /\[Report from "Review the SDK bump"\].* Its reply, written by the agent that ran it:/);
    assert.match(world.told[0].text, /\[About "Review the SDK bump"\].* From Aegis, not from the agent that runs it: It prepared the workflow "Codex review", which has NOT started/);
    assert.ok(world.told[0].text.includes('Runs: npm test.'));
    assert.ok(store.get(id), 'the bot keeps waiting: the result comes with a later turn');
    assert.equal(store.get(id)?.report, null);
    // The same wait is told once.
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 1);
    // The bot's view of how things stand says who has to act.
    assert.match(bot.turnContext('main'), /Waiting for the person:\n- "Review the SDK bump".*: needs approval, the person to start its workflow "Codex review"/);

    // On a report the bot may not answer for the person.
    world.main.turn = { startedAt: 2, typed: false };
    assert.match(error(await bot.confirmWorkflow({ task: id, decision: 'start' })), /Only the person decides whether the workflow "Codex review" starts/);
    assert.deepEqual(world.workflowDecisions, []);
    assert.match(error(await bot.confirmWorkflow({ task: id, decision: 'maybe' })), /"decision" is "start" or "cancel"/);
    // The person said yes in the conversation.
    world.main.turn = { startedAt: 3, typed: true };
    const started = ok(await bot.confirmWorkflow({ task: id, decision: 'start' }));
    assert.match(started.note, /The workflow "Codex review" runs now/);
    assert.equal(started.sessionId, id);
    assert.deepEqual(world.workflowDecisions, [[id, true]]);
    assert.deepEqual(world.workflowRuns, [{ id: 'run-review' }], 'the run the bot was told about');
    assert.match(error(await bot.confirmWorkflow({ task: id, decision: 'start' })), /No workflow of "Review the SDK bump" waits for the person/);
    // The workflow ends and the task says what came of it: that reaches the bot, and the wait is over.
    delete task.runsWorkflow;
    task.state = 'idle';
    world.replies.set(id, { asked: null, reply: 'Codex found two problems.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /Its reply, written by the agent that ran it:[\s\S]*Codex found two problems\./);
    assert.equal(world.told[1].text.includes('[About '), false);
    assert.equal(store.get(id), null);
  }

  // --- A workflow still being planned when the turn ends; the person calls it off in the task ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Plan the migration', prompt: 'plan it', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    task.runsWorkflow = true;
    world.replies.set(id, { asked: 'plan it', reply: 'A workflow is planning it.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /It goes on through a workflow it started\./);
    assert.ok(store.get(id));
    // Planned: now it waits for the person. That is news of its own.
    delete task.runsWorkflow;
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-plan', kind: 'start', title: 'Migration plan', detail: 'Members: claude implementer.' };
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /^Something changed for a task you handed work to\./);
    assert.match(world.told[1].text, /\[About "Plan the migration"\].*"Migration plan", which has NOT started/);
    assert.equal(world.told[1].text.includes('[Report from'), false);
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 2);
    // Started in the task, it runs, and comes to wait for the very same thing again: that is news again.
    const again = task.workflowWaits;
    delete task.workflowWaits;
    task.runsWorkflow = true;
    task.state = 'working';
    await bot.onWorkflowChanged(id, 'running');
    assert.equal(world.told.length, 2);
    delete task.runsWorkflow;
    task.state = 'needs approval';
    task.workflowWaits = again;
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 3);
    assert.match(world.told[2].text, /\[About "Plan the migration"\].*"Migration plan", which has NOT started/);
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 3);
    // Called off in the task: no turn follows, so the bot is told and stops waiting.
    delete task.workflowWaits;
    task.state = 'idle';
    await bot.onWorkflowChanged(id, 'cancelled');
    assert.equal(world.told.length, 4);
    assert.match(world.told[3].text, /Its workflow was called off before it ended/);
    assert.equal(store.get(id), null);
  }

  // --- The person tells the bot to call a waiting workflow off; a question of a workflow is theirs to answer ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Rewrite the parser', prompt: 'rewrite', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-parser', kind: 'start', title: 'Parser rewrite', detail: '' };
    world.replies.set(id, { asked: 'rewrite', reply: 'Prepared a workflow.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 1);
    const off = ok(await bot.confirmWorkflow({ task: id, decision: 'cancel' }));
    assert.match(off.note, /was called off; it will not run/);
    assert.deepEqual(world.workflowDecisions, [[id, false]]);
    assert.equal(store.get(id), null, 'nothing more is waited for');
    await bot.onWorkflowChanged(id, 'cancelled');
    assert.equal(world.told.length, 1, 'its own doing is no news to it');
    task.workflowWaits = { runId: 'run-parser', kind: 'answer', title: 'Parser rewrite', detail: 'Which grammar?' };
    assert.match(error(await bot.confirmWorkflow({ task: id, decision: 'start' })), /asks the person something only they can answer, in the task itself/);
  }

  // --- Start and Cancel on the card in the bot's conversation: the person's own answer, with no turn of theirs ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Bump the SDK', prompt: 'bump it, then have Codex review', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    // A task the person runs themselves, with a workflow of its own waiting: answered in that task, no card here.
    const own = { ...task, id: 'own-task', title: 'My own task', workflowWaits: { runId: 'run-own', kind: 'start' as const, title: 'Own plan', detail: '' } };
    world.tasks.push(own);
    assert.deepEqual(bot.workflowCards(), []);
    assert.deepEqual(await bot.decideWorkflowCard('own-task', { id: 'run-own', revision: 1 }, true), { ok: false, error: 'No workflow of this task waits to be started here.' });
    assert.deepEqual(world.workflowDecisions, []);
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-1', kind: 'start', title: 'Codex review', detail: '' };
    world.workflowRevisions.set('run-1', 2);
    world.replies.set(id, { asked: 'bump it', reply: 'Prepared a workflow.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 1);
    assert.deepEqual(bot.workflowCards(), [id]);
    // Pressed while the bot's last turn was a report: the press is the person's, so it counts.
    world.main.turn = { startedAt: 2, typed: false };
    // A card that shows another run of the task, or this one as it was before its plan changed, starts nothing.
    assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-0', revision: 2 }, true), { ok: false, error: 'That workflow no longer waits to be started.' });
    assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-1', revision: 1 }, true), { ok: false, error: 'The workflow changed. Look at it again.' });
    assert.deepEqual(world.workflowDecisions, []);
    assert.deepEqual(bot.workflowCards(), [id]);
    assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-1', revision: 2 }, true), { ok: true });
    assert.deepEqual(world.workflowDecisions, [[id, true]]);
    assert.deepEqual(world.workflowRuns, [{ id: 'run-1', revision: 2 }], 'the run the card showed, as it showed it');
    assert.deepEqual(bot.workflowCards(), []);
    assert.ok(store.get(id), 'started: what comes of it is reported back');
    assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-1', revision: 2 }, true), { ok: false, error: 'That workflow no longer waits to be started.' });
    // What the workflow came to reaches the bot.
    task.state = 'idle';
    world.replies.set(id, { asked: null, reply: 'Codex approved.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /Codex approved\./);

    // Cancel on the card: nothing more is waited for, and the bot gets no news of what the person did right here.
    world.main.turn = { startedAt: 3, typed: true };
    ok(await bot.messageTask({ task: id, message: 'review again' }));
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-2', kind: 'start', title: 'Second review', detail: '' };
    world.replies.set(id, { asked: 'review again', reply: 'Prepared another.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 3);
    assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-2', revision: 1 }, false), { ok: true });
    assert.deepEqual(world.workflowDecisions[1], [id, false]);
    assert.equal(store.get(id), null);
    await bot.onWorkflowChanged(id, 'cancelled');
    assert.equal(world.told.length, 3);
    // A workflow that asks something is answered in the task.
    task.workflowWaits = { runId: 'run-3', kind: 'answer', title: 'Second review', detail: 'Which branch?' };
    assert.deepEqual(bot.workflowCards(), []);
    assert.equal((await bot.decideWorkflowCard(id, { id: 'run-3', revision: 1 }, true)).ok, false);
  }

  // --- Answered before the bot heard of the wait: it is not told to ask for what was already decided ---
  for (const start of [true, false]) {
    for (const where of ['card', 'task'] as const) {
      const { bot, store, world } = setup();
      const id = ok(await bot.startTask({ title: 'Review the dialog fix', prompt: 'have Codex review it', project: 'notes' })).sessionId as string;
      const task = world.tasks.find((entry) => entry.id === id);
      assert.ok(task);
      assert.equal(bot.cardsHeld(), false);
      // Its turn ends while the workflow is still being planned; the bot is told, and writes its reply.
      task.runsWorkflow = true;
      world.replies.set(id, { asked: 'have Codex review it', reply: 'A workflow is planning the review.' });
      await bot.onTaskTurnEnded(id, 'completed');
      assert.equal(world.told.length, 1);
      world.main.busy = true;
      world.main.turn = { startedAt: 2, typed: false };
      // Planned while the bot still writes: the word to the bot has to wait, and the card in its conversation with it.
      delete task.runsWorkflow;
      task.state = 'needs approval';
      task.workflowWaits = { runId: 'run-early', kind: 'start', title: 'Codex review', detail: 'Members: codex reviewer, read-only.' };
      await bot.onWorkflowChanged(id, 'awaiting_confirmation');
      assert.equal(world.told.length, 1);
      assert.equal(bot.cardsHeld(), true);
      assert.deepEqual(bot.workflowCards(), [id]);
      // The person answers before the bot's turn is over: on a card drawn before it began, or in the task itself.
      if (where === 'card') {
        assert.deepEqual(await bot.decideWorkflowCard(id, { id: 'run-early', revision: 1 }, start), { ok: true });
      } else {
        delete task.workflowWaits;
        if (start) task.runsWorkflow = true;
        task.state = start ? 'working' : 'idle';
      }
      await bot.onWorkflowChanged(id, start ? 'running' : 'cancelled');
      world.main.busy = false;
      await bot.onMainTurnEnded();
      assert.equal(bot.cardsHeld(), false);
      const news = world.told.slice(1).map((entry) => entry.text).join('\n');
      assert.equal(news.includes('NOT started'), false, 'nothing is asked of the person that they already answered');
      if (where === 'task' && !start) {
        // Called off in the task: no turn follows that, so the bot hears of it, and only of it.
        assert.equal(world.told.length, 2);
        assert.match(news, /Its workflow was called off before it ended/);
      } else {
        assert.equal(world.told.length, 1);
      }
      assert.equal(Boolean(store.get(id)), start, 'started: its result is still waited for; called off: nothing is');
    }
  }

  // --- A reply that says "press Start", not taken yet when the person does: what happened since goes with it ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Review the dialog fix', prompt: 'have Codex review it', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    world.main.busy = true;
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-late', kind: 'start', title: 'Codex review', detail: '' };
    world.replies.set(id, { asked: 'have Codex review it', reply: 'Prepared the review. Press Start on its card.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 0);
    // Started in the task itself.
    delete task.workflowWaits;
    task.runsWorkflow = true;
    task.state = 'working';
    await bot.onWorkflowChanged(id, 'running');
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /Press Start on its card\./);
    assert.match(world.told[0].text, /\[About "Review the dialog fix"\].*Since then its workflow has been started, in the task itself: nothing is asked of the person about it\./);
    assert.equal(world.told[0].text.includes('NOT started'), false);
    assert.ok(store.get(id), 'what comes of the workflow is still waited for');
    // And what comes of it reaches the bot.
    delete task.runsWorkflow;
    task.state = 'idle';
    world.replies.set(id, { asked: null, reply: 'Codex approved.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /Codex approved\./);
    assert.equal(store.get(id), null);
  }

  // --- While the bot is being told of a wait, more happens: what is on its way stays, and nothing else is lost ---
  {
    // The task's turn ends in that moment: its reply still reaches the bot.
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Review the dialog fix', prompt: 'have Codex review it', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-now', kind: 'start', title: 'Codex review', detail: '' };
    world.replies.set(id, { asked: 'have Codex review it', reply: 'Prepared the review for you to start.' });
    world.whileTelling = async () => {
      world.whileTelling = null;
      world.main.busy = true;
      await bot.onTaskTurnEnded(id, 'completed');
    };
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /which has NOT started/);
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /Prepared the review for you to start\./, 'the reply was not let go of in place of what the bot took');
    assert.ok(store.get(id));
  }
  {
    // The person starts it in the task in that moment: the word is out, so what happened since follows it.
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Review the dialog fix', prompt: 'have Codex review it', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    assert.ok(task);
    task.runsWorkflow = true;
    world.replies.set(id, { asked: 'have Codex review it', reply: 'A workflow is planning the review.' });
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 1);
    delete task.runsWorkflow;
    task.state = 'needs approval';
    task.workflowWaits = { runId: 'run-now', kind: 'start', title: 'Codex review', detail: '' };
    world.whileTelling = async () => {
      world.whileTelling = null;
      world.main.busy = true;
      delete task.workflowWaits;
      task.runsWorkflow = true;
      task.state = 'working';
      await bot.onWorkflowChanged(id, 'running');
    };
    await bot.onWorkflowChanged(id, 'awaiting_confirmation');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /which has NOT started/);
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 3);
    assert.match(world.told[2].text, /Since then its workflow has been started, in the task itself: nothing is asked of the person about it\./);
    assert.equal(world.told[2].text.includes('NOT started'), false);
    assert.ok(store.get(id), 'what comes of the workflow is still waited for');
  }

  // --- Claude without an Anthropic login: ready when the task's model needs none ---
  {
    const listed: MainBotAgent[] = [
      { provider: 'claude', label: 'Claude', unavailable: NOT_SIGNED_IN },
      { provider: 'kimi', label: 'Kimi', unavailable: NOT_SIGNED_IN },
    ];
    assert.deepEqual(await claudeForModel(listed, async () => true), [{ provider: 'claude', label: 'Claude', unavailable: null }, listed[1]]);
    assert.equal(await claudeForModel(listed, async () => false), listed);
    assert.equal(await claudeForModel(listed, async () => { throw new Error('no probe'); }), listed);
    // Only the login is a question of the model: a Claude that is not installed stays that.
    const broken: MainBotAgent[] = [{ provider: 'claude', label: 'Claude', unavailable: 'not installed or not working' }];
    let asked = 0;
    assert.equal(await claudeForModel(broken, async () => (asked++, true)), broken);
    assert.equal(asked, 0);
    // The question about a Mac's agents carries the model the bot named for the task.
    const { bot, world } = setup();
    ok(await bot.startTask({ title: 'With a model', prompt: 'run', project: 'notes', model: ' glm-5 ' }));
    assert.equal(world.agentModels.at(-1), 'glm-5');
    ok(await bot.startTask({ title: 'Without one', prompt: 'run', project: 'notes' }));
    assert.equal(world.agentModels.at(-1), undefined);
  }

  // --- A report the bot has not taken yet survives writing to the task again ---
  {
    const { bot, store, world } = setup();
    const id = ok(await bot.startTask({ title: 'Fix it', prompt: 'Fix the bug', project: 'notes' })).sessionId as string;
    const task = world.tasks.find((entry) => entry.id === id);
    world.replies.set(id, { asked: 'Fix the bug', reply: 'first turn: fixed' });
    finish(task);
    world.main.busy = true;
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(store.get(id)?.report?.text, 'first turn: fixed');
    // Still in its own turn, the bot writes to the task again.
    ok(await bot.messageTask({ task: id, message: 'Also add a test' }));
    assert.equal(store.get(id)?.report, null, 'it waits for the new turn');
    assert.deepEqual(store.get(id)?.earlier.map((report) => report.text), ['first turn: fixed']);
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 1, 'the earlier reply goes without waiting for the new turn');
    assert.match(world.told[0].text, /Its reply to an earlier turn, written by the agent that ran it:\n\n```\nfirst turn: fixed/);
    assert.deepEqual(store.get(id)?.earlier, [], 'taken');
    assert.ok(store.get(id), 'and the task is still watched');
    world.replies.set(id, { asked: 'Also add a test', reply: 'second turn: test added' });
    finish(task);
    await bot.onTaskTurnEnded(id, 'completed');
    assert.equal(world.told.length, 2);
    assert.match(world.told[1].text, /second turn: test added/);
    assert.doesNotMatch(world.told[1].text, /first turn/);
    assert.equal(store.get(id), null);

    // Both waiting at once go together, in order.
    const other = ok(await bot.startTask({ title: 'Docs', prompt: 'Write docs', project: 'notes' })).sessionId as string;
    const second = world.tasks.find((entry) => entry.id === other);
    world.main.busy = true;
    world.replies.set(other, { asked: 'Write docs', reply: 'draft one' });
    finish(second);
    await bot.onTaskTurnEnded(other, 'completed');
    ok(await bot.messageTask({ task: other, message: 'Shorter' }));
    world.replies.set(other, { asked: 'Shorter', reply: 'draft two' });
    finish(second);
    await bot.onTaskTurnEnded(other, 'completed');
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 3);
    assert.ok(world.told[2].text.indexOf('draft one') < world.told[2].text.indexOf('draft two'));
    assert.deepEqual(mainBotReportTitles(world.told[2].label), ['Docs']);
    assert.equal(store.get(other), null);

    // Stopping a task keeps what it reported before.
    const third = ok(await bot.startTask({ title: 'Long', prompt: 'run', project: 'notes' })).sessionId as string;
    const long = world.tasks.find((entry) => entry.id === third);
    world.main.busy = true;
    world.replies.set(third, { asked: 'run', reply: 'half way' });
    finish(long);
    await bot.onTaskTurnEnded(third, 'completed');
    ok(await bot.messageTask({ task: third, message: 'Go on' }));
    ok(await bot.stopTask({ task: third }));
    assert.equal(store.get(third)?.report?.text, 'half way');
    finish(long);
    await bot.onTaskTurnEnded(third, 'stopped');
    world.main.busy = false;
    await bot.onMainTurnEnded();
    assert.equal(world.told.length, 4);
    assert.match(world.told[3].text, /half way/);
    assert.doesNotMatch(world.told[3].text, /Stopped before replying/);
    assert.equal(store.get(third), null);
  }

  // --- A task something else runs takes no message from the bot ---
  {
    const { bot, store, world } = setup();
    const closed = 'It was started by the task "Parent" and reports to that one. Write to that task instead, or tell the person to.';
    world.tasks.push({ id: LOCAL_ID(5), number: 5, title: 'Child', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', closedToMessages: closed, updatedAt: 1 });
    assert.equal(error(await bot.messageTask({ task: '#5', message: 'hi' })), closed);
    assert.equal(world.sends.length, 0);
    assert.equal(store.get(LOCAL_ID(5)), null, 'and the bot does not wait on it');
    assert.equal(ok(bot.listTasks({ include_idle: true })).tasks[0].closedToMessages, closed, 'the list says so');
    world.tasks[0].state = 'working';
    assert.match(ok(await bot.stopTask({ task: '#5' })).note, /^Stopped\./, 'the person can still have it stopped');
  }

  // --- On its own the bot writes only to tasks it has taken on ---
  {
    const { bot, world } = setup();
    world.tasks.push({ id: LOCAL_ID(8), number: 8, title: 'Mine', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', updatedAt: 1 });
    world.tasks.push({ id: LOCAL_ID(9), number: 9, title: 'Asked', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', updatedAt: 1 });
    const started = ok(await bot.startTask({ title: 'Started', prompt: 'go', project: 'notes' })).sessionId as string;
    // The person has the bot write to one of their own tasks.
    ok(await bot.messageTask({ task: '#9', message: 'The person says: ship it' }));
    // A report wakes the bot: no one typed this turn.
    world.main.turn = { startedAt: 2, typed: false };
    assert.match(error(await bot.messageTask({ task: '#8', message: 'hi' })), /did not ask for a message to "Mine"/);
    finish(world.tasks.find((task) => task.id === started));
    ok(await bot.messageTask({ task: started, message: 'One more step' }));
    finish(world.tasks.find((task) => task.id === LOCAL_ID(9)));
    ok(await bot.messageTask({ task: '#9', message: 'And tag it' }));
    ok(await bot.startTask({ title: 'Next', prompt: 'go on', project: 'notes' }));
    // The person asks: any task again.
    world.main.turn = { startedAt: 3, typed: true };
    ok(await bot.messageTask({ task: '#8', message: 'hi' }));
    // After a restart a task that is gone is no longer one it has taken on.
    world.tasks.splice(world.tasks.findIndex((task) => task.id === LOCAL_ID(8)), 1);
    await bot.recover();
    world.tasks.push({ id: LOCAL_ID(8), number: 8, title: 'Mine', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', updatedAt: 1 });
    world.main.turn = { startedAt: 4, typed: false };
    assert.match(error(await bot.messageTask({ task: '#8', message: 'hi' })), /did not ask/);
  }

  // --- After a restart: what ended meanwhile reports, what is gone is forgotten ---
  {
    const { bot, store, world } = setup();
    const a = ok(await bot.startTask({ title: 'Ended while closed', prompt: 'a', project: 'notes' })).sessionId as string;
    const b = ok(await bot.startTask({ title: 'Deleted', prompt: 'b', project: 'notes' })).sessionId as string;
    const c = ok(await bot.startTask({ title: 'Still going', prompt: 'c', project: 'notes' })).sessionId as string;
    world.replies.set(a, { asked: 'a', reply: 'finished a' });
    finish(world.tasks.find((task) => task.id === a));
    world.tasks.splice(world.tasks.findIndex((task) => task.id === b), 1);
    await bot.recover();
    assert.equal(world.told.length, 1);
    assert.match(world.told[0].text, /finished a/);
    assert.equal(store.get(b), null);
    assert.ok(store.get(c));
  }

  // --- The bot cannot keep itself busy for ever ---
  {
    const { bot, world } = setup();
    for (let index = 0; index < MAIN_BOT_LIMITS.startsPerTurn; index += 1) ok(await bot.startTask({ title: `T${index}`, prompt: 'x', project: 'notes' }));
    assert.match(error(await bot.startTask({ title: 'Too many', prompt: 'x', project: 'notes' })), /At most 8 tasks per turn/);
    // Turns that reports began may act too, but only so often before the user writes.
    for (let turn = 0; turn < MAIN_BOT_LIMITS.actionsWithoutUser; turn += 1) {
      world.main.turn = { startedAt: 100 + turn, typed: false };
      ok(await bot.startTask({ title: `Follow ${turn}`, prompt: 'x', project: 'notes' }));
    }
    world.main.turn = { startedAt: 500, typed: false };
    assert.match(error(await bot.startTask({ title: 'Loop', prompt: 'x', project: 'notes' })), /wait for them/);
    assert.match(error(await bot.messageTask({ task: 'T0', message: 'more' })), /wait for them/);
    world.main.turn = { startedAt: 600, typed: true };
    ok(await bot.startTask({ title: 'User asked', prompt: 'x', project: 'notes' }));
  }

  // --- What the bot reads ---
  {
    const { bot, world, tick } = setup();
    world.tasks.push(
      { id: LOCAL_ID(1), number: 1, title: 'Waiting', deviceId: null, device: 'MacBook', project: 'coworker', agent: 'Claude', state: 'needs approval', updatedAt: 1_000_000 },
      { id: LOCAL_ID(2), number: 2, title: 'Busy', deviceId: null, device: 'MacBook', project: 'coworker', agent: 'Codex', state: 'working', updatedAt: 1_000_000 },
      { id: LOCAL_ID(3), number: 3, title: 'Old', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', updatedAt: 1_000_000 - 30 * 86_400_000 },
      { id: 'rh-aaaaaaaaaaaa-x', title: 'Remote job', deviceId: 'mini', device: 'Mac mini', project: 'server', agent: 'Codex', state: 'asks', waitingOn: 'Which branch?', updatedAt: 1_000_000 },
    );
    tick(5 * 60_000);
    const listed = ok(bot.listTasks());
    assert.deepEqual(listed.tasks.map((task: { title: string }) => task.title), ['Waiting', 'Remote job', 'Busy'], 'waiting first; old idle ones left out');
    assert.equal(listed.tasks[0].id, '#1');
    assert.equal(listed.tasks[1].id, 'rh-aaaaaaaaaaaa-x');
    assert.equal(listed.tasks[2].lastActive, '5 min ago');
    assert.equal(ok(bot.listTasks({ include_idle: true })).tasks.length, 4);
    assert.deepEqual(ok(bot.listTasks({ device: 'Mac mini' })).tasks.map((task: { title: string }) => task.title), ['Remote job']);
    assert.deepEqual(ok(bot.listTasks({ query: 'old' })).tasks.map((task: { title: string }) => task.title), ['Old']);
    assert.match(error(bot.listTasks({ state: 'done' })), /"state" is one of/);
    world.replies.set(LOCAL_ID(2), { asked: 'Do the thing', reply: 'Working on it' });
    const detail = ok(await bot.getTask({ task: '#2' }));
    assert.equal(detail.lastRequest, 'Do the thing');
    assert.equal(detail.lastReply, 'Working on it');
    const projects = ok(await bot.listProjects());
    assert.deepEqual(projects.devices[0].agentsReady, ['Claude', 'Codex']);
    assert.equal(projects.devices[1].device, 'Mac mini');
    // Its job is the system prompt of every turn, not part of a message. The notes
    // go in full once per app run; how things stand goes every time.
    const first = bot.turnContext('main');
    assert.doesNotMatch(first, /You are Aegis/);
    assert.match(first, NOTES_IN_FULL);
    assert.match(first, /This Mac \(MacBook\): 1 working, 1 waiting for the person/);
    assert.match(first, /"Remote job" \(rh-aaaaaaaaaaaa-x, Codex, server, on Mac mini\): asks, Which branch\?/);
    const second = bot.turnContext('main');
    assert.doesNotMatch(second, NOTES_IN_FULL);
    assert.match(second, /"Busy" \(#2, Codex, coworker\), last active 5 min ago/);
    // A long conversation is shown its notes again now and then: its start may have been compacted away.
    const later = Array.from({ length: 19 }, () => bot.turnContext('main'));
    assert.ok(later.slice(0, 18).every((text) => !NOTES_IN_FULL.test(text)));
    assert.match(later[18], NOTES_IN_FULL);
  }

  // --- Its turns: its job as the system prompt, and none of the coding agent's tools that do the work ---
  {
    const options = mainBotTurnOptions();
    assert.equal(options.systemPrompt, MAIN_BOT_INSTRUCTIONS);
    assert.match(options.systemPrompt, /^You are Aegis/);
    assert.match(options.systemPrompt, /You have no subagents and no workflows of your own/);
    assert.match(options.systemPrompt, /that is start_task \(or message_task for a task that exists\), in this turn/);
    assert.deepEqual(options.allowedTools, [...MAIN_BOT_BUILTIN_TOOLS]);
    assert.deepEqual(options.allowedTools, ['read', 'ls', 'grep', 'web_search', 'web_fetch', 'question', 'exit_plan_mode']);
    // The words Bubble takes for a request to orchestrate (and answers with "use run_workflow") stay harmless: there is no such tool.
    for (const gone of ['spawn_agent', 'run_workflow', 'bash', 'write', 'edit', 'tool_search']) assert.ok(!options.allowedTools.includes(gone), gone);
  }

  // --- Notes: what outlasts the conversation ---
  {
    const { bot, memory, notesDir, tick } = setup();
    assert.match(error(bot.writeMemory({ name: 'Person', content: 'x', description: 'y' })), /lowercase letters, digits and hyphens/);
    assert.match(error(bot.writeMemory({ name: '../escape', content: 'x', description: 'y' })), /lowercase letters/);
    assert.match(error(bot.writeMemory({ name: 'person', content: 'Prefers Codex for reviews.' })), /"description" is required for a new note/);
    assert.match(error(bot.writeMemory({ name: 'person', description: 'How they work' })), /"content" is required.*mode "delete"/);
    const saved = ok(bot.writeMemory({ name: 'person', description: 'How the person wants\nwork handed out', content: 'Prefers Codex for reviews.' }));
    assert.equal(saved.description, 'How the person wants work handed out', 'one line');
    assert.equal(readFileSync(join(notesDir, 'person.md'), 'utf8'), '---\ndescription: How the person wants work handed out\n---\n\nPrefers Codex for reviews.\n');
    ok(bot.writeMemory({ name: 'person', content: 'Wants one sentence per report.', mode: 'append' }));
    const read = ok(bot.readMemory({ name: 'person' }));
    assert.equal(read.content, 'Prefers Codex for reviews.\n\nWants one sentence per report.');
    assert.equal(read.description, 'How the person wants work handed out', 'an existing note keeps its line');
    assert.match(error(bot.readMemory({ name: 'nothing' })), /no note "nothing"\. Your notes: person\./);
    assert.match(error(bot.writeMemory({ name: 'big', description: 'd', content: 'x'.repeat(MAIN_BOT_MEMORY_LIMITS.bytes + 1) })), /at most 8000 bytes/);
    // The job comes with the notes: small ones whole, so they are read before work is handed out.
    ok(bot.writeMemory({ name: 'project-coworker', description: 'The Aegis repository', content: 'Use Claude here. Never touch release.yml.' }));
    const first = bot.turnContext('main');
    assert.match(first, /Your notes \(read_memory shows one in full/);
    assert.ok(first.indexOf('- person: How the person wants work handed out') < first.indexOf('- project-coworker: The Aegis repository'), 'the person first');
    assert.match(first, /<note name="person">\nPrefers Codex for reviews\.\n\nWants one sentence per report\.\n<\/note>/);
    assert.match(first, /<note name="project-coworker">\nUse Claude here\./);
    // Afterwards they are not repeated: everything sent stays in the agent's thread.
    assert.doesNotMatch(bot.turnContext('main'), /Your notes/);
    // The bot's own change is no news to it.
    ok(bot.writeMemory({ name: 'person', content: 'Prefers Codex for reviews.' }));
    assert.doesNotMatch(bot.turnContext('main'), /Your notes/);
    // The person editing a file by hand is.
    tick(60_000);
    writeFileSync(join(notesDir, 'by-hand.md'), 'Deploys go out on Fridays only.\n\nMore.\n');
    const changed = bot.turnContext('main');
    assert.match(changed, /Your notes changed since you last saw them listed/);
    assert.match(changed, /- by-hand: Deploys go out on Fridays only\./, 'a note without a head is named by its first line');
    assert.doesNotMatch(changed, /<note name=/, 'the list only');
    assert.doesNotMatch(bot.turnContext('main'), /Your notes/);
    // Files that are no notes are passed over, and never written through.
    writeFileSync(join(notesDir, 'Bad Name.md'), 'x');
    writeFileSync(join(notesDir, 'huge.md'), 'x'.repeat(20_000));
    symlinkSync(join(notesDir, 'person.md'), join(notesDir, 'linked.md'));
    assert.deepEqual(memory.index().map((note) => note.name), ['by-hand', 'person', 'project-coworker']);
    assert.match(error(bot.writeMemory({ name: 'linked', description: 'd', content: 'through the link' })), /no note \(too large, or a link\)/);
    assert.equal(ok(bot.readMemory({ name: 'person' })).content, 'Prefers Codex for reviews.');
    // Removing puts a note away where the person can take it back.
    assert.equal(ok(bot.writeMemory({ name: 'by-hand', mode: 'delete' })).removed, 'by-hand');
    assert.equal(existsSync(join(notesDir, 'by-hand.md')), false);
    assert.equal(readdirSync(join(notesDir, '.trash')).length, 1);
    assert.match(error(bot.writeMemory({ name: 'by-hand', mode: 'delete' })), /no note "by-hand" to remove/);
    // Large notes are listed, not sent whole.
    ok(bot.writeMemory({ name: 'project-notes', description: 'Long', content: 'y'.repeat(5_000) }));
    const { bot: again } = (() => {
      const next = setup();
      return { bot: new MainBotService(next.store, next.host, memory) };
    })();
    const restarted = again.turnContext('main');
    assert.match(restarted, /- project-notes: Long \(changed [^)]*\)\n/);
    assert.doesNotMatch(restarted, /<note name="project-notes">/);
    assert.match(restarted, /<note name="person">/);
    // No more than there is room for.
    for (let index = 0; memory.index().length < MAIN_BOT_MEMORY_LIMITS.notes; index += 1) ok(bot.writeMemory({ name: `n-${index}`, description: 'd', content: 'c' }));
    assert.match(error(bot.writeMemory({ name: 'one-too-many', description: 'd', content: 'c' })), /40 notes, the most there can be/);
  }

  // --- The record of what was handed out ---
  {
    const { bot, store, world, tick } = setup();
    const a = ok(await bot.startTask({ title: 'Profile the export', prompt: 'Find the slow part', project: 'notes', goal: '  Faster\n export ' }));
    assert.equal(a.goal, 'Faster export', 'one line');
    const b = ok(await bot.startTask({ title: 'Cache the totals', prompt: 'Add a cache', project: 'server', goal: 'faster export' }));
    const c = ok(await bot.startTask({ title: 'Fix the typo', prompt: 'Fix it', project: 'notes' }));
    assert.equal(c.goal, 'Fix the typo', 'a task given no goal stands for itself');
    // One of the person's own tasks the bot was asked to write to.
    world.tasks.push({ id: LOCAL_ID(70), number: 70, title: 'Their own', deviceId: null, device: 'MacBook', project: 'coworker', agent: 'Codex', state: 'idle', updatedAt: 1 });
    world.sendFails = true;
    error(await bot.messageTask({ task: '#70', message: 'Ship it' }));
    assert.equal(store.dispatch(LOCAL_ID(70)), null, 'a message that did not go out takes nothing on');
    world.sendFails = false;
    ok(await bot.messageTask({ task: '#70', message: 'Ship it' }));
    assert.equal(store.dispatch(LOCAL_ID(70))?.origin, 'adopted');
    // Writing to its own task again keeps what it was started for.
    tick(1_000);
    world.tasks.find((task) => task.id === a.sessionId)!.title = 'Profile the export (renamed)';
    finish(world.tasks.find((task) => task.id === a.sessionId));
    ok(await bot.messageTask({ task: a.sessionId, message: 'Also the import' }));
    const kept = store.dispatch(a.sessionId)!;
    assert.deepEqual([kept.goal, kept.origin, kept.createdAt, kept.title], ['Faster export', 'started', 1_000_000, 'Profile the export (renamed)']);

    // A report is kept with the record, and marked once the bot took it.
    world.main.busy = true;
    world.replies.set(a.sessionId, { asked: 'x', reply: `The slow part is the totals. ${'detail '.repeat(300)}Done.` });
    finish(world.tasks.find((task) => task.id === a.sessionId));
    await bot.onTaskTurnEnded(a.sessionId, 'completed');
    const waiting = store.dispatch(a.sessionId)!.report!;
    assert.equal(waiting.readAt, null);
    assert.ok(waiting.gist.length <= MAIN_BOT_LIMITS.gist + 3 && waiting.gist.startsWith('The slow part') && waiting.gist.endsWith('Done.'), 'a long reply keeps its start and its end');
    const before = ok(bot.listHandedOut());
    assert.deepEqual(before.goals.map((group: { goal: string; tasks: unknown[] }) => [group.goal, group.tasks.length]), [['Faster export', 2], ['Their own', 1], ['Fix the typo', 1]], 'by goal, whatever its case; latest first');
    const profile = before.goals[0].tasks[0];
    assert.equal(profile.title, 'Profile the export (renamed)');
    assert.equal(profile.state, 'idle', 'read from Aegis now');
    assert.match(profile.lastReport.note, /Not yet delivered/);
    assert.equal(profile.lastReport.said.length, MAIN_BOT_LIMITS.gistListed + 1, 'cut short in a list of everything');
    assert.equal(before.goals[1].tasks[0].yours, false);
    assert.equal(before.goals[0].tasks[1].state, 'working');
    assert.equal(before.goals[0].tasks[1].id, b.sessionId);
    world.main.busy = false;
    tick(120_000);
    await bot.onMainTurnEnded();
    assert.match(world.told[0].text, /\[Report from "Profile the export \(renamed\)"\] \(aegis:\/\/sessions\/[^)]+\) Part of "Faster export"\. Its reply/);
    assert.equal(store.get(a.sessionId), null, 'the queue lets go of it');
    assert.equal(store.dispatch(a.sessionId)!.report!.readAt, 1_121_000, 'the record keeps it, as taken');
    const one = ok(bot.listHandedOut({ goal: 'EXPORT' }));
    assert.equal(one.goals.length, 1);
    assert.equal(one.goals[0].tasks[0].lastReport.note, undefined);
    assert.ok(one.goals[0].tasks[0].lastReport.said.length > 900, 'more of it for one goal');
    assert.equal(one.goals[0].tasks[0].lastReport.when, '2 min ago');
    // A report that comes in while one is being taken is not marked with it.
    store.setDispatchReport(a.sessionId, { status: 'completed', gist: 'newer', at: 1_500_000 });
    store.markReportRead(a.sessionId, 1_001_000, 1_600_000);
    assert.equal(store.dispatch(a.sessionId)!.report!.readAt, null);

    // What is still open: going, waiting, or not yet reported to the bot.
    assert.deepEqual(
      ok(bot.listHandedOut({ open_only: true })).goals.flatMap((group: { tasks: Array<{ title: string }> }) => group.tasks.map((task) => task.title)).sort(),
      ['Cache the totals', 'Fix the typo', 'Profile the export (renamed)', 'Their own'],
    );
    store.markReportRead(a.sessionId, 1_500_000, 1_600_000);
    finish(world.tasks.find((task) => task.id === LOCAL_ID(70)));
    await bot.onTaskTurnEnded(LOCAL_ID(70), 'completed');
    assert.deepEqual(
      ok(bot.listHandedOut({ open_only: true })).goals.flatMap((group: { tasks: Array<{ title: string }> }) => group.tasks.map((task) => task.title)).sort(),
      ['Cache the totals', 'Fix the typo'],
    );

    // Archived is not deleted; a Mac out of reach says nothing about its task.
    world.archived.add(c.sessionId);
    world.tasks = world.tasks.filter((task) => task.id !== c.sessionId && task.id !== b.sessionId && task.id !== LOCAL_ID(70));
    const later = ok(bot.listHandedOut());
    const stateOf = (title: string) => later.goals.flatMap((group: { tasks: Array<{ title: string; state: string }> }) => group.tasks).find((task: { title: string }) => task.title === title)?.state;
    assert.equal(stateOf('Fix the typo'), 'archived');
    assert.equal(stateOf('Cache the totals'), 'unreachable');
    assert.equal(stateOf('Their own'), 'deleted');
    assert.equal(store.hasTaken(LOCAL_ID(70)), false, 'a deleted task is no longer one it has taken on');
    assert.equal(store.hasTaken(c.sessionId), true);
    await bot.recover();
    assert.equal(store.dispatch(c.sessionId)!.goneAt, null, 'recovering leaves an archived task alone');
    assert.ok(store.dispatch(LOCAL_ID(70)), 'and the record of a deleted one stays');
  }

  // --- The record takes over what earlier builds kept ---
  {
    const { bot, store, world } = setup((db) => {
      db.exec('CREATE TABLE main_bot_tasks (task_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO main_bot_tasks (task_id, taken_at) VALUES (?, ?)').run(LOCAL_ID(31), 500);
    });
    assert.equal(store.hasTaken(LOCAL_ID(31)), true);
    assert.deepEqual([store.dispatch(LOCAL_ID(31))!.origin, store.dispatch(LOCAL_ID(31))!.createdAt], ['adopted', 500]);
    world.tasks.push({ id: LOCAL_ID(31), number: 31, title: 'From before', deviceId: null, device: 'MacBook', project: 'notes', agent: 'Claude', state: 'idle', updatedAt: 1 });
    assert.equal(ok(bot.listHandedOut()).goals[0].goal, 'From before', 'named by the task as it is now');
    world.main.turn = { startedAt: 2, typed: false };
    ok(await bot.messageTask({ task: '#31', message: 'Go on' }));
    assert.equal(store.dispatch(LOCAL_ID(31))!.goal, 'From before');
  }

  // --- What stands with each message ---
  {
    const { bot, world } = setup();
    ok(await bot.startTask({ title: 'Profile the export', prompt: 'x', project: 'notes', goal: 'Faster export' }));
    for (let index = 0; index < 10; index += 1) {
      world.tasks.push({ id: LOCAL_ID(200 + index), number: 200 + index, title: `Theirs ${index}`, deviceId: null, device: 'MacBook', project: 'coworker', agent: 'Claude', state: 'working', updatedAt: 1_000_000 });
    }
    const text = bot.turnContext('main');
    assert.match(text, /Handed out by you, still working:\n- "Profile the export" \(#101, claude, notes\), for "Faster export", last active just now/);
    assert.match(text, /Also working, not handed out by you:\n- "Theirs 0" \(#200, Claude, coworker\), last active just now/);
    assert.match(text, /- "Theirs 7"[^\n]*\n- and 2 more \(list_tasks shows all\)/, 'titles of the first few, the rest counted');
    assert.doesNotMatch(text, /Theirs 8/);
  }

  // --- A fresh context: the agent starts on an empty thread and is told what went before ---
  {
    const { bot, store, world, tick } = setup();
    const id = ok(await bot.startTask({ title: 'Profile the export', prompt: 'x', project: 'notes', goal: 'Faster export' })).sessionId as string;
    world.replies.set(id, { asked: 'x', reply: 'The slow part is the totals.' });
    finish(world.tasks.find((task) => task.id === id));
    await bot.onTaskTurnEnded(id, 'completed');
    ok(bot.writeMemory({ name: 'person', description: 'How they work', content: 'Short answers.' }));
    bot.turnContext('main');
    assert.doesNotMatch(bot.turnContext('main'), NOTES_IN_FULL);
    world.conversation = [
      { asked: 'Make the export faster', reply: 'I gave the profiling to Claude in notes.' },
      { asked: null, reply: 'The slow part is the totals. Shall I have them cached?' },
    ];
    // Asked while a turn runs: it waits for the next turn, and survives a restart.
    world.threadFree = false;
    assert.equal(bot.freshContext(), 'pending');
    assert.deepEqual(world.freshThreads, []);
    const restarted = new MainBotService(store, { ...bot['host'] } as MainBotHost, bot['notes']);
    restarted.beforeMainTurn();
    assert.deepEqual(world.freshThreads, [true], 'done as the next turn is sent');
    restarted.beforeMainTurn();
    assert.deepEqual(world.freshThreads, [true], 'once');
    tick(60_000);
    const brief = restarted.turnContext('main');
    assert.doesNotMatch(brief, /You are Aegis/, 'its job is the system prompt');
    assert.match(brief, /Your context starts afresh here/);
    assert.match(brief, /The end of the conversation, oldest first:\n- \[#1\] The person wrote: "Make the export faster" You answered: "I gave the profiling to Claude in notes\."/);
    assert.match(brief, /- \[#3\] The report of "Profile the export" came in\. You answered: "The slow part is the totals\. Shall I have them cached\?"/);
    // It is told that none of it is to be done again, and where the words themselves can be found.
    assert.match(brief, /every request in it was answered or handed out already, so start nothing from it again\. Take new requests only from what comes after this\./);
    assert.match(brief, /read_conversation searches all that was said here/);
    assert.match(MAIN_BOT_INSTRUCTIONS, /- read_conversation searches what was said in this conversation/, 'its job says so too');
    assert.match(brief, /- "Profile the export", for "Faster export" finished a turn 1 min ago: "The slow part is the totals\."/, 'reports are not in the conversation: they come from the record');
    assert.match(brief, /<note name="person">\nShort answers\.\n<\/note>/);
    // A turn that fails may have told the agent nothing: the next one gets it all again.
    await restarted.onMainTurnEnded('error');
    assert.match(restarted.turnContext('main'), /Your context starts afresh here/);
    await restarted.onMainTurnEnded('completed');
    const after = restarted.turnContext('main');
    assert.doesNotMatch(after, /Your context starts afresh here/);
    assert.doesNotMatch(after, NOTES_IN_FULL);
    // With nothing running it happens at once.
    world.threadFree = true;
    assert.equal(restarted.freshContext(), 'done');
    assert.deepEqual(world.freshThreads, [true, false]);
    assert.match(restarted.turnContext('main'), /Your context starts afresh here/);
    // An ordinary turn that fails is shown its notes again, without the rest.
    const plain = setup();
    plain.bot.turnContext('main');
    await plain.bot.onMainTurnEnded('error');
    const retold = plain.bot.turnContext('main');
    assert.match(retold, NOTES_IN_FULL);
    assert.doesNotMatch(retold, /Your context starts afresh here/);
  }

  // --- A context that fills up starts afresh by itself, between turns ---
  {
    // The limit stays clear of where Bubble compacts a thread itself, on any window.
    assert.deepEqual(
      [32_000, 64_000, 128_000, 200_000, 1_000_000, 0].map(mainBotContextLimit),
      [19_200, 24_800, 76_000, 100_000, 100_000, 25_600],
    );
    const { bot, store, world } = setup();
    const turn = async (used: number, window: number, status: 'completed' | 'error' | 'stopped' = 'completed', on = bot) => {
      on.turnContext('main');
      on.noteContextUsage(used, window);
      await on.onMainTurnEnded(status);
    };
    // Below both limits: nothing.
    await turn(90_000, 200_000);
    assert.deepEqual(world.freshThreads, []);
    // A turn the person stopped decides nothing.
    await turn(150_000, 200_000, 'stopped');
    assert.deepEqual(world.freshThreads, []);
    // Past the cap of a large window, well before the model's own limit.
    await turn(100_000, 1_000_000);
    assert.deepEqual([world.freshThreads, world.automatic], [[false], [true]]);
    assert.match(bot.turnContext('main'), /Your context starts afresh here/);
    bot.noteContextUsage(12_000, 200_000);
    await bot.onMainTurnEnded('completed');
    // What it said before it started over no longer counts, and it answers a few turns before it may start over again.
    for (let index = 0; index < MAIN_BOT_LIMITS.turnsBetweenFresh - 2; index += 1) await turn(150_000, 200_000);
    assert.equal(world.freshThreads.length, 1, 'not again right away');
    // Nor after a restart of the app in between.
    const restarted = new MainBotService(store, { ...bot['host'] } as MainBotHost, bot['notes']);
    await turn(150_000, 200_000, 'completed', restarted);
    assert.equal(world.freshThreads.length, 2);
    // A thread that is that full from its first turn gains nothing by starting over: only once it has grown.
    for (let index = 0; index < MAIN_BOT_LIMITS.turnsBetweenFresh + 2; index += 1) await turn(150_000, 200_000, 'completed', restarted);
    assert.equal(world.freshThreads.length, 2, 'a context that will not shrink does not keep it starting over');
    await turn(176_000, 200_000, 'completed', restarted);
    assert.equal(world.freshThreads.length, 3);
    // A small window: below where Bubble would compact it, not its share.
    const small = setup();
    await turn(24_000, 64_000, 'completed', small.bot);
    assert.deepEqual(small.world.automatic, []);
    await turn(25_000, 64_000, 'completed', small.bot);
    assert.deepEqual(small.world.automatic, [true]);
    // A window that leaves an empty thread no room is left to Bubble.
    const tiny = setup();
    await turn(30_000, 44_000, 'completed', tiny.bot);
    assert.deepEqual(tiny.world.freshThreads, []);
    // A window nobody knows: Bubble compacts at 32k then.
    const unknown = setup();
    await turn(25_599, 0, 'completed', unknown.bot);
    assert.deepEqual(unknown.world.freshThreads, []);
    await turn(25_600, 0, 'completed', unknown.bot);
    assert.deepEqual(unknown.world.automatic, [true]);
    // A turn that failed may have failed for being too full.
    const failed = setup();
    await turn(150_000, 200_000, 'error', failed.bot);
    assert.deepEqual(failed.world.automatic, [true]);
    // A message being sent at that moment: it starts over with the next turn, and says it was not asked for.
    const busy = setup();
    busy.world.threadFree = false;
    await turn(150_000, 200_000, 'completed', busy.bot);
    assert.deepEqual(busy.world.freshThreads, []);
    assert.equal(busy.store.meta('refresh_pending'), 'auto');
    busy.bot.beforeMainTurn();
    assert.deepEqual([busy.world.freshThreads, busy.world.automatic], [[true], [true]]);
    assert.equal(busy.store.meta('refresh_pending'), null);
    // Unless that message's turn ended with room again (Bubble compacted): then it is no longer due.
    const eased = setup();
    eased.world.threadFree = false;
    await turn(150_000, 200_000, 'completed', eased.bot);
    assert.equal(eased.store.meta('refresh_pending'), 'auto');
    await turn(20_000, 200_000, 'completed', eased.bot);
    assert.equal(eased.store.meta('refresh_pending'), null);
    eased.bot.beforeMainTurn();
    assert.deepEqual(eased.world.freshThreads, []);
    // What the person asked for stays theirs: when it waits for the next turn, and when the turn ends full.
    const asked = setup();
    asked.world.threadFree = false;
    assert.equal(asked.bot.freshContext(), 'pending');
    await turn(150_000, 200_000, 'completed', asked.bot);
    assert.equal(asked.store.meta('refresh_pending'), '1');
    asked.bot.beforeMainTurn();
    assert.deepEqual(asked.world.automatic, [false]);
    const askedFull = setup();
    askedFull.world.threadFree = false;
    assert.equal(askedFull.bot.freshContext(), 'pending');
    askedFull.world.threadFree = true;
    await turn(150_000, 200_000, 'completed', askedFull.bot);
    assert.deepEqual([askedFull.world.freshThreads, askedFull.world.automatic], [[false], [false]]);
    // The app failing to reset the thread stops nothing else: reports still go out, and the agent is told its job again.
    const broken = setup();
    broken.world.threadBroken = true;
    const waiting = ok(await broken.bot.startTask({ title: 'Count the words', prompt: 'x', project: 'notes', goal: 'Word count' })).sessionId as string;
    broken.world.main = { ...broken.world.main!, busy: true };
    broken.world.replies.set(waiting, { asked: 'x', reply: '412 words.' });
    finish(broken.world.tasks.find((task) => task.id === waiting));
    await broken.bot.onTaskTurnEnded(waiting, 'completed');
    assert.equal(broken.world.told.length, 0);
    broken.world.main = { ...broken.world.main!, busy: false };
    await turn(150_000, 200_000, 'completed', broken.bot);
    assert.equal(broken.world.told.length, 1, 'the report that waited is delivered');
    assert.match(broken.bot.turnContext('main'), /Your context starts afresh here/);
    assert.equal(broken.bot.freshContext(), 'pending');
    // What an agent on an empty thread is told of the conversation has an end: the latest turns, whole enough to go on from.
    const recapOf = (told: string) => told.slice(told.indexOf('Your context starts afresh here'), told.indexOf('list_handed_out shows everything'));
    const turns = Array.from({ length: 8 }, (_, index) => ({ asked: `Question ${index} ${'q'.repeat(700)}`, reply: `Answer ${index} ${'a'.repeat(6_000)} Closing ${index}?` }));
    const long = setup();
    long.world.conversation = turns;
    long.bot.noteContextUsage(50_000, 200_000);
    assert.equal(long.bot.freshContext(), 'done');
    const recap = recapOf(long.bot.turnContext('main'));
    assert.ok(recap.length <= MAIN_BOT_LIMITS.recap * (1 + MAIN_BOT_LIMITS.recapEarlierShare) + 1_000, `the recap stays within its room: ${recap.length}`);
    assert.match(recap, /\[#15\] The person wrote: "Question 7 q+" You answered: "Answer 7 a+ … a+ Closing 7\?"/, 'a long answer keeps its end: what it asked the person');
    assert.match(recap, /Answer 6 a+ … a+ Closing 6\?"/);
    assert.ok(recap.indexOf('Question 6') < recap.indexOf('Question 7'), 'oldest first');
    // Of the turns there is no room for, the person's own words still go along, cut short, with where to find the rest.
    assert.doesNotMatch(recap, /Answer 0/, 'the oldest answers give way');
    assert.match(recap, /What the person wrote earlier, oldest first[^\n]*\n- \[#1, just now\] "Question 0 q+ … q+"\n- \[#3, just now\] "Question 1 q+ … q+"/);
    assert.ok(recap.indexOf('What the person wrote earlier') < recap.indexOf('The end of the conversation'));
    // A small or unknown window is soon full again: it carries less.
    const narrow = setup();
    narrow.world.conversation = turns;
    assert.equal(narrow.bot.freshContext(), 'done');
    const less = recapOf(narrow.bot.turnContext('main'));
    assert.ok(less.length <= MAIN_BOT_LIMITS.recapMin * (1 + MAIN_BOT_LIMITS.recapEarlierShare) + 1_000 && less.length < recap.length / 2, `less for a small window: ${less.length}`);
    assert.match(less, /Answer 7 a+ … a+ Closing 7\?"/, 'the latest answer first of all');
    // The answer the person may be replying to gets the most room: all of it, most of the time.
    const pending = setup();
    const question = `${'I looked at both branches. '.repeat(70)}Shall I merge branch A or branch B?`;
    pending.world.conversation = [{ asked: 'Which branch is ready?', reply: question }];
    assert.equal(pending.bot.freshContext(), 'done');
    assert.ok(pending.bot.turnContext('main').includes(`You answered: "${question}"`));
  }

  // --- What was said stays findable after the context started afresh ---
  {
    const { bot, world, tick } = setup();
    const day = 24 * 60 * 60_000;
    const chat: MainBotChatLine[] = [];
    const say = (who: MainBotChatLine['who'], text: string) => chat.push({ seq: chat.length + 1, at: bot['host'].now(), who, text });
    say('person', 'From now on every task in follow-up-test-repo goes to Codex, never to Claude.');
    say('you', 'Noted: follow-up-test-repo goes to Codex.');
    tick(2 * day);
    say('person', '给 ~/follow-up-test-repo 加一个 welcome 脚本');
    say('you', `已将 添加 welcome 脚本 交给 Codex。${' 它会创建并实测运行。'.repeat(80)}`);
    say('report', 'Task report: 添加 welcome 脚本');
    say('you', '添加 welcome 脚本 回报完成：新增了 welcome.js。');
    say('fresh', '');
    say('person', 'hello');
    say('you', 'Hello! Nothing is running right now.');
    world.chat = chat;
    const read = (args: { query?: string; around?: number | string }) => ok(bot.readConversation(args)) as { lines: Array<{ ref: string; when: string; who: string; text?: string }>; note?: string };
    // Words from long ago, in either language; the line with more of them first, then the later one.
    let found = read({ query: 'codex follow-up-test-repo' });
    assert.deepEqual(found.lines.map((line) => line.ref), ['#2', '#1', '#4', '#3']);
    assert.deepEqual(found.lines.slice(0, 2).map((line) => [line.ref, line.who]), [['#2', 'you'], ['#1', 'the person']], 'both words, the later line first');
    assert.equal(found.lines[1].when, '2 d ago');
    assert.match(found.note ?? '', /around: a ref shows that place in full/);
    found = read({ query: '脚本' });
    assert.deepEqual(found.lines.map((line) => line.ref), ['#6', '#5', '#4', '#3']);
    assert.equal(found.lines[2].who, 'you');
    assert.ok((found.lines[2].text ?? '').length <= MAIN_BOT_LIMITS.chatHit + 4 && (found.lines[2].text ?? '').includes('welcome 脚本'), 'a long line shows the part around the word');
    assert.equal(found.lines[1].who, 'a task report came in');
    // One place in full, with what was said either side, and where the context started afresh.
    const place = read({ around: '#4' });
    assert.deepEqual(place.lines.map((line) => line.ref), ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8']);
    assert.ok((place.lines[3].text ?? '').length > 800, 'the whole line');
    assert.deepEqual([place.lines[6].who, place.lines[6].text], ['your context started afresh here', undefined]);
    assert.deepEqual(read({ around: 9 }).lines.map((line) => line.ref), ['#5', '#6', '#7', '#8', '#9']);
    assert.match(String((bot.readConversation({ around: '#40' }) as { error?: string }).error), /There is no #40 in this conversation\. It has #1 to #9\./);
    // Without words: the latest lines. Words nobody used: said so, with where else to look.
    assert.deepEqual(read({}).lines.map((line) => line.ref).slice(-2), ['#8', '#9']);
    const none = read({ query: 'invoice' });
    assert.deepEqual(none.lines, []);
    assert.match(none.note ?? '', /Nothing in this conversation holds "invoice"/);
    // It counts as looking, like the other lookups: the chat draws no trace row for it.
    assert.equal(isMainBotLookupToolName('read_conversation'), true);
  }

  assert.deepEqual(parseMainBotTaskResult('{"sessionId":"s","title":"T","agent":"Claude"}'), { sessionId: 's', title: 'T', agent: 'Claude', device: undefined, project: undefined, note: undefined });
  assert.deepEqual(parseMainBotTaskResult('not json'), {});
  console.log('main-bot: ok');
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});

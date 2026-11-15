// The main bot's rules: where a task goes and to which agent, what a working
// task does with a message, and how replies get back to the bot. Against an
// in-memory SQLite database and a fake host.
// Run: npx tsx scripts/tests/main-bot.test.ts
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MAIN_BOT_LIMITS, mainBotReportTitles, parseMainBotTaskResult } from '../../src/shared/main-bot';
import {
  MainBotService,
  taskBrief,
  type MainBotAgent,
  type MainBotDevice,
  type MainBotHost,
  type MainBotStart,
  type MainBotTask,
  type ToolOutcome,
} from '../../src/electron/libs/main-bot/service';
import { MainBotStore, type MainBotDb } from '../../src/electron/libs/main-bot/store';

const LOCAL_ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup() {
  let clock = 1_000_000;
  const db = new DatabaseSync(':memory:') as unknown as MainBotDb;
  const store = new MainBotStore(db);
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
    preferred: 'claude',
    gitRepos: new Set(['/code/coworker']),
    starts: [] as MainBotStart[],
    sends: [] as Array<{ taskId: string; prompt: string }>,
    stops: [] as string[],
    told: [] as Array<{ label: string; text: string }>,
    replies: new Map<string, { asked: string | null; reply: string }>(),
    main: { id: 'main', busy: false, turn: { startedAt: 1, typed: true } as { startedAt: number; typed: boolean } | null },
    sendFails: false,
    tellFails: false,
    nextLocal: 1,
  };
  const host: MainBotHost = {
    now: () => clock,
    devices: () => world.devices,
    tasks: () => world.tasks,
    agents: async (deviceId) => (deviceId === null ? world.agents.local : world.agents.mini),
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
    lastTurn: async (taskId) => world.replies.get(taskId) ?? null,
    main: () => world.main,
    tellMain: async (label, text) => {
      if (world.tellFails) return false;
      world.told.push({ label, text });
      return true;
    },
  };
  const bot = new MainBotService(store, host);
  return { bot, store, world, tick: (ms: number) => { clock += ms; } };
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
    // The instructions go once per app run; how things stand goes every time.
    const first = bot.turnContext('main');
    assert.match(first, /You are Aegis/);
    assert.match(first, /This Mac \(MacBook\): 1 working, 1 waiting for the person/);
    assert.match(first, /"Remote job" \(rh-aaaaaaaaaaaa-x, Codex, server, on Mac mini\): asks, Which branch\?/);
    const second = bot.turnContext('main');
    assert.doesNotMatch(second, /You are Aegis/);
    assert.match(second, /"Busy" \(#2, Codex, coworker\), last active 5 min ago/);
    // A long conversation is told its job again now and then: its start may have been compacted away.
    const later = Array.from({ length: 19 }, () => bot.turnContext('main'));
    assert.ok(later.slice(0, 18).every((text) => !/You are Aegis/.test(text)));
    assert.match(later[18], /You are Aegis/);
  }

  assert.deepEqual(parseMainBotTaskResult('{"sessionId":"s","title":"T","agent":"Claude"}'), { sessionId: 's', title: 'T', agent: 'Claude', device: undefined, project: undefined, note: undefined });
  assert.deepEqual(parseMainBotTaskResult('not json'), {});
  console.log('main-bot: ok');
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});

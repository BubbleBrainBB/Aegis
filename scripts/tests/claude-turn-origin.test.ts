import assert from 'node:assert/strict';
import { ClaudeTurnOriginTracker } from '../../src/electron/libs/claude-turn-origin';

// Frame sequences recorded from the real CLI (claude-sdk-native canary).
const lifecycle = (state: string, uuid: string) => ({ type: 'command_lifecycle', state, command_uuid: uuid });
const init = { type: 'system', subtype: 'init' };
const result = { type: 'result', subtype: 'success' };
const notification = { type: 'system', subtype: 'task_notification' };
const tasksEmpty = { type: 'system', subtype: 'background_tasks_changed' };
const text = { type: 'assistant' };

function opens(frames: object[]): boolean[] {
  const tracker = new ClaudeTurnOriginTracker();
  return frames.map((frame) => tracker.observe(frame));
}
const selfStartedAt = (frames: object[]) =>
  opens(frames).flatMap((selfStarted, i) => (selfStarted ? [i] : []));

// A prompted turn is not self-started.
assert.deepEqual(
  selfStartedAt([lifecycle('queued', 'a'), lifecycle('started', 'a'), init, text, result, lifecycle('completed', 'a')]),
  [],
  'a prompted turn opens with its command started'
);

// A finished background task wakes the agent: an init no command started.
{
  const frames = [
    lifecycle('queued', 'a'), lifecycle('started', 'a'), init, result, lifecycle('completed', 'a'),
    notification, tasksEmpty, init, text, result,
  ];
  assert.deepEqual(selfStartedAt(frames), [7], 'the woken turn is self-started');
}

// A prompt sent while the woken turn starts: queued only, it runs next.
{
  const frames = [
    lifecycle('started', 'a'), init, result, lifecycle('completed', 'a'),
    notification, tasksEmpty, lifecycle('queued', 'b'), init, result,
    lifecycle('started', 'b'), init, result, lifecycle('completed', 'b'),
  ];
  assert.deepEqual(selfStartedAt(frames), [7], 'only the woken turn is self-started; the queued prompt runs its own');
}

// A prompt folded into a running turn starts mid-turn and never marks the next.
{
  const frames = [
    lifecycle('started', 'a'), init, lifecycle('queued', 'b'), lifecycle('started', 'b'),
    lifecycle('completed', 'b'), result, lifecycle('completed', 'a'),
    notification, init, result,
  ];
  assert.deepEqual(selfStartedAt(frames), [8], 'a folded start belongs to the running turn');
}

// A local command settles without an init; the next woken turn is still self-started.
assert.deepEqual(
  selfStartedAt([lifecycle('started', 'a'), init, result, lifecycle('completed', 'a'),
    lifecycle('started', 'local'), result, lifecycle('completed', 'local'), init, result]),
  [7],
  'a command that settles without a turn does not claim the next one'
);

// A started command cancelled before its turn does not claim the next one.
assert.deepEqual(
  selfStartedAt([lifecycle('started', 'a'), init, result, lifecycle('started', 'b'), lifecycle('cancelled', 'b'), init, result]),
  [5],
  'a cancelled command does not claim the next turn'
);

// Hidden /goal control sends are commands too.
assert.deepEqual(
  selfStartedAt([lifecycle('started', 'goal-clear'), init, result, lifecycle('completed', 'goal-clear')]),
  [],
  'a control send is not self-started'
);

// Subagent frames and a re-sent init mid-turn do not open turns.
assert.deepEqual(
  selfStartedAt([lifecycle('started', 'a'), init, { ...init, parent_tool_use_id: 'toolu_1' }, init, result]),
  [],
  'only a main-thread init outside a turn opens one'
);

// Without lifecycle frames (older CLIs) no turn is called self-started.
assert.deepEqual(selfStartedAt([init, result, notification, init, result]), [], 'no lifecycle, no guess');

console.log('claude-turn-origin.test.ts passed');

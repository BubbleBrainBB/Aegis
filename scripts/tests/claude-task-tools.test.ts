import assert from 'node:assert/strict';
import { replayClaudeTaskCalls, toolResultText } from '../../src/shared/claude-task-tools';
import { extractLatestTodoProgress } from '../../src/ui/utils/todo-progress';

const create = (id: string, subject: string, activeForm?: string) => ({ id, name: 'TaskCreate', input: { subject, description: subject, activeForm } });
const update = (id: string, taskId: string, input: Record<string, unknown>) => ({ id, name: 'TaskUpdate', input: { taskId, ...input } });
const results = new Map<string, { content: unknown }>([
  ['c1', { content: 'Task #1 created successfully: Read the code' }],
  ['c2', { content: [{ type: 'text', text: 'Task #2 created successfully: Fix the bug' }] }],
  ['c3', { content: 'Task #3 created successfully: Write tests' }],
]);
const textFor = (id: string) => (results.has(id) ? toolResultText(results.get(id)!.content) : undefined);

// Creates take their ids from the results; updates change status, subject and activeForm.
{
  const replayed = replayClaudeTaskCalls(
    [
      create('c1', 'Read the code'),
      create('c2', 'Fix the bug', 'Fixing the bug'),
      create('c3', 'Write tests'),
      update('u1', '1', { status: 'completed' }),
      update('u2', '2', { status: 'in_progress', subject: 'Fix the parser bug' }),
      update('u3', '3', { status: 'deleted' }),
    ],
    textFor
  );
  assert.deepEqual(replayed?.tasks.map(({ id, content, status }) => [id, content, status]), [
    ['1', 'Read the code', 'completed'],
    ['2', 'Fix the parser bug', 'in_progress'],
  ]);
  assert.equal(replayed?.tasks[1].activeForm, 'Fixing the bug');
  assert.equal(replayed?.writes, 6);
}

// A create still waiting for its result shows as pending; updates to unknown ids are skipped.
{
  const replayed = replayClaudeTaskCalls([create('c9', 'Streaming task'), update('u9', '42', { status: 'completed' })], textFor);
  assert.deepEqual(replayed?.tasks.map(({ content, status }) => [content, status]), [['Streaming task', 'pending']]);
}
assert.equal(replayClaudeTaskCalls([{ id: 'x', name: 'Read', input: {} }], textFor), null, 'no task writes, no list');

// The progress card replays task calls; earlier turns seed a turn that only updates.
{
  const turnOne = [create('c1', 'Read the code'), create('c2', 'Fix the bug')];
  const turnTwo = [update('u1', '1', { status: 'completed' }), update('u2', '2', { status: 'in_progress' })];
  const progress = extractLatestTodoProgress(turnTwo, results, turnOne);
  assert.deepEqual(progress?.todos.map(({ content, status }) => [content, status]), [
    ['Read the code', 'completed'],
    ['Fix the bug', 'in_progress'],
  ]);
  assert.equal(progress?.completedCount, 1);
  assert.equal(progress?.inProgressCount, 1);
  assert.equal(extractLatestTodoProgress(turnTwo, results), null, 'without earlier turns the updates name unknown tasks');
}

// Whichever list was written last wins: a TodoWrite snapshot or the task calls.
{
  const todoWrite = { id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Old plan', status: 'pending' }] } };
  assert.equal(extractLatestTodoProgress([create('c1', 'Read the code'), todoWrite], results)?.todos[0].content, 'Old plan');
  assert.equal(extractLatestTodoProgress([todoWrite, create('c1', 'Read the code')], results)?.todos[0].content, 'Read the code');
}

console.log('claude task tools: replay, cross-turn seeding and TodoWrite precedence passed');

import assert from 'node:assert/strict';
import { kimiGoalCommand, supportsGoalUI, type ThreadGoal } from '../../src/shared/session-goal';

const goal = (status: ThreadGoal['status']): ThreadGoal => ({
  threadId: 't',
  objective: 'Ship it',
  status,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
});

assert.equal(supportsGoalUI('kimi'), true);
assert.equal(kimiGoalCommand({ type: 'set', status: 'active', objective: ' pause the release ' }, null), '/goal -- pause the release');
assert.equal(kimiGoalCommand({ type: 'set', objective: 'New aim' }, goal('complete')), '/goal -- New aim', 'a finished goal is not replaced');
assert.equal(kimiGoalCommand({ type: 'set', objective: 'New aim' }, goal('active')), '/goal replace New aim');
assert.equal(kimiGoalCommand({ type: 'set', objective: 'New aim' }, goal('paused')), '/goal replace New aim');
assert.equal(kimiGoalCommand({ type: 'set', status: 'paused' }, goal('active')), '/goal pause');
assert.equal(kimiGoalCommand({ type: 'set', status: 'active' }, goal('paused')), '/goal resume');
assert.equal(kimiGoalCommand({ type: 'clear' }, goal('active')), '/goal cancel');
console.log('kimi-goal-command: passed');

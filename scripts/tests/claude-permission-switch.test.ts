// The Claude runner's permission switches, as the composer's picker and
// ExitPlanMode drive them while the CLI confirms each one late:
// - a switch is confirmed only when the CLI answers; canUseTool keeps
//   deciding by the old mode until then;
// - a reverse pick before the first confirmation ends in the reverse mode,
//   and the host hears only that final mode;
// - a failed switch leaves the confirmed mode, rejects its caller, and the
//   next request still goes through;
// - a plan exit queued behind a picker switch returns to the access mode
//   the picker chose, and a picker switch while plan hides it waits for the
//   exit (the approval flow and the picker interleave on one queue);
// - read-only workflow members never leave 'default'.
import assert from 'node:assert/strict';
import { createClaudePermissionSwitcher } from '../../src/electron/libs/claude-permission-switch';

type Mode = Parameters<typeof createClaudePermissionSwitcher>[0]['apply'] extends (mode: infer M) => unknown ? M : never;

function deferredSdk() {
  const pending: Array<{ mode: Mode; resolve: () => void; reject: (error: Error) => void }> = [];
  const applied: Mode[] = [];
  return {
    pending,
    applied,
    apply: (mode: Mode) =>
      new Promise<void>((resolve, reject) => {
        applied.push(mode);
        pending.push({ mode, resolve, reject });
      }),
    confirm(index = 0) {
      const [entry] = pending.splice(index, 1);
      entry.resolve();
      return new Promise<void>((r) => setTimeout(r, 0));
    },
    fail(message: string, index = 0) {
      const [entry] = pending.splice(index, 1);
      entry.reject(new Error(message));
      return new Promise<void>((r) => setTimeout(r, 0));
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {

// Delayed confirmation: the pick is not the mode until the CLI says so.
{
  const sdk = deferredSdk();
  const changes: Array<[string, string]> = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'execute',
    apply: sdk.apply,
    onChanged: (execution, access) => changes.push([execution, access]),
  });
  const done = permission.set('bypassPermissions', 'execute');
  await settle();
  assert.equal(permission.mode, 'default', 'unconfirmed switch keeps the old mode');
  assert.equal(permission.target, 'bypassPermissions', 'the pick is the target');
  assert.deepEqual(sdk.applied, ['bypassPermissions']);
  assert.deepEqual(changes, [], 'nothing reported before the CLI confirms');
  await sdk.confirm();
  await done;
  assert.equal(permission.mode, 'bypassPermissions');
  assert.equal(permission.accessMode, 'bypassPermissions');
  assert.deepEqual(changes, [['execute', 'bypassPermissions']]);
}

// Rapid reverse: Default → Full Access → Default before the first confirms.
{
  const sdk = deferredSdk();
  const changes: Array<[string, string]> = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'execute',
    apply: sdk.apply,
    onChanged: (execution, access) => changes.push([execution, access]),
  });
  const first = permission.set('bypassPermissions', 'execute');
  await settle();
  const second = permission.set('default', 'execute');
  await settle();
  assert.deepEqual(sdk.applied, ['bypassPermissions'], 'the reverse waits for the first to confirm');
  await sdk.confirm();
  await first;
  assert.equal(permission.mode, 'bypassPermissions', 'the first confirmation lands');
  assert.deepEqual(changes, [], 'but is not reported: a newer pick is waiting');
  await settle();
  assert.deepEqual(sdk.applied, ['bypassPermissions', 'default'], 'the reverse goes to the CLI next');
  await sdk.confirm();
  await second;
  assert.equal(permission.mode, 'default', 'the last pick is the final mode');
  assert.equal(permission.accessMode, 'default');
  assert.deepEqual(changes, [['execute', 'default']], 'the host hears the final mode once');
}

// Two picks in one tick: only the newest reaches the CLI.
{
  const sdk = deferredSdk();
  const changes: string[] = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'execute',
    apply: sdk.apply,
    onChanged: (_execution, access) => changes.push(access),
  });
  const first = permission.set('bypassPermissions', 'execute');
  const second = permission.set('acceptEdits', 'execute');
  await settle();
  assert.deepEqual(sdk.applied, ['acceptEdits'], 'the superseded pick is skipped');
  await sdk.confirm();
  await Promise.all([first, second]);
  assert.equal(permission.mode, 'acceptEdits');
  assert.deepEqual(changes, ['acceptEdits']);
}

// Failure: the confirmed mode stays, the caller hears, the next pick works.
{
  const sdk = deferredSdk();
  const changes: string[] = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'execute',
    apply: sdk.apply,
    onChanged: (_execution, access) => changes.push(access),
  });
  const failed = permission.set('bypassPermissions', 'execute');
  await settle();
  await sdk.fail('bypass_not_launched');
  await assert.rejects(failed, /bypass_not_launched/);
  assert.equal(permission.mode, 'default', 'a failed switch changes nothing');
  assert.equal(permission.target, 'default', 'and is no longer the target');
  assert.deepEqual(changes, [], 'nothing reported for a failed switch');
  const next = permission.set('acceptEdits', 'execute');
  await settle();
  assert.deepEqual(sdk.applied, ['bypassPermissions', 'acceptEdits'], 'the queue survives a failure');
  await sdk.confirm();
  await next;
  assert.equal(permission.mode, 'acceptEdits');
  assert.deepEqual(changes, ['acceptEdits']);
}

// Approval flow interleaved: the picker changes the access mode while plan
// mode hides it; the plan exit (queued behind nothing) returns to that pick.
{
  const sdk = deferredSdk();
  const changes: Array<[string, string]> = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'plan',
    apply: sdk.apply,
    onChanged: (execution, access) => changes.push([execution, access]),
  });
  assert.equal(permission.mode, 'plan');
  await permission.set('bypassPermissions', 'plan');
  assert.deepEqual(sdk.applied, [], 'plan stays plan: no CLI round trip');
  assert.equal(permission.accessMode, 'bypassPermissions', 'but the pick is remembered for the exit');
  const exit = permission.exitPlan();
  await settle();
  assert.deepEqual(sdk.applied, ['bypassPermissions'], 'the plan exit returns to the picked access mode');
  await sdk.confirm();
  await exit;
  assert.equal(permission.mode, 'bypassPermissions');
  assert.deepEqual(changes, [['execute', 'bypassPermissions']]);
}

// Plan exit confirmed late, picker switch meanwhile: the exit lands first,
// unreported, and the picker's mode is the final one.
{
  const sdk = deferredSdk();
  const changes: Array<[string, string]> = [];
  const permission = createClaudePermissionSwitcher({
    accessMode: 'default',
    executionMode: 'plan',
    apply: sdk.apply,
    onChanged: (execution, access) => changes.push([execution, access]),
  });
  const exit = permission.exitPlan();
  await settle();
  assert.deepEqual(sdk.applied, ['default']);
  const pick = permission.set('acceptEdits', 'execute');
  await settle();
  assert.deepEqual(sdk.applied, ['default'], 'the pick waits behind the exit');
  await sdk.confirm();
  await exit;
  assert.equal(permission.mode, 'default');
  assert.deepEqual(changes, [], 'the exit is not reported: the pick supersedes it');
  await settle();
  await sdk.confirm();
  await pick;
  assert.equal(permission.mode, 'acceptEdits');
  assert.deepEqual(changes, [['execute', 'acceptEdits']]);
}

// Read-only workflow member: the composer cannot move it.
{
  const sdk = deferredSdk();
  const permission = createClaudePermissionSwitcher({
    accessMode: 'bypassPermissions',
    executionMode: 'execute',
    readOnly: true,
    apply: sdk.apply,
    onChanged: () => assert.fail('a read-only member never reports a switch'),
  });
  assert.equal(permission.mode, 'default');
  await permission.set('bypassPermissions', 'execute');
  await permission.switchTo('acceptEdits');
  assert.deepEqual(sdk.applied, []);
  assert.equal(permission.mode, 'default');
}

}

main().then(
  () => console.log('claude-permission-switch: all checks passed'),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

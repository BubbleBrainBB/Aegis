import assert from 'node:assert/strict';
import {
  acquireStart,
  isStartLocked,
  markStartSent,
  releaseUnsentStart,
  startFailed,
  startLeaseFor,
  startSucceeded,
} from '../../src/ui/utils/start-lease';

const file = (path: string) => ({ id: path, name: path.split('/').pop()!, path, mimeType: 'text/plain', size: 1 }) as never;
const sent = { prompt: 'Write the report', attachments: [file('/tmp/a.txt')] };

// Send takes the composer's lease at once: a second Send gets nothing.
const a = acquireStart('landing', sent)!;
assert.ok(a);
assert.equal(isStartLocked('landing'), true);
assert.equal(acquireStart('landing', { prompt: 'Second', attachments: [] }), null, 'no second start while one is in progress');
const other = acquireStart('draft-1', sent)!;
assert.ok(other, 'another composer is independent');
releaseUnsentStart(other);

// Preparation that stops before sending frees the composer.
const prep = acquireStart('prep', sent)!;
releaseUnsentStart(prep);
assert.equal(isStartLocked('prep'), false);
assert.equal(startLeaseFor('prep'), undefined);

// Only this start's own result ends the lease; unrelated or unknown ids change nothing.
markStartSent(a);
startFailed(undefined);
startFailed('start-unknown');
startSucceeded('start-unknown');
assert.equal(isStartLocked('landing'), true, 'unrelated errors do not unlock');
releaseUnsentStart(a);
assert.equal(isStartLocked('landing'), true, 'a sent start is not released as unsent');

// Off screen when it fails: unlocked, and the text waits for the composer.
startFailed(a);
assert.equal(isStartLocked('landing'), false);
assert.deepEqual(startLeaseFor('landing'), { phase: 'failed', sent });
assert.equal(acquireStart('landing', sent), null, 'nothing new until the composer has shown the text');
startSucceeded(a);
assert.equal(startLeaseFor('landing')?.phase, 'failed', 'a late success for a failed start changes nothing');

// Success ends the lease for good.
const b = acquireStart('success', sent)!;
markStartSent(b);
startSucceeded(b);
assert.equal(isStartLocked('success'), false);
assert.equal(startLeaseFor('success'), undefined);
startFailed(b);
assert.equal(startLeaseFor('success'), undefined, 'a late failure after success restores nothing');

// Success runs the composer's own cleanup even when it is not on screen.
let cleaned = 0;
const g = acquireStart('goal', sent, { onSucceeded: () => { cleaned += 1; } })!;
markStartSent(g);
startFailed('start-unknown');
assert.equal(cleaned, 0);
startSucceeded(g);
assert.equal(cleaned, 1, 'cleanup runs once on success, with nothing mounted');
startSucceeded(g);
assert.equal(cleaned, 1);
const f = acquireStart('goal-fail', sent, { onSucceeded: () => { cleaned += 1; } })!;
markStartSent(f);
startFailed(f);
assert.equal(cleaned, 1, 'a failed start keeps goal mode');

// The destination travels with the lease.
const d = acquireStart('dest', { ...sent, destination: { cwd: null, startMode: 'local' } })!;
assert.deepEqual(startLeaseFor('dest')?.sent.destination, { cwd: null, startMode: 'local' });
releaseUnsentStart(d);

console.log('start-lease: ok');

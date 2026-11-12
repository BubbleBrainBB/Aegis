import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import { getLatestQoderContextSnapshot } from '../../src/ui/utils/context-usage';
import { qoderModelNameAlias } from '../../src/shared/qoder-models';

// The context ring reads the latest result of the selected model. Qoder
// results go by the model's id; ones saved from qodercli 1.1.8x before that
// was settled carry the name the picker shows. Either belongs to the model.
const result = (model: string, used: number | null, window: number | null): StreamMessage => ({
  type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0, model,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: used, context_window: window },
}) as StreamMessage;

// By id.
let snapshot = getLatestQoderContextSnapshot([result('qmodel_latest', 35239, 200000)], 'qmodel_latest', 'Qwen4-Max-Preview');
assert.deepEqual([snapshot?.used, snapshot?.total, snapshot?.percent], [35239, 200000, 18]);

// Saved under the display name: still this model's usage.
snapshot = getLatestQoderContextSnapshot([result('Qwen4-Max-Preview', 35239, 200000)], 'qmodel_latest', 'Qwen4-Max-Preview');
assert.deepEqual([snapshot?.used, snapshot?.total], [35239, 200000]);

// A result with no window (turns from before the window could be found) is passed over.
snapshot = getLatestQoderContextSnapshot(
  [result('Qwen4-Max-Preview', 20000, 200000), result('Qwen4-Max-Preview', null, null)],
  'qmodel_latest', 'Qwen4-Max-Preview'
);
assert.equal(snapshot?.used, 20000);

// Mixed history: the newest usable result wins, whichever name it carries.
snapshot = getLatestQoderContextSnapshot(
  [result('qmodel_latest', 10000, 200000), result('Qwen4-Max-Preview', 180000, 200000)],
  'qmodel_latest', 'Qwen4-Max-Preview'
);
assert.deepEqual([snapshot?.used, snapshot?.percent], [180000, 90], 'an older result under the id does not hide a newer one under the name');
snapshot = getLatestQoderContextSnapshot(
  [result('Qwen4-Max-Preview', 180000, 200000), result('qmodel_latest', 10000, 200000)],
  'qmodel_latest', 'Qwen4-Max-Preview'
);
assert.deepEqual([snapshot?.used, snapshot?.percent], [10000, 5], 'nor the other way round');

// Another model's usage is not this model's.
assert.equal(getLatestQoderContextSnapshot([result('Fast', 5000, 200000)], 'qmodel_latest', 'Qwen4-Max-Preview'), null);
assert.equal(getLatestQoderContextSnapshot([result('fast', 5000, 200000)], 'qmodel_latest', 'Qwen4-Max-Preview'), null);

// The name is an alias only when it can mean no other model. With one
// model's display name equal to another's id, the other model's results must
// not count for the first, nor may a name two models share.
{
  const crossed = [{ value: 'a', displayName: 'b' }, { value: 'b', displayName: 'Bee' }];
  const ofB = [result('b', 180000, 200000)];
  assert.equal(getLatestQoderContextSnapshot(ofB, 'a', qoderModelNameAlias(crossed, 'a')), null, "b's usage is not a's");
  assert.equal(getLatestQoderContextSnapshot(ofB, 'b', qoderModelNameAlias(crossed, 'b'))?.used, 180000);
  assert.equal(getLatestQoderContextSnapshot([result('Bee', 9000, 200000)], 'b', qoderModelNameAlias(crossed, 'b'))?.used, 9000);
  const shared = [{ value: 'a', displayName: 'Shared' }, { value: 'b', displayName: 'Shared' }];
  const named = [result('Shared', 50000, 200000)];
  assert.equal(getLatestQoderContextSnapshot(named, 'a', qoderModelNameAlias(shared, 'a')), null, 'a shared name says nothing about either');
  assert.equal(getLatestQoderContextSnapshot(named, 'b', qoderModelNameAlias(shared, 'b')), null);
}

// No label, or a label equal to the id: the id alone decides.
assert.equal(getLatestQoderContextSnapshot([result('Auto', 5000, 200000)], 'auto', null)?.used, 5000, 'ids compare without case');
assert.equal(getLatestQoderContextSnapshot([result('Qwen4-Max-Preview', 5000, 200000)], 'qmodel_latest', null), null);

console.log('qoder-context-ring.test.ts passed');

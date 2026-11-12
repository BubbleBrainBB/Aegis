import assert from 'node:assert/strict';
import {
  findQoderModelById,
  findQoderModelByName,
  qoderModelNameAlias,
  resolveReportedQoderModel,
} from '../../src/shared/qoder-models';

// Telling Qoder's models apart when the CLI names a model by its id or by the
// name the picker shows. Nothing here may pick one of several candidates.
const model = (value: string, displayName: string) => ({ value, displayName });
const plain = [model('auto', 'Auto'), model('fast', 'Fast'), model('qmodel_latest', 'Qwen4-Max-Preview')];
const shared = [model('a', 'Shared'), model('b', 'Shared')];
// One model's display name is another's id.
const crossed = [model('a', 'b'), model('b', 'Bee')];

// A name that says which model it is.
assert.equal(findQoderModelByName(plain, 'Qwen4-Max-Preview')?.value, 'qmodel_latest');
assert.equal(findQoderModelByName(plain, ' fast ')?.value, 'fast');
assert.equal(findQoderModelByName(plain, 'Mystery'), undefined);
assert.equal(findQoderModelByName(plain, ''), undefined);
assert.equal(findQoderModelByName(shared, 'Shared'), undefined, 'two models carry it');
assert.equal(findQoderModelByName(crossed, 'b'), undefined, "one model's name, another's id");
assert.equal(findQoderModelByName(crossed, 'Bee')?.value, 'b');
// An id names its own entry even then.
assert.equal(findQoderModelById(crossed, 'b')?.displayName, 'Bee');
assert.equal(findQoderModelById(crossed, 'Bee'), undefined);

const told = (models: Array<{ value: string; displayName: string }>, reported: string, requested?: string) =>
  resolveReportedQoderModel(models, reported, requested);

// The CLI confirms the model that was asked for, by its id or by its name.
assert.deepEqual(told(plain, 'Qwen4-Max-Preview', 'qmodel_latest'), { model: 'qmodel_latest', resolved: true });
assert.deepEqual(told(plain, 'qmodel_latest', 'qmodel_latest'), { model: 'qmodel_latest', resolved: true });
// Also when that name could mean another model too.
assert.deepEqual(told(shared, 'Shared', 'b'), { model: 'b', resolved: true });
assert.deepEqual(told(shared, 'Shared', 'a'), { model: 'a', resolved: true });
assert.deepEqual(told(crossed, 'b', 'a'), { model: 'a', resolved: true });
assert.deepEqual(told(crossed, 'b', 'b'), { model: 'b', resolved: true });
assert.deepEqual(told(crossed, 'Bee', 'b'), { model: 'b', resolved: true });

// Nothing asked for: the CLI's name for its default is read when it is clear.
assert.deepEqual(told(plain, 'Auto'), { model: 'auto', resolved: true });
assert.deepEqual(told(plain, 'auto'), { model: 'auto', resolved: true });
assert.deepEqual(told(shared, 'Shared'), { model: 'Shared', resolved: false }, 'not guessed');
assert.deepEqual(told(crossed, 'b'), { model: 'b', resolved: false }, 'not guessed');
assert.deepEqual(told(plain, 'Mystery'), { model: 'Mystery', resolved: false });

// The CLI is on another model than the one asked for: its name is believed,
// and the asked-for id is never assumed.
assert.deepEqual(told(plain, 'Auto', 'fast'), { model: 'auto', resolved: true });
assert.deepEqual(told(shared, 'Shared', 'c'), { model: 'Shared', resolved: false });
assert.deepEqual(told(plain, 'Mystery', 'fast'), { model: 'Mystery', resolved: false });

// No catalog to read the name by: unresolved, whatever was asked for.
assert.deepEqual(told([], 'Auto', 'fast'), { model: 'Auto', resolved: false });
assert.deepEqual(told([], 'Qwen4-Max-Preview', 'qmodel_latest'), { model: 'Qwen4-Max-Preview', resolved: false });
assert.deepEqual(told([], 'Auto'), { model: 'Auto', resolved: false });
// The same string needs no catalog.
assert.deepEqual(told([], 'fast', 'fast'), { model: 'fast', resolved: true });

// The name older results may carry for a model, only when it can mean no other.
assert.equal(qoderModelNameAlias(plain, 'qmodel_latest'), 'Qwen4-Max-Preview');
assert.equal(qoderModelNameAlias(shared, 'a'), null, 'another model shares it');
assert.equal(qoderModelNameAlias(crossed, 'a'), null, "it is another model's id");
assert.equal(qoderModelNameAlias(crossed, 'b'), 'Bee');
assert.equal(qoderModelNameAlias([model('same', 'same')], 'same'), null, 'nothing to add to the id');
assert.equal(qoderModelNameAlias(plain, 'Mystery'), null);
assert.equal(qoderModelNameAlias(plain, null), null);
assert.equal(qoderModelNameAlias([], 'auto'), null);

console.log('qoder-models.test.ts passed');

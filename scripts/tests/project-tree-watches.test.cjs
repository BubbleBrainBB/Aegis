const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, mkdir, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const threads = require('node:worker_threads');
const { watchProjectTree, unwatchProjectTree, disposeProjectTreeWatches } =
  require('../../dist-electron/electron/libs/project-tree-subscriptions.js');

async function until(check) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for a tree update or worker acknowledgement');
    await delay(20);
  }
}

test('a slow close leaves navigation responsive and only the current subscription publishes', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'project-tree-watch-')));
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const NativeWorker = threads.Worker;
  t.mock.method(threads, 'Worker', class extends NativeWorker {
    constructor(file) {
      super(file, { workerData: gate.buffer, execArgv: ['--require', require.resolve('./fixtures/project-tree/slow-close.cjs')] });
    }
  });
  t.mock.method(fs, 'watch', () => assert.fail('native watch opened on the main thread'));
  try {
    const first = [];
    assert.equal(await watchProjectTree(root, tree => first.push(tree)), true);
    await until(() => first.length > 0);
    // Darwin can register the stream after fs.watch() returns. Wait for the
    // first native change before checking delivery of a single nested edit.
    const initialCount = first.length;
    const probe = setInterval(() => fs.writeFileSync(path.join(nested, 'probe.txt'), String(Date.now())), 500);
    try {
      await until(() => first.length > initialCount);
    } finally {
      clearInterval(probe);
    }
    await writeFile(path.join(nested, 'new.txt'), 'new file');
    await until(() => first.at(-1)?.children[0]?.children.some(node => node.name === 'new.txt'));

    unwatchProjectTree(root);
    await until(() => Atomics.load(gate, 0) === 1);
    const countAfterClose = first.length;
    const skipped = watchProjectTree(nested, () => assert.fail('cancelled selection published'));
    unwatchProjectTree(nested);
    assert.equal(await skipped, false);

    const latest = [];
    const reopened = watchProjectTree(root, tree => latest.push(tree));
    await writeFile(path.join(root, 'while-closing.txt'), 'during close');
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    assert.equal(await reopened, true);
    assert.equal(Atomics.load(gate, 0), 2, 'main thread released the blocked close');
    await until(() => latest.at(-1)?.children.some(node => node.name === 'while-closing.txt'));
    assert.equal(first.length, countAfterClose);
  } finally {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    disposeProjectTreeWatches();
    await rm(root, { recursive: true, force: true });
  }
});

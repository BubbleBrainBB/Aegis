// Loaded only in the test's filesystem worker. Hold the first native close
// until the test has switched away and back on the main thread.
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const gate = new Int32Array(workerData);
const watch = fs.watch;
fs.watch = function (...args) {
  const watcher = watch(...args);
  const close = watcher.close.bind(watcher);
  watcher.close = () => {
    if (Atomics.compareExchange(gate, 0, 0, 1) === 0) {
      const result = Atomics.wait(gate, 1, 0, 15_000);
      Atomics.store(gate, 0, result === 'timed-out' ? -1 : 2);
    }
    return close();
  };
  return watcher;
};

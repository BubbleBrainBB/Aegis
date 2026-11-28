import { statSync, watch, type FSWatcher } from 'node:fs';
import { parentPort, receiveMessageOnPort } from 'node:worker_threads';

export interface ProjectTreeSubscription {
  cwd: string;
  id: number;
}

export type ProjectTreeWatchEvent = ProjectTreeSubscription & (
  | { type: 'ready' | 'changed' }
  | { type: 'error'; message: string }
);

const port = parentPort!;
const active = new Map<number, FSWatcher>();

function notify(event: ProjectTreeWatchEvent): void {
  port.postMessage(event);
}

function subscribe(root: ProjectTreeSubscription): void {
  try {
    if (!statSync(root.cwd).isDirectory()) throw new Error('Not a directory');
    let pending: NodeJS.Immediate | undefined;
    const watcher = watch(root.cwd, { recursive: true }, () => {
      if (pending) return;
      pending = setImmediate(() => {
        pending = undefined;
        if (active.has(root.id)) notify({ ...root, type: 'changed' });
      });
    });
    active.set(root.id, watcher);
    watcher.on('error', (error) => {
      if (!active.delete(root.id)) return;
      notify({ ...root, type: 'error', message: error.message });
      watcher.close();
    });
    notify({ ...root, type: 'ready' });
  } catch (error) {
    notify({ ...root, type: 'error', message: String(error) });
  }
}

port.on('message', (roots: ProjectTreeSubscription[]) => {
  // Native registration/teardown may stall. Skip intermediate selections
  // that arrived while this thread was waiting for the filesystem.
  let queued;
  while ((queued = receiveMessageOnPort(port))) roots = queued.message;
  const desired = new Set(roots.map(root => root.id));
  for (const [id, watcher] of active) {
    if (desired.has(id)) continue;
    active.delete(id);
    watcher.close();
  }
  for (const root of roots) {
    if (!active.has(root.id)) subscribe(root);
  }
});

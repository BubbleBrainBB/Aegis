import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { readProjectTree } from './project-tree';
import type { ProjectTreeSubscription, ProjectTreeWatchEvent } from './project-tree-watch-worker';

type PublishTree = (tree: Awaited<ReturnType<typeof readProjectTree>>) => void;
interface TreeWatch extends ProjectTreeSubscription {
  publish: PublishTree;
  ready: Promise<boolean>;
  resolveReady: (ok: boolean) => void;
  version: number;
  timer?: NodeJS.Timeout;
}

const watches = new Map<string, TreeWatch>();
let worker: Worker | undefined;
let nextId = 0;

function syncWorker(): void {
  worker?.postMessage(Array.from(watches.values(), ({ cwd, id }) => ({ cwd, id })));
}

function scheduleRefresh(entry: TreeWatch): void {
  clearTimeout(entry.timer);
  const version = entry.version;
  entry.timer = setTimeout(async () => {
    const tree = await readProjectTree(entry.cwd).catch(error => {
      console.error('Failed to read project tree:', error);
      return null;
    });
    // The user may have left and returned to the same directory during the read.
    if (watches.get(entry.cwd) !== entry || entry.version !== version) return;
    if (!tree) unwatchProjectTree(entry.cwd);
    entry.publish(tree);
  }, 200);
}

export function invalidateProjectTree(cwd: string): void {
  const entry = watches.get(resolve(cwd));
  if (entry) entry.version++;
}

export function unwatchProjectTree(cwd: string): void {
  if (!cwd) return;
  const key = resolve(cwd);
  const entry = watches.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.resolveReady(false);
  watches.delete(key);
  syncWorker();
}

function ensureWorker(): void {
  if (worker) return;
  const thread = new Worker(require.resolve('./project-tree-watch-worker'));
  worker = thread;
  thread.on('message', (event: ProjectTreeWatchEvent) => {
    const entry = watches.get(event.cwd);
    if (entry?.id !== event.id) return;
    if (event.type === 'error') {
      console.error('Failed to watch project tree:', event.cwd, event.message);
      unwatchProjectTree(event.cwd);
      return;
    }
    if (event.type === 'ready') entry.resolveReady(true);
    scheduleRefresh(entry);
  });
  thread.on('error', error => console.error('Project tree watcher failed:', error));
  thread.on('exit', () => {
    if (worker === thread) clearWatches();
  });
  thread.unref();
}

export async function watchProjectTree(cwd: string, publish: PublishTree): Promise<boolean> {
  if (!cwd) return false;
  const key = resolve(cwd);
  const existing = watches.get(key);
  if (existing) {
    existing.publish = publish;
    scheduleRefresh(existing);
    return existing.ready;
  }
  try {
    ensureWorker();
    let resolveReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>(done => { resolveReady = done; });
    watches.set(key, { cwd: key, id: ++nextId, version: 0, publish, ready, resolveReady });
    syncWorker();
    return ready;
  } catch (error) {
    console.error('Failed to watch project tree:', cwd, error);
    unwatchProjectTree(key);
    return false;
  }
}

function clearWatches(): void {
  worker = undefined;
  for (const key of watches.keys()) unwatchProjectTree(key);
}

export function disposeProjectTreeWatches(): void {
  const thread = worker;
  clearWatches();
  void thread?.terminate();
}

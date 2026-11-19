import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { GitOverviewResult } from '../../../shared/types';

const EMPTY_GIT_OVERVIEW: GitOverviewResult = {
  ok: false,
  error: null,
  hasRepo: false,
  repoRoot: null,
  repository: null,
  branch: null,
  upstream: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  hasOriginRemote: false,
  isGitHubRemote: false,
  isDefaultBranch: false,
  totalChanges: 0,
  insertions: 0,
  deletions: 0,
  branchChanges: null,
  prStatus: 'not_found',
  pr: null,
};

export interface GitEnvironmentState {
  overview: GitOverviewResult;
  loading: boolean;
  lastUpdatedAt: number | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  getSnapshot: () => GitEnvironmentSnapshot;
}

export interface GitEnvironmentSnapshot {
  contextKey: string;
  cwd: string | null;
  repoRoot: string | null;
  branch: string | null;
  signature: string;
}

const UNSETTLED_INSERTIONS = 'unsettled';

/**
 * What an action checks the repository against before it runs. Lines added
 * to tracked files are measured by git and always compared. The untracked
 * share comes last, on its own, because it alone can be unreliable.
 */
export function gitSignature(overview: GitOverviewResult): string {
  const untrackedInsertions = overview.untrackedInsertions ?? 0;
  return [
    overview.repoRoot || '',
    overview.branch || '',
    overview.upstream || '',
    overview.aheadCount,
    overview.behindCount,
    overview.totalChanges,
    overview.deletions,
    overview.prStatus,
    overview.pr?.number || '',
    overview.insertions - untrackedInsertions,
    // Cut short by time, the count can differ between two scans of an unchanged repository.
    overview.untrackedInsertionsUnsettled ? UNSETTLED_INSERTIONS : untrackedInsertions,
  ].join(':');
}

/**
 * Whether two signatures describe the same repository state. An untracked
 * count that one of the scans ran out of time for says nothing either way,
 * so such a scan is not taken for a changed repository. Everything else,
 * the lines added to tracked files included, has to be equal.
 */
export function gitSignaturesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const split = (signature: string) => {
    const cut = signature.lastIndexOf(':');
    return [signature.slice(0, cut), signature.slice(cut + 1)];
  };
  const [stateA, untrackedA] = split(a);
  const [stateB, untrackedB] = split(b);
  return stateA === stateB && (untrackedA === UNSETTLED_INSERTIONS || untrackedB === UNSETTLED_INSERTIONS);
}

// Git state belongs to the working directory, not the session displaying it.
// Keep worktrees separate and share both results and automatic requests across panes.
const FRESHNESS_MS = 60_000;
interface CachedEnvironment {
  state: { overview: GitOverviewResult; lastUpdatedAt: number | null };
  checkedAt: number | null;
  inFlight: Promise<void> | null;
  listeners: Set<() => void>;
}
const environments = new Map<string, CachedEnvironment>();

function environmentFor(cwd: string): CachedEnvironment {
  let entry = environments.get(cwd);
  if (!entry) {
    entry = {
      state: { overview: EMPTY_GIT_OVERVIEW, lastUpdatedAt: null },
      checkedAt: null,
      inFlight: null,
      listeners: new Set(),
    };
    environments.set(cwd, entry);
  }
  return entry;
}

function refreshEnvironment(cwd: string, entry: CachedEnvironment, force: boolean): Promise<void> {
  if (!cwd) return Promise.resolve();
  if (!force) {
    if (entry.inFlight) return entry.inFlight;
    if (entry.checkedAt !== null && Date.now() - entry.checkedAt < FRESHNESS_MS) {
      return Promise.resolve();
    }
  }

  // Explicit refreshes (including after mutations) supersede an older check.
  const request = Promise.resolve().then(async () => {
    let next: GitOverviewResult;
    try {
      next = await window.electron.getGitOverview(cwd);
    } catch {
      next = { ...EMPTY_GIT_OVERVIEW, error: 'git-error' };
    }
    if (entry.inFlight !== request) return;
    entry.checkedAt = Date.now();
    const hasCachedResult = entry.state.overview.ok || entry.state.overview.error === 'not-a-repo';
    // A transient background failure must not replace usable cached content.
    if (!hasCachedResult || next.ok || next.error === 'not-a-repo') {
      entry.state = { overview: next, lastUpdatedAt: entry.checkedAt };
    }
    entry.inFlight = null;
    entry.listeners.forEach(listener => listener());
  });
  entry.inFlight = request;
  return request;
}

export function useGitEnvironment(cwd: string | null, contextKey: string): GitEnvironmentState {
  const trimmedCwd = (cwd || '').trim();
  const entry = useMemo(() => environmentFor(trimmedCwd), [trimmedCwd]);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const readCache = useCallback(() => entry.state, [entry]);
  const { overview, lastUpdatedAt } = useSyncExternalStore(subscribe, readCache);
  // Only the first check needs a loading placeholder; revalidation stays quiet.
  const loading = Boolean(trimmedCwd) && lastUpdatedAt === null;
  const latestRef = useRef({ cwd, contextKey, overview });

  useEffect(() => {
    latestRef.current = { cwd, contextKey, overview };
  }, [contextKey, cwd, overview]);

  const refresh = useCallback<GitEnvironmentState['refresh']>((options) => (
    refreshEnvironment(trimmedCwd, entry, options?.force ?? true)
  ), [entry, trimmedCwd]);

  useEffect(() => {
    const ensureFresh = () => { void refresh({ force: false }); };
    ensureFresh();
    const interval = window.setInterval(ensureFresh, FRESHNESS_MS);
    window.addEventListener('focus', ensureFresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', ensureFresh);
    };
  }, [refresh]);

  const getSnapshot = useCallback<GitEnvironmentState['getSnapshot']>(() => {
    const current = latestRef.current;
    return {
      contextKey: current.contextKey,
      cwd: current.cwd || null,
      repoRoot: current.overview.repoRoot,
      branch: current.overview.branch,
      signature: gitSignature(current.overview),
    };
  }, []);

  return useMemo(
    () => ({
      overview,
      loading,
      lastUpdatedAt,
      refresh,
      getSnapshot,
    }),
    [getSnapshot, lastUpdatedAt, loading, overview, refresh]
  );
}

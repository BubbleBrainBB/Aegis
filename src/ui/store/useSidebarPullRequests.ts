import { useEffect } from 'react';
import { create } from 'zustand';
import type { GitPullRequestSummary } from '../../shared/types';

/**
 * The PRs each sidebar session is tied to, oldest first, keyed by session id. A runtime
 * cache over the main process's answer (explicit associations first, then the
 * PR on a live worktree's branch); nothing here is persisted.
 */
interface SidebarPullRequestStore {
  bySession: Record<string, GitPullRequestSummary[]>;
  /** Sessions whose worktree had nothing left to apply back at `settledCheckedAt`. */
  settledWorktrees: ReadonlySet<string>;
  settledCheckedAt: number;
  load: (refresh: boolean) => Promise<void>;
}

const REFRESH_INTERVAL_MS = 2 * 60_000;
let sequence = 0;
let settledSequence = 0;

export const useSidebarPullRequestStore = create<SidebarPullRequestStore>()((set) => ({
  bySession: {},
  settledWorktrees: new Set(),
  settledCheckedAt: 0,
  load: async (refresh) => {
    // Independent of gh: a worktree's git state is known without GitHub.
    if (typeof window.electron?.listSettledWorktreeSessions === 'function') {
      const request = ++settledSequence;
      const checkedAt = Date.now();
      void window.electron.listSettledWorktreeSessions().then((sessionIds) => {
        if (request === settledSequence) set({ settledWorktrees: new Set(sessionIds), settledCheckedAt: checkedAt });
      }).catch(() => {});
    }
    // Renderer hot-reloaded against an older main process: no bridge yet.
    if (typeof window.electron?.listSidebarPullRequests !== 'function') return;
    const request = ++sequence;
    try {
      const bySession = await window.electron.listSidebarPullRequests(refresh);
      if (request === sequence) set({ bySession });
    } catch {
      // gh missing or offline: keep what we had; PR state is decoration.
    }
  },
}));

/** Keeps the cache warm while the sidebar needs PR facts. */
export function useSidebarPullRequests(enabled: boolean): Record<string, GitPullRequestSummary[]> {
  const bySession = useSidebarPullRequestStore((state) => state.bySession);
  const load = useSidebarPullRequestStore((state) => state.load);

  useEffect(() => {
    if (!enabled) return;
    void load(false).then(() => load(true));
    const timer = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    const unsubscribe =
      typeof window.electron?.onSessionPullRequestsChanged === 'function'
        ? window.electron.onSessionPullRequestsChanged(() => void load(false))
        : undefined;
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      unsubscribe?.();
    };
  }, [enabled, load]);

  return bySession;
}

/** The PR that speaks for a session: its latest open one, else its latest. */
export function primaryPullRequest(prs: GitPullRequestSummary[] | null | undefined): GitPullRequestSummary | null {
  if (!prs?.length) return null;
  return [...prs].reverse().find((pr) => pr.state === 'open') ?? prs[prs.length - 1];
}

/** A session active since the last check may have new work, so that answer no longer speaks for it. */
export function isWorktreeSettled(
  session: { id: string; updatedAt: number },
  settled: Pick<SidebarPullRequestStore, 'settledWorktrees' | 'settledCheckedAt'>
): boolean {
  return settled.settledWorktrees.has(session.id) && session.updatedAt <= settled.settledCheckedAt;
}

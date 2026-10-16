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
  load: (refresh: boolean) => Promise<void>;
}

const REFRESH_INTERVAL_MS = 2 * 60_000;
let sequence = 0;

export const useSidebarPullRequestStore = create<SidebarPullRequestStore>()((set) => ({
  bySession: {},
  load: async (refresh) => {
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

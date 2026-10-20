import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentProvider, ClaudeUsageReport, ClaudeUsageRangeDays } from '../types';
import { createPlanUsageCache } from '../utils/plan-usage-cache';

// Keep each provider AND time range separate: a 30-day menu summary must never
// become the yearly detail report. Remounts share snapshots and pending queries.
const caches = new Map<string, ReturnType<typeof createCache>>();
function createCache(provider: AgentProvider, days: ClaudeUsageRangeDays) {
  return createPlanUsageCache(async (): Promise<{ fetchedAt: number; usage: ClaudeUsageReport | null }> => ({
    usage: await window.electron.getAgentUsageReport(provider, days),
    fetchedAt: Date.now(),
  }));
}

function getCache(provider: AgentProvider, days: ClaudeUsageRangeDays) {
  const key = `${provider}:${days}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = createCache(provider, days);
    caches.set(key, cache);
  }
  return cache;
}

export function prefetchAgentUsageReport(provider: AgentProvider, days: ClaudeUsageRangeDays = 365) {
  return getCache(provider, days).refresh();
}

export function useAgentUsageReport(provider: AgentProvider, days: ClaudeUsageRangeDays, enabled = true) {
  const cache = getCache(provider, days);
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void cache.refresh();
    const timer = window.setInterval(() => { void cache.refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [cache, enabled]);
  return snapshot;
}

type UsageSnapshot = ReturnType<ReturnType<typeof getCache>['getSnapshot']>;

/**
 * Several providers' reports for one range at once (the usage menu ranks them).
 * Only enabled providers fetch; the rest still report their cached snapshot.
 */
export function useAgentUsageReports(
  requests: ReadonlyArray<{ provider: AgentProvider; enabled: boolean }>,
  days: ClaudeUsageRangeDays,
): UsageSnapshot[] {
  const caches = requests.map(({ provider }) => getCache(provider, days));
  const key = requests.map(({ provider }) => provider).join(',');
  const enabledKey = requests.map(({ provider, enabled }) => (enabled ? provider : '')).join(',');
  const store = useMemo(() => {
    let last: UsageSnapshot[] = [];
    return {
      subscribe: (listener: () => void) => {
        const unsubscribes = caches.map((cache) => cache.subscribe(listener));
        return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
      },
      // Stable identity until one of the snapshots changes.
      getSnapshot: () => {
        const next = caches.map((cache) => cache.getSnapshot());
        if (next.length !== last.length || next.some((snapshot, index) => snapshot !== last[index])) last = next;
        return last;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, days]);
  const snapshots = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    const enabled = caches.filter((_, index) => requests[index].enabled);
    if (!enabled.length) return;
    enabled.forEach((cache) => { void cache.refresh(); });
    const timer = window.setInterval(() => enabled.forEach((cache) => { void cache.refresh(); }), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabledKey, days]);
  return snapshots;
}

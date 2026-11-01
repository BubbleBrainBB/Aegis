import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Attachment } from '../types';

/**
 * A composer's first message keeps its text until the conversation exists.
 *
 * Send takes a lease for the composer before anything else (even before the
 * message is prepared): the composer keeps its text, locked, and cannot send
 * again. Only this start's own result ends the lease. The main process echoes
 * the startId on the new session's status, or on the error when the start
 * fails first:
 *   - created: the composer clears;
 *   - failed: the composer unlocks with the text still in it.
 * The lease also holds the text, so a composer that was off screen meanwhile
 * shows it again (locked while pending, editable once failed) when it mounts.
 */
export interface SentStart {
  prompt: string;
  attachments: Attachment[];
  /** Sent as a goal: the composer stays in goal mode with it. */
  goal?: boolean;
  /** Where it was going, for a composer that does not keep that itself. */
  destination?: StartDestination;
}

export interface StartDestination {
  /** No project: a new chat folder. Otherwise the project folder. */
  cwd: string | null;
  startMode: 'local' | 'worktree';
}

interface Lease {
  startId: string;
  composer: string;
  sent: SentStart;
  phase: 'preparing' | 'sent' | 'failed';
  /** Runs on success even when the composer is not on screen (state kept outside it). */
  onSucceeded?: () => void;
}

const byComposer = new Map<string, Lease>();
const byStartId = new Map<string, Lease>();
const mounted = new Map<string, Set<{ onCreated: () => void }>>();
let nextStart = 0;

/** Which composers are locked by a start in progress. */
export const useStartLocks = create<{ locked: Record<string, true> }>(() => ({ locked: {} }));

function setLocked(composer: string, locked: boolean) {
  useStartLocks.setState((state) => {
    if (Boolean(state.locked[composer]) === locked) return state;
    const next = { ...state.locked };
    if (locked) next[composer] = true;
    else delete next[composer];
    return { locked: next };
  });
}

function drop(lease: Lease) {
  byStartId.delete(lease.startId);
  if (byComposer.get(lease.composer) === lease) byComposer.delete(lease.composer);
  setLocked(lease.composer, false);
}

/**
 * Take the composer's lease when Send is pressed, before any await. Returns
 * null while the composer already has a start in progress (or a failed one
 * it has not shown yet): nothing may be sent then.
 */
export function acquireStart(
  composer: string,
  sent: SentStart,
  effects: { onSucceeded?: () => void } = {},
): string | null {
  if (byComposer.has(composer)) return null;
  const lease: Lease = {
    startId: `start-${Date.now().toString(36)}-${(nextStart += 1)}`,
    composer,
    sent: { ...sent, attachments: [...sent.attachments] },
    phase: 'preparing',
    onSucceeded: effects.onSucceeded,
  };
  byComposer.set(composer, lease);
  byStartId.set(lease.startId, lease);
  setLocked(composer, true);
  return lease.startId;
}

/** Call right before dispatching session.start with this startId. */
export function markStartSent(startId: string) {
  const lease = byStartId.get(startId);
  if (lease) lease.phase = 'sent';
}

/** Preparation stopped before anything was sent: the composer is free again. */
export function releaseUnsentStart(startId: string) {
  const lease = byStartId.get(startId);
  if (lease?.phase === 'preparing') drop(lease);
}

/** The conversation exists: its first message is in its history. */
export function startSucceeded(startId: string | undefined) {
  const lease = startId ? byStartId.get(startId) : undefined;
  if (!lease || lease.phase !== 'sent') return;
  drop(lease);
  lease.onSucceeded?.();
  for (const composer of mounted.get(lease.composer) ?? []) composer.onCreated();
}

/** The start failed before a conversation existed: the text goes back to being editable. */
export function startFailed(startId: string | undefined) {
  const lease = startId ? byStartId.get(startId) : undefined;
  if (!lease || lease.phase !== 'sent') return;
  if (mounted.get(lease.composer)?.size) {
    // The composer is on screen with the text in it; it only unlocks.
    drop(lease);
    return;
  }
  // Off screen: keep the text for when the composer is back.
  byStartId.delete(startId!);
  lease.phase = 'failed';
  setLocked(lease.composer, false);
}

/**
 * Connects a composer to its leases. `show` puts a lease's text into a newly
 * mounted composer (it is empty then); `onCreated` clears it after success.
 * Returns whether the composer is locked by a start in progress.
 */
export function useStartLease(
  composer: string | null | undefined,
  handlers: { show: (sent: SentStart) => void; onCreated: () => void },
): boolean {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!composer) return;
    const entry = { onCreated: () => handlersRef.current.onCreated() };
    const set = mounted.get(composer) ?? new Set();
    set.add(entry);
    mounted.set(composer, set);
    const lease = byComposer.get(composer);
    if (lease) {
      handlersRef.current.show(lease.sent);
      if (lease.phase === 'failed') byComposer.delete(composer);
    }
    return () => {
      set.delete(entry);
      if (set.size === 0) mounted.delete(composer);
    };
  }, [composer]);
  return useStartLocks((state) => Boolean(composer && state.locked[composer]));
}

/** Whether this composer is locked by a start in progress (for event handlers). */
export function isStartLocked(composer: string | null | undefined): boolean {
  return Boolean(composer && useStartLocks.getState().locked[composer]);
}

/** The lease this composer holds, if any (for tests). */
export function startLeaseFor(composer: string): { phase: Lease['phase']; sent: SentStart } | undefined {
  const lease = byComposer.get(composer);
  return lease ? { phase: lease.phase, sent: lease.sent } : undefined;
}

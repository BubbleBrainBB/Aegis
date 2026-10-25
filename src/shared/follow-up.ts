// Follow-up task proposals (docs/collaboration/follow-up-sessions.md): an agent
// that finds a separate problem proposes a task; the user decides whether it
// runs in its own session and worktree, here, or not at all.
// Sub-sessions share the same records: when the user asks for a separate
// session in their own words, the agent starts one with start_session, no card
// to accept first. Either way the new session nests under the one that
// started it and reports back to it.

export const PROPOSE_FOLLOW_UP_TOOL = 'propose_follow_up';
export const WITHDRAW_FOLLOW_UP_TOOL = 'withdraw_follow_up';
export const START_SESSION_TOOL = 'start_session';

function matchesTool(name: unknown, tool: string): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim();
  return (
    normalized === tool ||
    normalized.endsWith(`__${tool}`) ||
    normalized.endsWith(`.${tool}`) ||
    normalized.endsWith(`/${tool}`)
  );
}

export const isProposeFollowUpToolName = (name: unknown) => matchesTool(name, PROPOSE_FOLLOW_UP_TOOL);
export const isWithdrawFollowUpToolName = (name: unknown) => matchesTool(name, WITHDRAW_FOLLOW_UP_TOOL);
export const isStartSessionToolName = (name: unknown) => matchesTool(name, START_SESSION_TOOL);

/** A proposal the user accepts on a card, or a sub-session started because the user asked. */
export type FollowUpKind = 'proposal' | 'session';

/** Where a sub-session works: the starting session's own folder, or a new git worktree. */
export type FollowUpPlace = 'shared' | 'worktree';

export type FollowUpStatus =
  | 'proposed'
  | 'starting'
  | 'started'
  | 'start_failed'
  | 'sent_here'
  | 'dismissed'
  | 'withdrawn';

export const OPEN_FOLLOW_UP_STATUSES: ReadonlySet<FollowUpStatus> = new Set(['proposed', 'start_failed']);

export interface FollowUpReportView {
  eventId: string;
  turnStatus: 'completed' | 'error' | 'stopped';
  summary: string;
  createdAt: number;
  /** When the result went to the parent conversation; null while it has not. */
  deliveredAt: number | null;
}

export interface FollowUpProposalView {
  id: string;
  revision: number;
  kind: FollowUpKind;
  parentSessionId: string;
  /** The propose_follow_up tool_use this proposal came from, when known. */
  toolUseId: string | null;
  title: string;
  reason: string;
  plan: string;
  acceptanceCriteria: string;
  provider: string;
  model: string | null;
  /** The permission mode the new session would use (inherited from the parent). */
  permissionMode: string | null;
  status: FollowUpStatus;
  childSessionId: string | null;
  place: FollowUpPlace;
  worktreeBranch: string | null;
  baseRef: string | null;
  lastError: string | null;
  /** When the user took the session out from under its parent; it no longer reports back. */
  detachedAt: number | null;
  /** Results the follow-up session reported, newest last. */
  reports: FollowUpReportView[];
  createdAt: number;
  updatedAt: number;
}

export type FollowUpActionKind = 'start' | 'here' | 'dismiss' | 'retry';

export interface FollowUpAction {
  proposalId: string;
  revision: number;
  /** Client-generated id; a repeated click with the same id gets the same answer. */
  actionId: string;
  kind: FollowUpActionKind;
}

export interface FollowUpActionResult {
  ok: boolean;
  error?: string;
  proposal?: FollowUpProposalView;
}

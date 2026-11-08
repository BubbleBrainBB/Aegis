import { create } from 'zustand';
import type { FollowUpAction, FollowUpActionResult, FollowUpProposalView } from '../../shared/follow-up';

type FollowUpState = {
  proposals: Record<string, FollowUpProposalView>;
  loaded: boolean;
  load: () => Promise<void>;
  upsert: (view: FollowUpProposalView) => void;
  act: (action: Omit<FollowUpAction, 'actionId'>) => Promise<FollowUpActionResult>;
  continueWithReport: (proposalId: string) => Promise<FollowUpActionResult>;
  detach: (childSessionId: string) => Promise<FollowUpActionResult>;
};

let loading: Promise<void> | null = null;

const newer = (current: FollowUpProposalView | undefined, next: FollowUpProposalView) =>
  !current ||
  next.revision > current.revision ||
  (next.revision === current.revision && (next.updatedAt >= current.updatedAt || next.reports.length > current.reports.length));

export const useFollowUpStore = create<FollowUpState>((set, get) => ({
  proposals: {},
  loaded: false,

  load: () => {
    loading ??= window.electron.followUps
      .list()
      .then((views) =>
        set((state) => {
          const proposals = { ...state.proposals };
          for (const view of views) if (newer(proposals[view.id], view)) proposals[view.id] = view;
          return { loaded: true, proposals };
        }),
      )
      .catch(() => {
        loading = null;
      });
    return loading;
  },

  upsert: (view) =>
    set((state) => (newer(state.proposals[view.id], view) ? { proposals: { ...state.proposals, [view.id]: view } } : state)),

  act: async (action) => {
    const result = await window.electron.followUps.act({ ...action, actionId: crypto.randomUUID() });
    if (result.proposal) get().upsert(result.proposal);
    return result;
  },

  continueWithReport: async (proposalId) => {
    const result = await window.electron.followUps.continueWithReport(proposalId);
    if (result.proposal) get().upsert(result.proposal);
    return result;
  },

  detach: async (childSessionId) => {
    const result = await window.electron.followUps.detach(childSessionId);
    if (result.proposal) get().upsert(result.proposal);
    return result;
  },
}));

/** The proposal a propose_follow_up call made: by its tool_use, else by the id its result returned. */
export function findProposalForToolUse(
  proposals: Record<string, FollowUpProposalView>,
  toolUseId: string,
  resultProposalId: string | null,
): FollowUpProposalView | null {
  if (resultProposalId && proposals[resultProposalId]) return proposals[resultProposalId];
  return Object.values(proposals).find((proposal) => proposal.toolUseId === toolUseId) ?? null;
}

/** The proposal a follow-up session runs, for "from <parent>" labels. */
export function findProposalForChild(
  proposals: Record<string, FollowUpProposalView>,
  childSessionId: string,
): FollowUpProposalView | null {
  return Object.values(proposals).find((proposal) => proposal.childSessionId === childSessionId) ?? null;
}

/** Each nested session's direct parent: sessions started by another and not detached since. */
export function subSessionParents(proposals: Record<string, FollowUpProposalView>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const proposal of Object.values(proposals)) {
    if (proposal.childSessionId && proposal.detachedAt === null) parents.set(proposal.childSessionId, proposal.parentSessionId);
  }
  return parents;
}

/**
 * The top session a nested one sits under in the sidebar: sessions started by
 * a sub-session nest beside it, one level under the top.
 */
export function rootSessionOf(parents: ReadonlyMap<string, string>, sessionId: string): string | null {
  let current = parents.get(sessionId);
  if (!current) return null;
  const seen = new Set([sessionId]);
  while (parents.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current)!;
  }
  return current;
}

/** Every session nested under one, at any depth. */
export function nestedSessionIds(parents: ReadonlyMap<string, string>, sessionId: string): string[] {
  return [...parents.keys()].filter((child) => isNestedUnder(parents, child, sessionId));
}

function isNestedUnder(parents: ReadonlyMap<string, string>, sessionId: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let current = parents.get(sessionId);
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

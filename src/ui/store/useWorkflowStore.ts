import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { WorkflowAction, WorkflowActionResult, WorkflowRunView } from '../../shared/workflow';
import { CURRENT_SESSION_AGENT } from '../../shared/workflow';
import { sessionsWithActiveWorkflow } from '../utils/workflow-board';

type WorkflowState = {
  runs: Record<string, WorkflowRunView>;
  loaded: boolean;
  /**
   * Boards the user opened or folded in the chat, by run id (survives the
   * board remounting), with whether the run had ended then. A choice made
   * while it ran does not outlast the run: an ending run folds again.
   */
  expanded: Record<string, { open: boolean; ended: boolean }>;
  setExpanded: (runId: string, choice: { open: boolean; ended: boolean }) => void;
  load: () => Promise<void>;
  upsert: (view: WorkflowRunView) => void;
  act: (action: WorkflowAction) => Promise<WorkflowActionResult>;
};

let loading: Promise<void> | null = null;
/** A failed read is tried again a few times: nothing else brings in a run that started before this window opened. */
let loadRetries = 5;
const LOAD_RETRY_MS = 2_000;

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runs: {},
  loaded: false,
  expanded: {},
  setExpanded: (runId, choice) => set((state) => ({ expanded: { ...state.expanded, [runId]: choice } })),

  load: () => {
    loading ??= window.electron.workflows
      .list()
      .then((views) =>
        set((state) => ({
          loaded: true,
          runs: { ...Object.fromEntries(views.map((v) => [v.id, v])), ...state.runs },
        })),
      )
      .catch(() => {
        loading = null;
        if (loadRetries > 0) {
          loadRetries -= 1;
          setTimeout(() => void get().load(), LOAD_RETRY_MS);
        }
      });
    return loading;
  },

  upsert: (view) =>
    set((state) => {
      const current = state.runs[view.id];
      // Updates can race; never replace a newer revision with an older one.
      if (current && current.revision > view.revision) return state;
      return { runs: { ...state.runs, [view.id]: view } };
    }),

  act: async (action) => {
    const result = await window.electron.workflows.act(action);
    if (result.run) get().upsert(result.run);
    return result;
  },
}));

export { findRunForToolUse } from '../utils/workflow-board';

/**
 * The tasks whose workflow is still going, for the task lists: such a task is
 * running though its own turn has ended. Changes only when that set does, not
 * on every step of a run.
 */
export function useWorkflowRunningSessions(): ReadonlySet<string> {
  const loaded = useWorkflowStore((s) => s.loaded);
  useEffect(() => {
    // Runs reach the store as they change; one that started before this window opened has to be read.
    // A failed read retries itself (load).
    if (!loaded) void useWorkflowStore.getState().load();
  }, [loaded]);
  const ids = useWorkflowStore(useShallow((s) => sessionsWithActiveWorkflow(s.runs)));
  return useMemo(() => new Set(ids), [ids]);
}

/** Tab label for a member (or planner) session: "<Agent> · <role>" (the planner's focus text can be long, so it is left out). */
export function workflowSessionLabel(runs: Record<string, WorkflowRunView>, sessionId: string): string {
  for (const run of Object.values(runs)) {
    if (run.plannerSessionId === sessionId) return 'Workflow planner';
    // Reviewers start a fresh session every round, so look at the steps too.
    const step = run.steps.find((s) => s.sessionId === sessionId);
    const member = run.members.find(
      (m) => m.agent !== CURRENT_SESSION_AGENT && (m.currentSessionId === sessionId || m.key === step?.memberKey),
    );
    if (member) {
      const round = step?.iteration?.length ? ` · round ${step.iteration[step.iteration.length - 1] + 1}` : '';
      return `${member.agent.charAt(0).toUpperCase()}${member.agent.slice(1)} · ${step?.phase ?? member.role}${round}`;
    }
  }
  return 'Workflow member';
}

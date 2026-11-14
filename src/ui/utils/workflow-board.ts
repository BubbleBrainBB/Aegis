// What a workflow's in-chat board says about a run: its title, status word,
// steps and members. Shared by the desktop WorkflowBoard and the iPhone
// companion (apps/ios/core), so both read the same; neither draws from here.

import {
  CURRENT_SESSION_AGENT,
  type WorkflowMemberView,
  type WorkflowRunStatus,
  type WorkflowRunView,
  type WorkflowStepView,
} from '../../shared/workflow';

export const ACTIVE_RUN_STATUSES = new Set<WorkflowRunStatus>(['planning', 'running', 'pausing', 'cancelling']);
export const FINISHED_RUN_STATUSES = new Set<WorkflowRunStatus>(['succeeded', 'completed_with_gaps', 'cancelled', 'failed']);

/**
 * The chat sessions with a workflow of theirs still going, in a fixed order.
 * A run waiting on the user, paused or cut off by a restart is not going.
 */
export function sessionsWithActiveWorkflow(
  runs: Record<string, Pick<WorkflowRunView, 'status' | 'parent'>>,
): string[] {
  const ids = new Set<string>();
  for (const run of Object.values(runs)) {
    if (run.parent && ACTIVE_RUN_STATUSES.has(run.status)) ids.add(run.parent.sessionId);
  }
  return [...ids].sort();
}

export type WorkflowTone = 'success' | 'warning' | 'error' | 'muted';

export const WORKFLOW_PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  qoder: 'Qoder',
  bubble: 'Bubble',
  deepseek: 'DeepSeek',
  devin: 'Devin',
  mimo: 'MiMo Code',
  minimax: 'MiniMax Code',
};

export const NEEDS_INPUT_TITLE: Record<string, string> = {
  ask: 'A question for you',
  'plan-invalid': 'The plan could not be used',
  'repeat-exhausted': 'The review rounds ran out',
  budget: 'Agent-step limit reached',
  'interrupted-instance': 'A step was interrupted',
  'stop-step': 'The workflow stopped',
  'review-blocked': 'A reviewer could not review',
  'dispute-maintained': 'A disputed finding was kept',
  'unresolved-twice': 'A blocking finding is not getting fixed',
  'no-progress': 'A fix changed nothing',
  'workspace-drift': 'Files changed outside the workflow',
  'final-drift': 'Files changed after the last check',
  'app-restart': 'Aegis was closed during this workflow',
  'parent-moved': 'This chat moved to another folder',
  step: 'A step needs attention',
};

export const WORKFLOW_VERDICT: Record<string, { word: string; tone: Exclude<WorkflowTone, 'muted'> }> = {
  approved: { word: 'Approved', tone: 'success' },
  changes_requested: { word: 'Changes requested', tone: 'warning' },
  blocked: { word: 'Blocked', tone: 'error' },
  failed: { word: 'Failed', tone: 'error' },
};

/** What the drift reasons ask, in place of their technical detail. */
export const DRIFT_EXPLANATION =
  'Files no longer match the version the workflow expected. Using the current files continues with those edits included; they will be checked and reviewed too.';

/** The run fields the board reads; the phone gets these without the workflow definition. */
export type WorkflowBoardRun = Pick<
  WorkflowRunView,
  'id' | 'title' | 'description' | 'status' | 'updatedAt' | 'members' | 'steps' | 'parent'
>;

/** The run id the start_workflow tool returned, when its result is in. */
export function parseWorkflowRunId(resultText: string | null | undefined): string | null {
  if (!resultText) return null;
  try {
    const value = JSON.parse(resultText) as { workflowId?: unknown };
    return typeof value.workflowId === 'string' ? value.workflowId : null;
  } catch {
    return null;
  }
}

/** The run a chat session started with this start_workflow tool call. */
export function findRunForToolUse<T extends Pick<WorkflowRunView, 'id' | 'parent'>>(
  runs: Record<string, T> | T[],
  toolUseId: string,
  resultRunId: string | null,
): T | null {
  const list = Array.isArray(runs) ? runs : Object.values(runs);
  if (resultRunId) {
    const byId = Array.isArray(runs) ? list.find((run) => run.id === resultRunId) : runs[resultRunId];
    if (byId) return byId;
  }
  return list.find((run) => run.parent?.toolUseId === toolUseId) ?? null;
}

/** A run folds to its header line once it ends; a failure keeps its error line. */
export function workflowOpenByDefault(run: Pick<WorkflowRunView, 'status'>): boolean {
  return !FINISHED_RUN_STATUSES.has(run.status);
}

/**
 * The planner names each workflow in a few words; the description and the
 * request are sentences, so they go in the tooltip. Built-in templates carry
 * an id for a name, which is no title.
 */
export function workflowRunTitle(run: Pick<WorkflowRunView, 'title' | 'description'>, specName: string | null | undefined): string {
  const name = specName?.trim();
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return name;
  return run.description || run.title;
}

/** The header's status word for a run: what it is doing. */
export function workflowStatusLabel(
  run: Pick<WorkflowRunView, 'status'>,
  lanes: WorkflowStepView[],
): { word: string; tone: WorkflowTone; spinning: boolean } {
  const done = lanes.filter((s) => s.state === 'succeeded' || s.state === 'failed').length;
  const [word, tone, spinning]: [string, WorkflowTone, boolean] = (() => {
    switch (run.status) {
      case 'planning':
        return ['Planning', 'muted', true];
      case 'awaiting_confirmation':
        return ['Waiting for you', 'warning', false];
      case 'running':
        return [lanes.length > 0 ? `${done} of ${lanes.length}` : 'Running', 'muted', true];
      case 'pausing':
        return ['Pausing', 'muted', true];
      case 'paused':
        return ['Paused', 'muted', false];
      case 'needs_input':
        return ['Needs you', 'warning', false];
      case 'interrupted':
        return ['Interrupted', 'warning', false];
      case 'cancelling':
        return ['Stopping', 'muted', true];
      case 'cancelled':
        return ['Stopped', 'muted', false];
      case 'succeeded':
        return [finalVerdictApproved(lanes) ? 'Approved' : 'Done', 'success', false];
      case 'completed_with_gaps':
        return ['Done with open items', 'warning', false];
      case 'failed':
        return ['Failed', 'error', false];
    }
  })();
  return { word, tone, spinning };
}

/** Whether the header shows the run's time: not while it is planned or waiting to start. */
export function workflowShowsTime(run: Pick<WorkflowRunView, 'status'>): boolean {
  return run.status !== 'planning' && run.status !== 'awaiting_confirmation';
}

/** Whether the run ended on approving reviews (each reviewer's latest round), so the header can say so. */
export function finalVerdictApproved(lanes: WorkflowStepView[]): boolean {
  const latest = new Map<string, WorkflowStepView>();
  for (const step of lanes) {
    if (step.kind !== 'agent' || step.verdict === null) continue;
    const key = step.memberKey ?? step.stepId;
    const seen = latest.get(key);
    if (!seen || (step.endedAt ?? 0) >= (seen.endedAt ?? 0)) latest.set(key, step);
  }
  return latest.size > 0 && [...latest.values()].every((s) => s.verdict === 'approved');
}

/**
 * From the first step's start to the last step's end; `end` is null while
 * the run goes on (count to now). Null when that is not known: runs from
 * before steps were timed, or a step that Aegis closed under, whose end
 * nobody recorded.
 */
export function workflowTimeSpan(
  run: Pick<WorkflowRunView, 'status' | 'steps' | 'updatedAt'>,
): { start: number; end: number | null } | null {
  const starts = run.steps.map((s) => s.startedAt).filter((t): t is number => t !== null);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  if (ACTIVE_RUN_STATUSES.has(run.status) || run.steps.some((s) => s.state === 'running')) return { start, end: null };
  if (run.steps.some((s) => s.startedAt !== null && s.endedAt === null)) return null;
  const ends = run.steps.map((s) => s.endedAt).filter((t): t is number => t !== null);
  return { start, end: ends.length > 0 ? Math.max(...ends) : run.updatedAt };
}

export function workflowElapsed(run: Pick<WorkflowRunView, 'status' | 'steps' | 'updatedAt'>, now: number): number | null {
  const span = workflowTimeSpan(run);
  return span ? (span.end ?? now) - span.start : null;
}

/** Agent and check steps that have run or are coming up; skipped and, once finished, unreached steps are left out. */
export function workflowLaneSteps(run: Pick<WorkflowRunView, 'status' | 'steps'>): WorkflowStepView[] {
  return run.steps.filter(
    (step) =>
      (step.kind === 'agent' || step.kind === 'check') &&
      step.state !== 'skipped' &&
      !(
        step.state === 'pending' &&
        (FINISHED_RUN_STATUSES.has(run.status) || run.status === 'awaiting_confirmation' || run.status === 'planning')
      ),
  );
}

export function workflowHasRounds(lanes: WorkflowStepView[]): boolean {
  return lanes.some((s) => (s.iteration?.[s.iteration.length - 1] ?? 0) > 0);
}

/**
 * A member's short name and what tells it apart: the pinned model, the
 * effort, and the member key only when two members share all of those. The
 * planner's focus text can be a whole instruction, so it goes in tooltips.
 */
export function workflowMemberParts(member: WorkflowMemberView, members: WorkflowMemberView[]): { name: string; detail: string[] } {
  if (member.agent === CURRENT_SESSION_AGENT) return { name: 'This chat', detail: [] };
  const shared = members.some(
    (m) =>
      m.key !== member.key &&
      m.provider === member.provider &&
      m.model === member.model &&
      (m.effort ?? null) === (member.effort ?? null) &&
      m.agent !== CURRENT_SESSION_AGENT,
  );
  return {
    name: WORKFLOW_PROVIDER_LABEL[member.provider] ?? member.agent,
    detail: [member.model ? member.modelLabel ?? member.model : null, member.effort, shared ? member.key : null].filter(
      (part): part is string => Boolean(part),
    ),
  };
}

export function workflowMemberRole(member: WorkflowMemberView): string {
  if (member.role === 'implementer') return 'writes code';
  if (member.role === 'reviewer') return 'reviewer, read-only';
  return 'advisor, read-only';
}

/**
 * A step's line: "<member> · <what>", with the round when the run repeats.
 * `sessionId` is the session it opens; the chat's own turns are already in
 * the conversation, so a step of "This chat" opens nothing.
 */
export function workflowStepLine(
  step: WorkflowStepView,
  member: WorkflowMemberView | undefined,
  members: WorkflowMemberView[],
  showRound: boolean,
): { title: string; detail: string[]; sessionId: string | null } {
  const round = step.iteration ? step.iteration[step.iteration.length - 1] + 1 : null;
  // Agent step labels read "<member> · <output>"; the line names the member itself.
  const what = step.kind === 'check' ? step.label : step.phase ?? step.label.split(' · ').pop() ?? step.label;
  const parts = member ? workflowMemberParts(member, members) : null;
  return {
    title: `${parts ? `${parts.name} · ${what}` : what}${showRound && round ? ` · round ${round}` : ''}`,
    detail: parts?.detail ?? [],
    sessionId: member?.agent === CURRENT_SESSION_AGENT ? null : step.sessionId,
  };
}

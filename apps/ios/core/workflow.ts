// The in-chat workflow board for the phone: what the desktop WorkflowBoard
// shows, from the same helpers (src/ui/utils/workflow-board), as plain data.
// Times stay as timestamps so Swift can keep a running clock without a re-render.
import type { RemoteWorkflow } from "../../../src/shared/remote/protocol";
import { CURRENT_SESSION_AGENT } from "../../../src/shared/workflow";
import {
  ACTIVE_RUN_STATUSES,
  DRIFT_EXPLANATION,
  NEEDS_INPUT_TITLE,
  WORKFLOW_VERDICT,
  findRunForToolUse,
  parseWorkflowRunId,
  workflowHasRounds,
  workflowLaneSteps,
  workflowMemberParts,
  workflowMemberRole,
  workflowOpenByDefault,
  workflowRunTitle,
  workflowShowsTime,
  workflowStatusLabel,
  workflowStepLine,
  workflowTimeSpan,
  type WorkflowTone,
} from "../../../src/ui/utils/workflow-board";

/** What the board needs besides the session's own messages. */
export interface WorkflowContext {
  /** The Mac's workflows (RemoteState.workflows). */
  workflows: RemoteWorkflow[];
  /** Pending approvals per session, for "Needs approval" on a member's step. */
  approvals: Record<string, number>;
}

export const NO_WORKFLOWS: WorkflowContext = { workflows: [], approvals: {} };

export interface WorkflowStep {
  key: string;
  title: string;
  /** Model, effort; what tells two members apart. */
  detail: string;
  provider: string | null;
  state: "pending" | "running" | "succeeded" | "failed" | "skipped" | "needs_input";
  /** The member session the step opens; null for checks and this chat's own turns. */
  sessionId: string | null;
  start: number | null;
  end: number | null;
  verdict: { word: string; tone: WorkflowTone } | null;
  approvals: number;
  summary: string | null;
}

export interface WorkflowBoard {
  /** The start_workflow call's id: stable while the run comes and goes. */
  id: string;
  runId: string | null;
  /** "failed": the tool refused; "starting": no run yet; "run": the run below. */
  phase: "failed" | "starting" | "run";
  failure: string | null;
  title: string;
  status: { word: string; tone: WorkflowTone; spinning: boolean };
  /** The header's clock; `end` null counts to now. */
  time: { start: number; end: number | null } | null;
  revision: number;
  canStop: boolean;
  open: boolean;
  /** The planner while it plans; its session, when there is one, opens from the line. */
  planning: { sessionId: string | null } | null;
  assumptions: string[];
  steps: WorkflowStep[];
  outcome: { id: string; text: string; status: "met" | "waived" | "unmet" | "open" }[];
  plan: {
    members: { key: string; provider: string; name: string; detail: string; note: string | null }[];
    checks: { text: string; highlight: boolean }[];
    unsupported: string[];
    assumptions: string[];
  } | null;
  needs: {
    title: string;
    question: string | null;
    detail: string | null;
    /** `answer`: "option" sends the option id, "text" sends its label (as the desktop does for questions). */
    options: { id: string; label: string; answer: "option" | "text" }[];
    freeText: boolean;
  } | null;
  error: string | null;
}

const EMPTY = {
  status: { word: "", tone: "muted" as const, spinning: false },
  time: null,
  revision: 0,
  canStop: false,
  open: false,
  planning: null,
  assumptions: [],
  steps: [],
  outcome: [],
  plan: null,
  needs: null,
  error: null,
};

export function workflowBoard(
  toolUseId: string,
  resultText: string | null,
  failed: boolean,
  context: WorkflowContext,
): WorkflowBoard {
  if (failed)
    return {
      ...EMPTY,
      id: toolUseId,
      runId: null,
      phase: "failed",
      failure: `Workflow could not start${resultText ? `: ${resultText}` : ""}`,
      title: "Workflow",
    };
  const runId = parseWorkflowRunId(resultText);
  const run = findRunForToolUse(context.workflows, toolUseId, runId);
  if (!run) return { ...EMPTY, id: toolUseId, runId, phase: "starting", failure: null, title: "Starting workflow…" };

  const members = new Map(run.members.map((m) => [m.key, m]));
  const lanes = workflowLaneSteps(run);
  const showRound = workflowHasRounds(lanes);
  const span = workflowTimeSpan(run);
  const steps = lanes.map((step): WorkflowStep => {
    const member = step.memberKey ? members.get(step.memberKey) : undefined;
    const line = workflowStepLine(step, member, run.members, showRound);
    return {
      key: step.key,
      title: line.title,
      detail: line.detail.join(" · "),
      provider: member?.provider ?? null,
      state: step.state,
      sessionId: line.sessionId,
      start: step.startedAt,
      end: step.endedAt,
      verdict: step.verdict ? WORKFLOW_VERDICT[step.verdict] ?? null : null,
      approvals: line.sessionId ? context.approvals[line.sessionId] ?? 0 : 0,
      summary: step.summary,
    };
  });
  const needs = run.needsInput && (run.status === "needs_input" || run.status === "interrupted") ? run.needsInput : null;
  const drift = needs?.reason === "workspace-drift" || needs?.reason === "final-drift";
  const finished = run.status === "succeeded" || run.status === "completed_with_gaps";
  return {
    id: toolUseId,
    runId: run.id,
    phase: "run",
    failure: null,
    title: workflowRunTitle(run, run.name),
    status: workflowStatusLabel(run, lanes),
    time: span && workflowShowsTime(run) ? span : null,
    revision: run.revision,
    canStop: ACTIVE_RUN_STATUSES.has(run.status) && run.status !== "cancelling",
    open: workflowOpenByDefault(run),
    planning: run.status === "planning" ? { sessionId: run.plannerSessionId } : null,
    assumptions: run.status !== "awaiting_confirmation" && run.status !== "planning" ? run.assumptions : [],
    steps,
    outcome: finished
      ? [
          ...run.acceptance.map((a) => ({
            id: a.id,
            text: a.description,
            status: a.status === "satisfied" ? ("met" as const) : a.status === "waived" ? ("waived" as const) : ("unmet" as const),
          })),
          ...run.unsupported.map((text, i) => ({ id: `unsupported-${i}`, text, status: "open" as const })),
        ]
      : [],
    plan:
      run.status === "awaiting_confirmation"
        ? {
            members: run.members
              .filter((m) => m.agent !== CURRENT_SESSION_AGENT)
              .map((m) => {
                const parts = workflowMemberParts(m, run.members);
                const notes = [m.source === "inferred" ? "suggested" : null, m.unverified ? "not yet conformance-tested" : null].filter(Boolean);
                return {
                  key: m.key,
                  provider: m.provider,
                  name: parts.name,
                  detail: [...parts.detail, workflowMemberRole(m)].join(" · "),
                  note: notes.length ? notes.join(" · ") : null,
                };
              }),
            checks: run.checks.map((c) => ({ text: c.argv.join(" "), highlight: c.highlight })),
            unsupported: run.unsupported,
            assumptions: run.assumptions,
          }
        : null,
    needs: needs
      ? {
          title: NEEDS_INPUT_TITLE[needs.reason] ?? "The workflow needs you",
          question: needs.question,
          detail: drift ? DRIFT_EXPLANATION : needs.detail,
          options: needs.options.map((o) => ({ id: o.id, label: o.label, answer: needs.reason === "ask" ? ("text" as const) : ("option" as const) })),
          freeText: needs.reason === "ask" && needs.options.length === 0,
        }
      : null,
    error: run.status === "failed" ? run.error : null,
  };
}

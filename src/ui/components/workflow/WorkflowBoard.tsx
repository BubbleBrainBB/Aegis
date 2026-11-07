// In-chat view of a workflow a chat session started with start_workflow
// (docs/collaboration/README.md §8). It sits in the conversation where the
// tool was called and reads like the agent's own trace: a header line with
// the run's title and status, and its steps nested under it as trace lines.
// Each step opens that member's session in the right panel. Only the plan
// and the questions that need the user get a box.

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { AgentProvider } from '../../types';
import {
  CURRENT_SESSION_AGENT,
  type WorkflowAction,
  type WorkflowMemberView,
  type WorkflowRunView,
  type WorkflowStepView,
} from '../../../shared/workflow';
import { useAppStore } from '../../store/useAppStore';
import { findRunForToolUse, useWorkflowStore } from '../../store/useWorkflowStore';
import { formatDurationLabel } from '../../utils/format-duration';
import {
  ACTIVE_RUN_STATUSES as ACTIVE,
  DRIFT_EXPLANATION,
  FINISHED_RUN_STATUSES as FINISHED,
  NEEDS_INPUT_TITLE as NEEDS_TITLE,
  WORKFLOW_VERDICT as VERDICT,
  parseWorkflowRunId as parseRunId,
  workflowElapsed as runElapsed,
  workflowHasRounds as hasRounds,
  workflowLaneSteps as laneSteps,
  workflowMemberParts as memberParts,
  workflowMemberRole as memberRole,
  workflowOpenByDefault as openByDefault,
  workflowRunTitle,
  workflowShowsTime,
  workflowStatusLabel,
  workflowStepLine,
} from '../../utils/workflow-board';
import { ProviderIcon } from '../AgentModelPicker';
import { TraceChevron, TraceLine, TraceNest, TraceSpinner } from '../TraceLine';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Play,
  ShieldAlert,
  Terminal,
  Workflow,
  X,
} from '../icons';
import { cn } from '../../utils/cn';

const TONE_CLASS = {
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--error)]',
  muted: '',
} as const;

const buttonClass =
  'inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:opacity-50';
const primaryButtonClass =
  'inline-flex h-7 items-center gap-1 rounded-md bg-[var(--text-primary)] px-2.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50';

export function WorkflowBoard({
  toolUseId,
  resultText,
  failed,
}: {
  toolUseId: string;
  resultText: string | null;
  failed: boolean;
}) {
  const runId = parseRunId(resultText);
  const run = useWorkflowStore((s) => findRunForToolUse(s.runs, toolUseId, runId));
  const loaded = useWorkflowStore((s) => s.loaded);
  useEffect(() => {
    if (!run && !loaded) void useWorkflowStore.getState().load();
  }, [run, loaded]);

  if (failed) {
    return (
      <div className="my-1.5 flex items-start gap-[7px] text-[13px] leading-[22px] text-[var(--text-secondary)]">
        <Workflow className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-[var(--error)]" />
        <span className="min-w-0 break-words">Workflow could not start{resultText ? `: ${resultText}` : ''}</span>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="my-1.5 flex items-center gap-[7px] text-[13px] leading-[22px] text-[var(--text-muted)]">
        <Workflow className="h-3.5 w-3.5 flex-shrink-0" />
        Starting workflow…
        <LoaderCircle className="h-3 w-3 animate-spin" />
      </div>
    );
  }
  return <RunBoard run={run} />;
}

/** Re-renders once a second while `active`, for elapsed times. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function RunBoard({ run }: { run: WorkflowRunView }) {
  const [busy, setBusy] = useState(false);
  const perform = async (action: WorkflowAction) => {
    setBusy(true);
    try {
      const result = await useWorkflowStore.getState().act(action);
      if (!result.ok) toast.error(result.error);
    } finally {
      setBusy(false);
    }
  };
  const ended = FINISHED.has(run.status);
  const choice = useWorkflowStore((s) => s.expanded[run.id]);
  const collapsed = !(choice && choice.ended === ended ? choice.open : openByDefault(run));
  const toggleCollapsed = () => useWorkflowStore.getState().setExpanded(run.id, { open: collapsed, ended });
  const members = new Map(run.members.map((m) => [m.key, m]));
  const lanes = laneSteps(run);
  const ticking = ACTIVE.has(run.status) || lanes.some((s) => s.state === 'running');
  const now = useNow(ticking);
  const canStop = ACTIVE.has(run.status) && run.status !== 'cancelling';

  // What the user must act on stays visible even when the steps are folded.
  const action =
    run.status === 'awaiting_confirmation' ? (
      <PlanBox run={run} busy={busy} perform={perform} />
    ) : run.needsInput && (run.status === 'needs_input' || run.status === 'interrupted') ? (
      <NeedsInputBox run={run} busy={busy} perform={perform} />
    ) : null;
  const error = run.status === 'failed' && run.error ? <ErrorLine text={run.error} /> : null;

  return (
    <div className="my-1.5 min-w-0" data-workflow-board={run.id}>
      <div className="flex min-w-0 cursor-pointer items-center gap-[7px] text-[13px] leading-[22px]" onClick={toggleCollapsed}>
        <Workflow className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <span
          className="min-w-0 truncate font-medium text-[var(--text-primary)]"
          title={[run.description, run.goal].filter(Boolean).join('\n\n')}
        >
          {runTitle(run)}
        </span>
        <RunStatus run={run} lanes={lanes} now={now} />
        {canStop ? (
          <button
            type="button"
            className="flex-shrink-0 rounded-[5px] bg-[var(--bg-secondary)] px-1.5 text-[12px] leading-5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            title="Stop the workflow"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void perform({ type: 'cancel', runId: run.id, expectedRevision: run.revision });
            }}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          title={collapsed ? 'Show steps' : 'Hide steps'}
          aria-label={collapsed ? 'Show steps' : 'Hide steps'}
          aria-expanded={!collapsed}
          data-workflow-toggle
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapsed();
          }}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', collapsed && '-rotate-90')} />
        </button>
      </div>

      {collapsed && !action && !error ? null : (
        <TraceNest className="mt-0.5">
          {collapsed ? null : (
            <>
              {run.status === 'planning' ? (
                <TraceLine
                  icon={<Workflow />}
                  title="Planning the workflow"
                  tone="active"
                  trail={<TraceSpinner />}
                  disabled={!run.plannerSessionId}
                  onClick={() => run.plannerSessionId && useAppStore.getState().openWorkflowMemberPanel(run.plannerSessionId)}
                />
              ) : null}
              {/* What the plan took for granted comes first; the outcome closes the list. */}
              {run.status !== 'awaiting_confirmation' && run.status !== 'planning' && run.assumptions.length > 0 ? (
                <Assumptions assumptions={run.assumptions} />
              ) : null}
              {lanes.map((step) => (
                <StepLine
                  key={step.key}
                  step={step}
                  member={step.memberKey ? members.get(step.memberKey) : undefined}
                  members={run.members}
                  showRound={hasRounds(lanes)}
                  now={now}
                />
              ))}
              {run.status === 'succeeded' || run.status === 'completed_with_gaps' ? <Outcome run={run} /> : null}
            </>
          )}
          {action}
          {error}
        </TraceNest>
      )}
    </div>
  );
}

function runTitle(run: WorkflowRunView): string {
  return workflowRunTitle(run, run.spec?.name);
}

/** The header's right side: what the run is doing, and for how long. */
function RunStatus({ run, lanes, now }: { run: WorkflowRunView; lanes: WorkflowStepView[]; now: number }) {
  const elapsed = formatDurationLabel(runElapsed(run, now));
  const { word, tone, spinning } = workflowStatusLabel(run, lanes);
  const showTime = elapsed && workflowShowsTime(run);
  return (
    <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] tabular-nums text-[var(--text-muted)]">
      {spinning ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
      <span className={TONE_CLASS[tone]} data-workflow-status>{word}</span>
      {showTime ? <span>· {elapsed}</span> : null}
    </span>
  );
}

function StepLine({
  step,
  member,
  members,
  showRound,
  now,
}: {
  step: WorkflowStepView;
  member?: WorkflowMemberView;
  members: WorkflowMemberView[];
  showRound: boolean;
  now: number;
}) {
  const { title, detail, sessionId } = workflowStepLine(step, member, members, showRound);
  const approvals = useAppStore((s) => (sessionId ? s.sessions[sessionId]?.permissionRequests?.length ?? 0 : 0));
  const end = step.state === 'running' ? now : step.endedAt;
  const duration = step.startedAt === null || end === null ? null : formatDurationLabel(end - step.startedAt);
  const verdict = step.verdict ? VERDICT[step.verdict] : undefined;
  return (
    <TraceLine
      icon={member ? <ProviderIcon provider={member.provider as AgentProvider} /> : <Terminal />}
      title={title}
      meta={detail.length > 0 ? <span>{detail.join(' · ')}</span> : undefined}
      aside={
        <>
          {approvals > 0 ? (
            <span className="inline-flex items-center gap-1 text-[var(--warning)]">
              <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Needs approval
            </span>
          ) : null}
          {step.state === 'pending' ? <span>Waiting</span> : null}
          {step.state === 'needs_input' ? <span className="text-[var(--warning)]">Needs you</span> : null}
          {duration && step.state !== 'pending' ? <span>{duration}</span> : null}
          {verdict ? (
            <span className={TONE_CLASS[verdict.tone]}>{verdict.word}</span>
          ) : step.state === 'failed' ? (
            <span className={TONE_CLASS.error}>Failed</span>
          ) : null}
          {/* The glyph sits in the aside so it stays at the line's end even without a time. */}
          {step.state === 'running' ? (
            <span className="trace-line-trail" aria-hidden="true">
              <TraceSpinner />
            </span>
          ) : step.state === 'succeeded' && !verdict ? (
            <span className="trace-line-trail" aria-hidden="true">
              <Check className="text-[var(--success)]" />
            </span>
          ) : null}
        </>
      }
      tone={step.state === 'running' ? 'active' : step.state === 'needs_input' ? 'waiting' : step.state === 'failed' ? 'error' : 'default'}
      hint={[title, member?.focus, step.summary].filter(Boolean).join('\n')}
      disabled={!sessionId}
      onClick={() => sessionId && useAppStore.getState().openWorkflowMemberPanel(sessionId)}
      className={step.state === 'pending' ? 'opacity-55' : undefined}
    />
  );
}

/** A line whose text wraps instead of truncating: outcomes and errors. */
function WrapLine({ icon, children, aside }: { icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 py-0.5 text-[12px] leading-5">
      <span className="mt-[3px] inline-flex h-3.5 w-3.5 flex-shrink-0 [&>*]:h-full [&>*]:w-full" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {aside}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="text-[var(--text-primary)]">
      <WrapLine icon={<CircleX className="text-[var(--error)]" />}>{text}</WrapLine>
    </div>
  );
}

/** Assumptions do not stop the run; they stay available behind one line. */
function Assumptions({ assumptions }: { assumptions: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TraceLine
        icon={<TraceChevron expanded={open} />}
        title={`${assumptions.length} ${assumptions.length === 1 ? 'assumption' : 'assumptions'}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <ul className="mb-1 ml-5 list-disc space-y-0.5 text-[12px] leading-5 text-[var(--text-secondary)]">
          {assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

type Perform = (action: WorkflowAction) => Promise<void>;

/** The only boxed part of a run: something the user has to decide. */
function ActionBox({ children }: { children: ReactNode }) {
  return (
    <div className="my-1 flex flex-col gap-2 rounded-[9px] border border-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] bg-[var(--bg-primary)] px-3 py-2.5 text-[12.5px] leading-5 text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

function PlanBox({ run, busy, perform }: { run: WorkflowRunView; busy: boolean; perform: Perform }) {
  const [showSpec, setShowSpec] = useState(false);
  return (
    <ActionBox>
      <div className="text-[13px] font-medium text-[var(--text-primary)]">Start this workflow?</div>
      <ul className="flex flex-col gap-1">
        {run.members
          .filter((m) => m.agent !== CURRENT_SESSION_AGENT)
          .map((m) => {
            const parts = memberParts(m, run.members);
            return (
              <li key={m.key} className="flex min-w-0 items-center gap-1.5">
                <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center [&>*]:h-full [&>*]:w-full">
                  <ProviderIcon provider={m.provider as AgentProvider} />
                </span>
                <span className="font-medium text-[var(--text-primary)]" title={m.focus ?? undefined}>
                  {parts.name}
                </span>
                <span className="min-w-0 truncate">{[...parts.detail, memberRole(m)].join(' · ')}</span>
                {m.source === 'inferred' ? <span className="flex-shrink-0 text-[var(--text-muted)]">· suggested</span> : null}
                {m.unverified ? <span className="flex-shrink-0 text-[var(--text-muted)]">· not yet conformance-tested</span> : null}
              </li>
            );
          })}
      </ul>
      {run.checks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>Runs</span>
          {run.checks.map((c) => (
            <code
              key={c.stepId}
              className={cn(
                'rounded px-1.5 font-mono text-[11.5px] text-[var(--text-primary)]',
                c.highlight ? 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)]' : 'bg-[var(--bg-tertiary)]',
              )}
              title={c.reasons.join(', ') || undefined}
            >
              {c.argv.join(' ')}
            </code>
          ))}
        </div>
      ) : null}
      {run.unsupported.length > 0 ? (
        <div className="flex items-start gap-1.5 text-[var(--text-primary)]">
          <AlertTriangle className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-[var(--warning)]" />
          <span>Not covered: {run.unsupported.join('; ')}</span>
        </div>
      ) : null}
      {run.assumptions.length > 0 ? <div>Assumes: {run.assumptions.join('; ')}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy}
          onClick={() => void perform({ type: 'confirm', runId: run.id, expectedRevision: run.revision })}
        >
          <Play className="h-3 w-3" /> Start
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void perform({ type: 'cancel', runId: run.id, expectedRevision: run.revision })}
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        {run.checks.length > 0 ? <span className="text-[11.5px] text-[var(--text-muted)]">Starting approves these commands for this run.</span> : null}
        {run.spec ? (
          <button
            type="button"
            className="ml-auto flex-shrink-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-expanded={showSpec}
            onClick={() => setShowSpec((value) => !value)}
          >
            Workflow JSON
          </button>
        ) : null}
      </div>
      {showSpec && run.spec ? (
        <pre className="max-h-64 overflow-auto rounded bg-[var(--bg-tertiary)] p-2 font-mono text-[10.5px] leading-4 text-[var(--text-primary)]">
          {JSON.stringify(run.spec, null, 2)}
        </pre>
      ) : null}
    </ActionBox>
  );
}

function NeedsInputBox({ run, busy, perform }: { run: WorkflowRunView; busy: boolean; perform: Perform }) {
  const needs = run.needsInput!;
  const [text, setText] = useState('');
  const drift = needs.reason === 'workspace-drift' || needs.reason === 'final-drift';
  return (
    <ActionBox>
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
        <AlertTriangle className="h-3.5 w-3.5 text-[var(--warning)]" />
        {NEEDS_TITLE[needs.reason] ?? 'The workflow needs you'}
      </div>
      {needs.question ? <div className="text-[var(--text-primary)]">{needs.question}</div> : null}
      {drift ? (
        <div>{DRIFT_EXPLANATION}</div>
      ) : needs.detail ? (
        <div className="whitespace-pre-wrap break-words">{needs.detail}</div>
      ) : null}
      {needs.reason === 'ask' && needs.options.length === 0 ? (
        <div className="flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[12px] text-[var(--text-primary)]"
          />
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy || !text.trim()}
            onClick={() => void perform({ type: 'answer', runId: run.id, expectedRevision: run.revision, text })}
          >
            Answer
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {needs.options.map((o, index) => (
            <button
              key={o.id}
              type="button"
              className={index === 0 ? primaryButtonClass : buttonClass}
              disabled={busy}
              onClick={() =>
                void perform(
                  needs.reason === 'ask'
                    ? { type: 'answer', runId: run.id, expectedRevision: run.revision, text: o.label }
                    : { type: 'answer', runId: run.id, expectedRevision: run.revision, optionId: o.id },
                )
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </ActionBox>
  );
}

/**
 * What the run was asked to achieve and whether the agents confirmed it, then
 * what it did not cover: wrapped, never cut off. Nothing here asks the user to
 * confirm anything; the chat reports what is still open.
 */
function Outcome({ run }: { run: WorkflowRunView }) {
  if (run.acceptance.length === 0 && run.unsupported.length === 0) return null;
  return (
    <div className="text-[var(--text-primary)]" data-workflow-outcome>
      {run.acceptance.map((a) => (
        <WrapLine
          key={a.id}
          icon={
            a.status === 'satisfied' ? (
              <Check className="text-[var(--success)]" />
            ) : a.status === 'waived' ? (
              <CircleDashed className="text-[var(--text-muted)]" />
            ) : (
              <CircleX className="text-[var(--error)]" />
            )
          }
          aside={
            a.status === 'waived' ? (
              <span className="flex-shrink-0 text-[var(--text-muted)]">Waived</span>
            ) : a.status !== 'satisfied' ? (
              <span className="flex-shrink-0 text-[var(--error)]">Not met</span>
            ) : undefined
          }
        >
          {a.description}
        </WrapLine>
      ))}
      {run.unsupported.map((item) => (
        <WrapLine key={item} icon={<CircleDashed className="text-[var(--text-muted)]" />}>
          <span className="text-[var(--text-secondary)]" title="Not covered by the workflow">
            {item}
          </span>
        </WrapLine>
      ))}
    </div>
  );
}

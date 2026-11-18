// Workflows that wait to be started, in the main bot's conversation. A task
// the bot handed work to can prepare a workflow that runs only once the person
// says so; its own card sits in that task. Here the same question is asked
// under the bot's last word, in short: what would run, who does what, Start
// and Cancel. Details unfolds it into the card as the task itself draws it
// (WorkflowPlanBoard), so the full question reads the same in both places.
//
// Pressing a button is the person's own answer, so it goes straight to Aegis
// (which also sets what the bot waits for), not through a turn of the bot. The
// card then gives way to one line saying what was done, until the conversation
// moves on; from there the task's chip and its report say how it stands.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { CONFIRM_WORKFLOW_TOOL } from '../../../shared/main-bot';
import { CURRENT_SESSION_AGENT, type WorkflowAction, type WorkflowRunView } from '../../../shared/workflow';
import { useAppStore } from '../../store/useAppStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import type { AgentProvider } from '../../types';
import { cn } from '../../utils/cn';
import { openTaskBeside } from '../../utils/task-state';
import { workflowMemberParts, workflowMemberRole, workflowRunTitle, workflowStatusLabel } from '../../utils/workflow-board';
import { ProviderIcon } from '../AgentModelPicker';
import { AlertTriangle, ChevronDown, Play, Workflow, X } from '../icons';
import { WorkflowPlanBoard, workflowButtonClass, workflowPrimaryButtonClass } from '../workflow/WorkflowBoard';
import { MainBotTaskLine } from './MainBotTaskLine';

type Decided = { sessionId: string; start: boolean; title: string; messageCount: number };

/** What the person answered from a card, by run: shown as a line until the conversation moves on. */
const useDecided = create<{ byRun: Record<string, Decided>; set: (runId: string, decided: Decided) => void }>((set) => ({
  byRun: {},
  set: (runId, decided) => set((state) => ({ byRun: { ...state.byRun, [runId]: decided } })),
}));

/** The waiting runs of chat sessions, oldest first: the order they were asked in. */
function waitingRuns(runs: Record<string, WorkflowRunView>): WorkflowRunView[] {
  return Object.values(runs)
    .filter((run) => run.status === 'awaiting_confirmation' && run.parent)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function MainBotWorkflowCards({ messageCount }: { messageCount: number }) {
  const loaded = useWorkflowStore((state) => state.loaded);
  useEffect(() => {
    if (!loaded) void useWorkflowStore.getState().load();
  }, [loaded]);
  const waiting = useWorkflowStore(useShallow((state) => waitingRuns(state.runs)));
  const decided = useDecided((state) => state.byRun);

  // Which of them belong to tasks the bot handed work to: asked again when
  // the set of waiting runs changes, or the conversation does (a task the bot
  // has just written to counts from then on).
  const waitingKey = waiting.map((run) => run.id).join(' ');
  const [tasks, setTasks] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!waitingKey) {
      setTasks(new Set());
      return;
    }
    let stale = false;
    void window.electron
      .mainBotWorkflowCards?.()
      .then((ids) => {
        if (!stale) setTasks(new Set(ids));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [waitingKey, messageCount]);

  const cards = useMemo(() => waiting.filter((run) => tasks.has(run.parent!.sessionId)), [waiting, tasks]);
  const lines = useMemo(
    () => Object.entries(decided).filter(([runId, entry]) => entry.messageCount === messageCount && !cards.some((run) => run.id === runId)),
    [decided, messageCount, cards]
  );
  if (cards.length === 0 && lines.length === 0) return null;

  return (
    <div className="my-2 flex flex-col gap-2" data-main-bot-workflow-cards>
      {lines.map(([runId, entry]) => (
        <MainBotTaskLine
          key={runId}
          toolName={CONFIRM_WORKFLOW_TOOL}
          input={{ task: entry.title, decision: entry.start ? 'start' : 'cancel' }}
          resultText={JSON.stringify({ sessionId: entry.sessionId, title: entry.title })}
          failed={false}
          pending={false}
        />
      ))}
      {cards.map((run) => (
        <WorkflowCard key={run.id} run={run} messageCount={messageCount} />
      ))}
    </div>
  );
}

function WorkflowCard({ run, messageCount }: { run: WorkflowRunView; messageCount: number }) {
  const sessionId = run.parent!.sessionId;
  const taskTitle = useAppStore((state) => state.sessions[sessionId]?.title ?? '');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const title = workflowRunTitle(run, run.spec?.name);
  const members = run.members.filter((member) => member.agent !== CURRENT_SESSION_AGENT);

  const decide = async (start: boolean) => {
    setBusy(true);
    try {
      const done = await window.electron.decideMainBotWorkflow(sessionId, start);
      if (!done.ok) {
        toast.error(done.error);
        return;
      }
      useDecided.getState().set(run.id, { sessionId, start, title: taskTitle || title, messageCount });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not answer the workflow');
    } finally {
      setBusy(false);
    }
  };

  // Unfolded: the task's own card, word for word; its buttons answer the same way.
  if (open) {
    return (
      <div data-main-bot-workflow-card={run.id} data-main-bot-workflow-open>
        <WorkflowPlanBoard
          run={run}
          busy={busy}
          perform={(action: WorkflowAction) => decide(action.type === 'confirm')}
          onFold={() => setOpen(false)}
        />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[9px] border border-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] bg-[var(--bg-primary)] px-3.5 py-3 text-[12.5px] leading-5 text-[var(--text-secondary)]"
      data-main-bot-workflow-card={run.id}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Workflow className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--text-primary)] hover:underline"
          title={taskTitle ? `Open ${taskTitle}` : undefined}
          onClick={(event) => openTaskBeside(sessionId, event)}
        >
          {title}
        </button>
        <span className="flex-shrink-0 text-[12px] text-[var(--warning)]">{workflowStatusLabel(run, []).word}</span>
      </div>

      {members.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {members.map((member) => (
            <li key={member.key} className="flex min-w-0 items-center gap-1.5" title={member.focus ?? undefined}>
              <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center [&>*]:h-full [&>*]:w-full">
                <ProviderIcon provider={member.provider as AgentProvider} />
              </span>
              <span className="font-medium text-[var(--text-primary)]">{workflowMemberParts(member, run.members).name}</span>
              <span className="min-w-0 truncate">{workflowMemberRole(member)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {run.checks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>Runs</span>
          {run.checks.map((check) => (
            <code
              key={check.stepId}
              className={cn(
                'rounded px-1.5 font-mono text-[11.5px] text-[var(--text-primary)]',
                check.highlight ? 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)]' : 'bg-[var(--bg-tertiary)]'
              )}
              title={check.reasons.join(', ') || undefined}
            >
              {check.argv.join(' ')}
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

      <div className="flex items-center gap-2">
        <button type="button" className={workflowPrimaryButtonClass} disabled={busy} onClick={() => void decide(true)}>
          <Play className="h-3 w-3" /> Start
        </button>
        <button type="button" className={workflowButtonClass} disabled={busy} onClick={() => void decide(false)}>
          <X className="h-3 w-3" /> Cancel
        </button>
        {run.checks.length > 0 ? (
          <span className="min-w-0 truncate text-[11.5px] text-[var(--text-muted)]">Starting approves these commands for this run.</span>
        ) : null}
        <button
          type="button"
          className="ml-auto inline-flex h-7 flex-shrink-0 items-center gap-0.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          Details
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

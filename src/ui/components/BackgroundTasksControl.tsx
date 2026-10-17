import { useEffect, useState } from 'react';
import { Bot, LoaderCircle, Terminal, Workflow, X } from './icons';
import { sendEvent } from '../hooks/useIPC';
import { useAppStore } from '../store/useAppStore';
import { getMessageContentBlocks, normalizeToolUseBlock } from '../utils/message-content';
import type { BackgroundTaskInfo } from '../../shared/types';
import type { StreamMessage } from '../types';

/** Chips shown before the rest fold into "+N". */
const VISIBLE_TASKS = 3;

function taskKind(task: BackgroundTaskInfo): string {
  if (task.taskType === 'local_agent') return task.subagentType ? `Subagent · ${task.subagentType}` : 'Subagent';
  if (task.taskType === 'local_bash') return 'Command';
  if (task.taskType === 'local_workflow') return 'Workflow';
  return task.taskType.replace(/^local_/, '').replace(/_/g, ' ');
}

function TaskIcon({ task }: { task: BackgroundTaskInfo }) {
  const className = 'h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]';
  if (task.taskType === 'local_agent') return <Bot className={className} aria-hidden="true" />;
  if (task.taskType === 'local_workflow') return <Workflow className={className} aria-hidden="true" />;
  return <Terminal className={className} aria-hidden="true" />;
}

/** createdAt of the message holding the tool call that started the task. */
function toolCallCreatedAt(messages: StreamMessage[], toolUseId: string): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const hit = getMessageContentBlocks(message).some((block) => normalizeToolUseBlock(block)?.id === toolUseId);
    if (!hit) continue;
    const createdAt = (message as { createdAt?: unknown }).createdAt;
    return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
  }
  return null;
}

/**
 * The Claude session's running background tasks, a row of chips above the
 * composer. A chip opens the task's detail (a subagent's trace panel, or the
 * tool call that started it); its × stops that task alone. The session
 * declares perTaskStopAffordance, so the composer's Stop ends only the turn.
 */
export function BackgroundTasksControl({
  sessionId,
  tasks,
}: {
  sessionId: string;
  tasks: BackgroundTaskInfo[];
}) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  // A stopped task leaves the next snapshot; forget it then.
  useEffect(() => {
    setStopping((current) => {
      const next = new Set([...current].filter((id) => tasks.some((task) => task.taskId === id)));
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  if (tasks.length === 0) return null;

  const stop = (taskId: string) => {
    setStopping((current) => new Set(current).add(taskId));
    sendEvent({ type: 'session.stopBackgroundTask', payload: { sessionId, taskId } });
  };

  const openDetail = (task: BackgroundTaskInfo) => {
    if (!task.toolUseId) return;
    const state = useAppStore.getState();
    if (task.taskType === 'local_agent') {
      state.openSubagentPanel(task.toolUseId);
      return;
    }
    const createdAt = toolCallCreatedAt(state.sessions[sessionId]?.messages ?? [], task.toolUseId);
    if (createdAt !== null) {
      state.setHistoryNavigationTarget({ sessionId, messageCreatedAt: createdAt, nonce: Date.now() });
    }
  };

  const shown = expanded ? tasks : tasks.slice(0, VISIBLE_TASKS);
  const hidden = tasks.length - shown.length;

  return (
    <div
      role="group"
      aria-label={`${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} running`}
      className="mb-2 flex flex-wrap items-center gap-1.5 px-3 text-[12px]"
    >
      <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />
      {shown.map((task) => {
        const isStopping = stopping.has(task.taskId);
        const hint = `${task.description}\n${taskKind(task)}${task.toolUseId ? '' : ' · no details'}`;
        return (
          <span
            key={task.taskId}
            className={`inline-flex min-w-0 max-w-[260px] items-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] ${isStopping ? 'opacity-60' : ''}`}
          >
            <button
              type="button"
              onClick={() => openDetail(task)}
              disabled={!task.toolUseId}
              title={hint}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 transition-colors hover:text-[var(--text-primary)] enabled:hover:bg-[var(--bg-tertiary)] disabled:cursor-default"
            >
              <TaskIcon task={task} />
              <span className="truncate">{isStopping ? 'Stopping…' : task.description}</span>
            </button>
            <button
              type="button"
              onClick={() => stop(task.taskId)}
              disabled={isStopping}
              aria-label={`Stop ${task.description}`}
              title="Stop"
              className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-default"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded-full px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          {expanded ? 'Show less' : `+${hidden}`}
        </button>
      ) : null}
    </div>
  );
}

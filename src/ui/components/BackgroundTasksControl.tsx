import { useEffect, useState } from 'react';
import * as DropdownMenu from './ui/dropdown-menu';
import { LoaderCircle, Square } from './icons';
import { sendEvent } from '../hooks/useIPC';
import type { BackgroundTaskInfo } from '../../shared/types';

function taskKind(task: BackgroundTaskInfo): string {
  if (task.taskType === 'local_agent') return task.subagentType ? `Subagent · ${task.subagentType}` : 'Subagent';
  if (task.taskType === 'local_bash') return 'Command';
  if (task.taskType === 'local_workflow') return 'Workflow';
  return task.taskType.replace(/^local_/, '').replace(/_/g, ' ');
}

/**
 * The Claude session's running background tasks, each with its own Stop.
 * The session declares perTaskStopAffordance, so the composer's Stop ends
 * only the turn; this is where a background task is stopped.
 */
export function BackgroundTasksControl({
  sessionId,
  tasks,
  menuSide = 'top',
}: {
  sessionId: string;
  tasks: BackgroundTaskInfo[];
  menuSide?: 'top' | 'bottom';
}) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
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

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} running`}
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>{tasks.length} in background</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={menuSide} align="end" sideOffset={8} className="flex w-[300px] max-w-[calc(100vw-32px)] flex-col p-1">
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[var(--text-muted)]">
            Running in background
          </DropdownMenu.Label>
          {tasks.map((task) => {
            const isStopping = stopping.has(task.taskId);
            return (
              <DropdownMenu.Item
                key={task.taskId}
                closeOnClick={false}
                disabled={isStopping}
                onSelect={() => stop(task.taskId)}
                aria-label={`Stop ${task.description}`}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[disabled]:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[var(--text-primary)]" title={task.description}>
                    {task.description}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">{taskKind(task)}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--text-secondary)]">
                  {isStopping ? (
                    'Stopping…'
                  ) : (
                    <>
                      <Square className="h-3 w-3" aria-hidden="true" />
                      Stop
                    </>
                  )}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

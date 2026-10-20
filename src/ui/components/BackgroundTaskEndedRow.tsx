import { ArrowUpRight } from './icons';
import { useAppStore } from '../store/useAppStore';
import { getMessageContentBlocks, normalizeToolUseBlock } from '../utils/message-content';
import type { StreamMessage } from '../types';
import { BackgroundTaskIcon, backgroundTaskKind, openBackgroundTaskDetail } from './BackgroundTasksControl';
import { TraceLine } from './TraceLine';
import type { BackgroundTaskOutcome } from '../../shared/types';

const STATUS_LABEL: Record<BackgroundTaskOutcome['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

/**
 * The task's description and kind from the tool call that started it: a
 * process resuming the session reports its predecessor's tasks without them.
 * One string, so the store selector stays referentially stable.
 */
export function startedBy(messages: StreamMessage[] | undefined, toolUseId: string): string | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const block of getMessageContentBlocks(messages[index])) {
      const call = normalizeToolUseBlock(block);
      if (call?.id !== toolUseId) continue;
      const taskType = call.name === 'Bash' ? 'local_bash' : call.name === 'Task' || call.name === 'Agent' ? 'local_agent' : '';
      const description = typeof call.input.description === 'string' ? call.input.description.trim() : '';
      return `${taskType}\n${description}`;
    }
  }
  return null;
}

/** What the row shows and opens: the outcome, completed from its tool call. */
export function resolveOutcomeTask(
  outcome: BackgroundTaskOutcome,
  started: string | null
): { toolUseId?: string; taskType?: string; description?: string } {
  const [startedType, startedDescription] = started ? started.split('\n') : [];
  return {
    toolUseId: outcome.toolUseId,
    taskType: outcome.taskType || startedType || undefined,
    description: outcome.description || startedDescription || undefined,
  };
}

/**
 * A background task's outcome in the transcript: the task, its kind and how
 * it ended. Opens the tool call (or subagent) that started it.
 */
export function BackgroundTaskEndedRow({ sessionId, outcome }: { sessionId?: string | null; outcome: BackgroundTaskOutcome }) {
  const navigable = Boolean(sessionId && outcome.toolUseId);
  const started = useAppStore((state) =>
    sessionId && outcome.toolUseId && !outcome.description
      ? startedBy(state.sessions[sessionId]?.messages, outcome.toolUseId)
      : null
  );
  const task = resolveOutcomeTask(outcome, started);
  const { taskType } = task;
  const title = task.description || outcome.summary || 'Background task';
  const hint = outcome.summary && outcome.summary !== title ? `${title}\n${outcome.summary}` : title;
  return (
    <div className="my-2" data-background-task-ended={outcome.status}>
      <TraceLine
        as={navigable ? 'button' : 'div'}
        onClick={navigable ? () => openBackgroundTaskDetail(sessionId!, task) : undefined}
        hint={hint}
        tone={outcome.status === 'failed' ? 'error' : 'default'}
        icon={<BackgroundTaskIcon taskType={taskType} className="" />}
        title={title}
        meta={<>
          <span>{taskType ? `Background ${backgroundTaskKind(taskType).toLowerCase()}` : 'Background task'}</span>
          {outcome.status === 'failed'
            ? <span className="trace-meta-error">{STATUS_LABEL.failed}</span>
            : <span>{STATUS_LABEL[outcome.status]}</span>}
        </>}
        trail={navigable ? <ArrowUpRight /> : undefined}
      />
    </div>
  );
}

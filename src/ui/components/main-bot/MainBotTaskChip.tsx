// A task the main bot started, as a small chip under the message that asked
// for it: the task's state icon (the one the sidebar and My Tasks show), its
// title and the agent that runs it. The chip opens the task beside the
// conversation, and stays lit while that tab is the one showing.

import { parseMainBotTaskResult } from '../../../shared/main-bot';
import { useTaskStanding } from '../../hooks/useTaskStanding';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../utils/cn';
import { taskTab } from '../../utils/right-utility-tabs';
import { openTaskBeside } from '../../utils/task-state';
import { Loader2 } from '../icons';
import { TaskStateIcon } from '../TaskStatusMenu';

function field(input: unknown, name: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value.trim() : '';
}

/** The state icon of a task named in the bot's conversation; a plain ring for one that is not known here. */
export function MainBotTaskStateIcon({ sessionId }: { sessionId: string }) {
  const { session, state, failed } = useTaskStanding(sessionId);
  if (!session || !state) {
    return <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-[1.5px] border-[var(--text-muted)] opacity-60" aria-hidden="true" />;
  }
  return <TaskStateIcon state={state} failed={failed} />;
}

export function MainBotTaskChip({ input, resultText }: { input: unknown; resultText: string | null }) {
  const result = parseMainBotTaskResult(resultText);
  const sessionId = result.sessionId ?? '';
  const { session, label } = useTaskStanding(sessionId);
  const showing = useAppStore(
    (state) => Boolean(sessionId) && !state.rightUtilityPanelHidden && state.activeRightUtilityTab === taskTab(sessionId)
  );
  const title = session?.title || result.title || field(input, 'title') || 'a task';
  const starting = !sessionId;
  const standing = starting ? 'Starting' : label;
  const facts = [standing, result.agent, result.project, result.device].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[8px] px-2 text-left text-[13px] leading-none transition-colors disabled:cursor-default',
        showing ? 'bg-[var(--sidebar-item-active)]' : 'enabled:hover:bg-[var(--sidebar-item-hover)]'
      )}
      onClick={(event) => openTaskBeside(sessionId, event)}
      disabled={!session}
      title={facts}
      aria-label={`${title} · ${standing}`}
      aria-pressed={showing}
      data-main-bot-task={sessionId || 'starting'}
    >
      {starting ? (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--text-muted)]" role="img" aria-label="Starting" />
      ) : (
        <MainBotTaskStateIcon sessionId={sessionId} />
      )}
      <span className="min-w-0 truncate text-[var(--text-primary)]">{title}</span>
      {result.agent ? <span className="flex-shrink-0 text-[var(--text-muted)]" data-main-bot-task-agent>{result.agent}</span> : null}
    </button>
  );
}

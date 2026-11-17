// What the main bot did to a task, in the turn where it did it. A task it
// started is a chip under the message that asked for it (MainBotTaskChip), so
// here a start draws only when it failed. A message to a task, or stopping
// one, is a single line that opens that task beside the conversation. Lines
// show the task's state as it is now, so nothing more is drawn when its
// result comes back.

import { mainBotToolKind, parseMainBotTaskResult } from '../../../shared/main-bot';
import { turnReportNeedsUser } from '../../../shared/turn-report';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../utils/cn';
import { openTaskBeside } from '../../utils/task-state';
import { AlertTriangle, CornerDownRight, LoaderCircle, Square } from '../icons';
import { TraceLine } from '../TraceLine';

type Tone = 'none' | 'working' | 'warning' | 'danger';

const DOT: Record<Exclude<Tone, 'none'>, string> = {
  working: 'animate-pulse bg-[var(--accent)]',
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--error)]',
};

function field(input: unknown, name: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value.trim() : '';
}

export function MainBotTaskLine({ toolName, input, resultText, failed, pending }: {
  toolName: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
  pending: boolean;
}) {
  const kind = mainBotToolKind(toolName);
  const result = failed ? {} : parseMainBotTaskResult(resultText);
  const sessionId = result.sessionId ?? '';
  const session = useAppStore((state) => (sessionId ? state.sessions[sessionId] : undefined));
  const title = session?.title || result.title || field(input, 'title') || field(input, 'task') || 'a task';

  const state: { tone: Tone; label: string } = !session
    ? { tone: 'none', label: 'Started' }
    : session.permissionRequests?.length
      ? { tone: 'warning', label: 'Needs you' }
      : session.status === 'running'
        ? { tone: 'working', label: 'Running' }
        : turnReportNeedsUser(session.turnReport)
          ? { tone: 'warning', label: 'Needs you' }
          : session.status === 'error'
            ? { tone: 'danger', label: 'Failed' }
            : { tone: 'none', label: 'Done' };
  // The task's own state, live: a result coming back adds no row of its own.
  const mark = state.tone === 'none' ? null : <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', DOT[state.tone])} data-main-bot-task-mark={state.tone} />;

  if (kind === 'start') {
    if (failed) {
      return (
        <div className="my-1 flex items-start gap-1.5 text-[12px] text-[var(--text-muted)]" data-main-bot-task="failed">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0">Task not started{resultText ? `: ${resultText}` : '.'}</span>
        </div>
      );
    }
    // Started, or being started: the chip under the message shows it.
    return null;
  }

  const stop = kind === 'stop';
  const verb = stop ? (pending ? 'Stopping' : failed ? 'Could not stop' : 'Stopped') : pending ? 'Sending to' : failed ? 'Could not send to' : 'Sent to';
  const canOpen = !failed && Boolean(session);
  return (
    <div className="my-1" data-main-bot-task-line={stop ? 'stop' : 'message'}>
      <TraceLine
        as={canOpen ? 'button' : 'div'}
        icon={pending ? <LoaderCircle className="animate-spin" /> : stop ? <Square /> : <CornerDownRight />}
        title={
          <>
            {verb} <span className="text-[var(--text-secondary)]">{title}</span>
          </>
        }
        meta={failed || pending || stop ? undefined : mark}
        tone={failed ? 'error' : 'default'}
        hint={failed && resultText ? resultText : !failed && !pending && !stop && session ? state.label : undefined}
        onClick={canOpen ? (event: { metaKey: boolean; ctrlKey: boolean }) => openTaskBeside(sessionId, event) : undefined}
      />
    </div>
  );
}

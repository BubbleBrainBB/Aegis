// Team's add_to_task and move_task: one line saying which task got the
// message or the new owner. The whole line opens that task.

import { isMoveTaskToolName } from '../../../shared/follow-up';
import { useAppStore } from '../../store/useAppStore';
import { PROVIDERS } from '../../utils/provider';
import { ArrowLeftRight, GitMerge, LoaderCircle } from '../icons';
import { TraceLine } from '../TraceLine';

function parseResult(text: string | null): { sessionId?: string; title?: string } {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as { sessionId?: unknown; title?: unknown };
    return {
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
    };
  } catch {
    return {};
  }
}

export function TeamTaskLine({ toolName, input, resultText, failed, pending }: {
  toolName: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
  pending: boolean;
}) {
  const args = (input && typeof input === 'object' ? input : {}) as { task?: unknown; provider?: unknown };
  const result = failed ? {} : parseResult(resultText);
  const task = typeof args.task === 'string' ? args.task : '';
  const sessionId = result.sessionId ?? task;
  const storedTitle = useAppStore((state) => state.sessions[sessionId]?.title);
  const title = result.title ?? storedTitle ?? task ?? 'a task';
  const move = isMoveTaskToolName(toolName);
  const provider = typeof args.provider === 'string' ? args.provider : '';
  const agent = PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
  const verb = move ? (pending ? 'Moving' : failed ? 'Could not move' : 'Moved') : pending ? 'Adding to' : failed ? 'Could not add to' : 'Added to';
  const canOpen = !failed && Boolean(storedTitle);
  return (
    <div className="my-1" data-team-task-line={move ? 'move' : 'add'}>
      <TraceLine
        as={canOpen ? 'button' : 'div'}
        icon={pending ? <LoaderCircle className="animate-spin" /> : move ? <ArrowLeftRight /> : <GitMerge />}
        title={
          <>
            {verb} <span className="text-[var(--text-secondary)]">{title}</span>
            {move && agent ? ` to ${agent}` : ''}
          </>
        }
        tone={failed ? 'error' : 'default'}
        hint={failed && resultText ? resultText : undefined}
        onClick={canOpen ? () => useAppStore.getState().setActiveSession(sessionId) : undefined}
      />
    </div>
  );
}

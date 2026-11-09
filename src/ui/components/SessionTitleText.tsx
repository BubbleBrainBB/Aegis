import { getSessionTitleDisplay } from '../../shared/session-title';
import type { SessionView } from '../types';
import { TaskTitleLoading, useTaskTitleReveal } from './TaskTitleLoading';

export function SessionTitleText({ session, className = '' }: {
  session: Pick<SessionView, 'title' | 'messages' | 'titlePending'> | null | undefined;
  className?: string;
}) {
  const reveal = useTaskTitleReveal(session?.titlePending);
  if (session?.titlePending) return <TaskTitleLoading className={className} />;
  const firstPrompt = session?.messages.find((message) => message.type === 'user_prompt');
  const title = getSessionTitleDisplay(
    session?.title || 'Chat',
    firstPrompt?.type === 'user_prompt' ? firstPrompt.prompt : undefined
  );
  return <span title={title} className={`min-w-0 truncate ${reveal} ${className}`}>{title}</span>;
}

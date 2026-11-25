import { extractSessionLinks } from '../../shared/session-links';
import { useAppStore } from '../store/useAppStore';
import { MainBotTaskStateIcon } from './main-bot/MainBotTaskChip';
import { toast } from 'sonner';

export function TaskReference({ sessionId, href }: { sessionId: string; href?: string }) {
  const title = useAppStore(state => state.sessions[sessionId]?.title) || `Task ${sessionId.slice(0, 8)}`;
  const content = <><MainBotTaskStateIcon sessionId={sessionId} /><span className="task-reference-title">{title}</span></>;
  if (!href) return <span className="task-reference" title={title}>{content}</span>;
  return <a href={href} title={title} className="task-reference" onClick={async event => {
    event.preventDefault();
    try {
      const result = await window.electron.openExternalUrl(href);
      if (!result.ok) toast.error(result.message || 'Could not open task');
    } catch {
      toast.error('Could not open task');
    }
  }}>{content}</a>;
}

export function TaskReferenceText({ text }: { text: string }) {
  const links = extractSessionLinks(text);
  if (!links.length) return text;
  const parts = [];
  let start = 0;
  for (const link of links) {
    parts.push(text.slice(start, link.start), <TaskReference key={link.start} sessionId={link.sessionId} href={link.raw} />);
    start = link.end;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

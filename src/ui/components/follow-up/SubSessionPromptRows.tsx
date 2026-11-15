// The prompt Aegis sends a sub-session to start it, drawn as what it is rather
// than as a user message: the brief it started from. (Its result coming back
// to the parent draws nothing there: the session's row shows how it stands.)

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { PROVIDERS } from '../../utils/provider';
import { findProposalForChild, useFollowUpStore } from '../../store/useFollowUpStore';
import { ChevronDown } from '../icons';
import { StructuredResponse } from '../StructuredResponse';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "2 days ago". */
function timeAgo(at: number | undefined): string | null {
  if (!at) return null;
  const seconds = Math.round((at - Date.now()) / 1000);
  if (seconds > -45) return 'just now';
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [['minute', 60], ['hour', 3_600], ['day', 86_400], ['week', 604_800], ['month', 2_592_000], ['year', 31_536_000]];
  let unit: [Intl.RelativeTimeFormatUnit, number] = steps[0];
  for (const step of steps) if (-seconds >= step[1]) unit = step;
  return relative.format(Math.round(seconds / unit[1]), unit[0]);
}

/**
 * A sub-session's first message: where it came from on one line, then the
 * task and the brief the starting agent wrote, long briefs folded.
 */
export function SubSessionBriefCard({ text, sessionId, createdAt }: { text: string; sessionId?: string; createdAt?: number }) {
  const loaded = useFollowUpStore((state) => state.loaded);
  useEffect(() => {
    if (!loaded) void useFollowUpStore.getState().load();
  }, [loaded]);
  const link = useFollowUpStore((state) => (sessionId ? findProposalForChild(state.proposals, sessionId) : null));
  const parentTitle = useAppStore((state) => (link ? state.sessions[link.parentSessionId]?.title : undefined));
  const title = useAppStore((state) => (sessionId ? state.sessions[sessionId]?.title : undefined)) || link?.title;
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && !expanded) setOverflows(body.scrollHeight > body.clientHeight + 1);
  }, [text, open, expanded]);
  const when = timeAgo(createdAt);
  const agent = PROVIDERS.find((entry) => entry.id === (link?.provider ?? 'claude'))?.label ?? link?.provider ?? 'Claude';
  const openParent = () => {
    if (link) useAppStore.getState().setActiveSession(link.parentSessionId);
  };
  return (
    <div className="my-3 flex flex-col gap-2" data-sub-session-brief>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--text-muted)]">
        <span className="flex-shrink-0">Started by {agent} from</span>
        {link ? (
          <button
            type="button"
            className="min-w-0 truncate text-[var(--text-secondary)] underline decoration-[color-mix(in_srgb,var(--text-muted)_60%,transparent)] underline-offset-[3px] hover:text-[var(--text-primary)]"
            onClick={openParent}
          >
            {parentTitle || 'another session'}
          </button>
        ) : (
          <span className="min-w-0 truncate">another session</span>
        )}
        {when ? <span className="flex-shrink-0">{when}</span> : null}
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded hover:text-[var(--text-primary)]"
          aria-label={open ? 'Hide the task' : 'Show the task'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
      </div>
      {open ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
          {title ? (
            <div className="mb-1.5 flex min-w-0 items-baseline gap-2 text-[13.5px]">
              <span className="flex-shrink-0 text-[var(--text-muted)]">Task</span>
              <span className="min-w-0 truncate text-[var(--text-primary)]">{title}</span>
            </div>
          ) : null}
          <div ref={bodyRef} className={`min-w-0 overflow-hidden text-[14px] ${expanded ? '' : 'max-h-[11.5rem]'}`}>
            <StructuredResponse content={text} />
          </div>
          {overflows || expanded ? (
            <button
              type="button"
              className="mt-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

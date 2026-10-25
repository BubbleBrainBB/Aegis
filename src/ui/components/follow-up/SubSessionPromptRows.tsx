// Prompts Aegis sends around sub-sessions, drawn as what they are rather than
// as user messages: in the parent, the line where finished sub-sessions came
// back; in the sub-session, the brief it started from.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { findProposalForChild, useFollowUpStore } from '../../store/useFollowUpStore';
import { Check, ChevronDown } from '../icons';
import { StructuredResponse } from '../StructuredResponse';

const FINISHED = /^Sub-sessions? finished: ([\s\S]*)$/;

/** True for the label a delivered sub-session result carries (see reportPromptLabel). */
export function isSubSessionsFinishedPrompt(text: string): boolean {
  return FINISHED.test(text);
}

/** The parent picked its sub-sessions' results up: one quiet line between turns. */
export function SubSessionsFinishedRow({ text }: { text: string }) {
  const titles = (FINISHED.exec(text)?.[1] ?? '').split(' · ').filter(Boolean);
  const count = Math.max(titles.length, 1);
  return (
    <div className="mb-1.5 mt-4 flex min-w-0 items-center gap-2 text-[12.5px]" title={titles.join('\n')} data-sub-sessions-finished>
      <Check className="h-[13px] w-[13px] flex-shrink-0 text-[#2f7d4f]" aria-hidden="true" />
      <span className="min-w-0 truncate font-semibold text-[var(--text-primary)]">
        {count === 1 && titles[0] ? `${titles[0]} finished` : `${count} sub-sessions finished`}
      </span>
    </div>
  );
}

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
  const openParent = () => {
    if (link) useAppStore.getState().setActiveSession(link.parentSessionId);
  };
  return (
    <div className="my-3 flex flex-col gap-2" data-sub-session-brief>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--text-muted)]">
        <span className="flex-shrink-0">Started by Claude from</span>
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

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BrandGithub, Globe, Link, Terminal } from './icons';
import { useAppStore } from '../store/useAppStore';
import { findToolCallMessage } from '../utils/tool-call-lookup';
import { getMessageContentBlocks, normalizeToolUseBlock } from '../utils/message-content';
import { openUrlInBrowserSession } from '../utils/html-preview';
import { toast } from 'sonner';
import {
  backgroundTaskLinks,
  outputTailLines,
  type BackgroundTaskLink,
  type BackgroundTaskOutput,
} from '../../shared/background-task-output';
import type { BackgroundTaskInfo } from '../../shared/types';

/** Output lines the peek shows. */
const TAIL_LINES = 6;
const POLL_MS = 1000;

/** When the renderer first saw each task: the start time when the call's isn't known. */
const firstSeen = new Map<string, number>();
export function noteBackgroundTaskSeen(taskId: string): void {
  if (!firstSeen.has(taskId)) firstSeen.set(taskId, Date.now());
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The command a background Bash call runs, and when the call was made. */
function useTaskCall(sessionId: string, toolUseId: string | undefined) {
  const messages = useAppStore((state) => state.sessions[sessionId]?.messages);
  return useMemo(() => {
    if (!toolUseId || !messages) return { command: undefined, startedAt: undefined };
    const message = findToolCallMessage(messages, toolUseId);
    if (!message) return { command: undefined, startedAt: undefined };
    const block = getMessageContentBlocks(message)
      .map((item) => normalizeToolUseBlock(item))
      .find((item) => item?.id === toolUseId);
    const command = typeof block?.input.command === 'string' ? block.input.command : undefined;
    const startedAt = typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : undefined;
    return { command, startedAt };
  }, [messages, toolUseId]);
}

/** The output tail, read again every second while the peek is open. */
function useTaskOutput(sessionId: string, taskId: string) {
  const [output, setOutput] = useState<BackgroundTaskOutput | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await window.electron.readBackgroundTaskOutput(sessionId, taskId);
        if (!cancelled) setOutput(next);
      } catch {
        if (!cancelled) setOutput(null);
      }
      if (!cancelled) timer = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, taskId]);
  return output;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function openLink(sessionId: string, link: BackgroundTaskLink) {
  if (link.kind === 'local') {
    useAppStore.getState().openRightUtilityTab('browser');
    void openUrlInBrowserSession({ sessionId, url: link.url }).catch((reason) =>
      toast.error(`Could not open the page: ${reason instanceof Error ? reason.message : String(reason)}`)
    );
    return;
  }
  void window.electron.openExternalUrl(link.url).then((result) => {
    if (!result.ok) toast.error(result.message || 'Could not open the link');
  }).catch(() => toast.error('Could not open the link'));
}

function LinkIcon({ kind }: { kind: BackgroundTaskLink['kind'] }) {
  const className = 'h-[15px] w-[15px] shrink-0 text-[var(--text-secondary)]';
  if (kind === 'github') return <BrandGithub className={className} aria-hidden="true" />;
  if (kind === 'local') return <Globe className={className} aria-hidden="true" />;
  return <Link className={className} aria-hidden="true" />;
}

/**
 * A running background command at a glance: what it runs, the last lines of
 * its output, and the links in that output (a CI run, a dev server).
 */
export function BackgroundTaskPeek({
  sessionId,
  task,
  stopping,
  onStop,
  onShowInTranscript,
}: {
  sessionId: string;
  task: BackgroundTaskInfo;
  stopping: boolean;
  onStop: () => void;
  onShowInTranscript?: () => void;
}) {
  const { command, startedAt } = useTaskCall(sessionId, task.toolUseId);
  const output = useTaskOutput(sessionId, task.taskId);
  const now = useNow(1000);
  const started = startedAt ?? firstSeen.get(task.taskId);
  const lines = output ? outputTailLines(output.text, TAIL_LINES) : [];
  const links = useMemo(
    () => backgroundTaskLinks({ command, output: output?.text, repo: output?.repo }),
    [command, output?.text, output?.repo]
  );
  const status = stopping ? 'Stopping…' : started ? `Running · ${formatElapsed(now - started)}` : 'Running';

  return (
    <div className="flex flex-col gap-2 px-3 pb-2 pt-3 text-[13px]" data-testid="background-task-peek">
      <div className="flex min-w-0 items-center gap-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <span className="truncate font-medium text-[var(--text-primary)]">{task.description}</span>
        <span className="ml-auto shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]">{status}</span>
      </div>
      {command ? (
        <div className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]" title={command}>
          $ {command}
        </div>
      ) : null}
      <div
        className="flex min-h-[34px] flex-col justify-center overflow-hidden rounded-lg bg-[var(--bg-secondary)] px-2.5 py-2 font-mono text-[11px] leading-[17px] text-[var(--text-secondary)]"
        data-testid="background-task-output"
      >
        {output === undefined ? (
          <span className="text-[var(--text-muted)]">Reading output…</span>
        ) : output === null ? (
          <span className="text-[var(--text-muted)]">Output isn't available for this task</span>
        ) : lines.length === 0 ? (
          <span className="text-[var(--text-muted)]">No output yet</span>
        ) : (
          lines.map((line, index) => (
            <span key={index} className="overflow-hidden text-ellipsis whitespace-pre">
              {line || ' '}
            </span>
          ))
        )}
      </div>
      {links.map((link) => (
        <button
          key={link.url}
          type="button"
          onClick={() => openLink(sessionId, link)}
          title={link.url}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          <LinkIcon kind={link.kind} />
          <span className="shrink-0">{link.label}</span>
          {link.detail ? <span className="min-w-0 truncate text-[12px] text-[var(--text-muted)]">{link.detail}</span> : null}
          <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        </button>
      ))}
      <div className="flex items-center gap-1.5 border-t border-[var(--border)] pt-1.5 text-[12.5px] text-[var(--text-secondary)]">
        {onShowInTranscript ? (
          <button
            type="button"
            onClick={onShowInTranscript}
            className="rounded-md px-2 py-0.5 transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Show in transcript
          </button>
        ) : null}
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="ml-auto rounded-md px-2 py-0.5 transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

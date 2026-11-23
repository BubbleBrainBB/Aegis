// The main bot's waits, in its conversation. A wait is something outside
// Aegis the bot asked to be woken for once: a time, a pull request, a GitHub
// Actions run. Aegis keeps it; no agent runs while it waits.
//
// Three places show one: the line in the turn where the bot set it (it shows
// how the wait stands now, and Cancel while it waits), the Waiting list at the
// top of the conversation (every wait still waiting), and the row that opens
// the turn a wait woke the bot for. Cancel is the person's own doing, so it
// goes straight to Aegis, not through a turn of the bot.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { mainBotToolKind, parseMainBotWaitResult, type MainBotWaitView } from '../../../shared/main-bot';
import { cn } from '../../utils/cn';
import { AlertTriangle, Bell, Check, ChevronDown, Clock, LoaderCircle, Square } from '../icons';
import { TraceLine } from '../TraceLine';

/** How often the list is read again while something waits: a wait can end, or stop being readable, with nothing said in the conversation. */
const REFRESH_MS = 20_000;

interface WaitsState {
  waits: MainBotWaitView[];
  loaded: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  load: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useMainBotWaitsStore = create<WaitsState>((set, get) => ({
  waits: [],
  loaded: false,
  open: false,
  setOpen: (open) => set({ open }),
  load: () => {
    loading ??= (async () => {
      try {
        const waits = await window.electron.mainBotWaits?.();
        if (Array.isArray(waits)) set({ waits, loaded: true });
      } catch {
        // Kept as last read; asked again with the next change.
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  cancel: async (id) => {
    try {
      const done = await window.electron.cancelMainBotWait(id);
      if (!done.ok) toast.error(done.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not cancel the wait');
    }
    await get().load();
  },
}));

function field(input: unknown, name: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : null;
  return typeof value === 'string' ? value.trim() : '';
}

/** A moment in the days ahead, as short as it stays clear: "17:00", "Fri 17:00", "Nov 28, 17:00". */
export function waitMoment(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(at - now) < 6 * 86_400_000) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Until when a wait waits, in a few words; empty when nothing is worth saying. */
function untilText(wait: MainBotWaitView): string {
  if (wait.by !== null) return wait.kind === 'time' ? waitMoment(wait.by) : `until ${waitMoment(wait.by)}`;
  return wait.expiresAt !== null ? `ends ${waitMoment(wait.expiresAt)}` : '';
}

/** How a wait that is over ended, in one word where one will do. */
function endedWord(wait: MainBotWaitView): string {
  if (wait.status === 'cancelled') return 'Cancelled';
  if (wait.status === 'expired') return 'Expired';
  return wait.ended?.summary || 'Over';
}

const cancelClass =
  'flex-shrink-0 rounded px-1.5 text-[11.5px] leading-5 text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';

function CancelWait({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={cancelClass}
      disabled={busy}
      data-main-bot-wait-cancel={id}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        await useMainBotWaitsStore.getState().cancel(id);
        setBusy(false);
      }}
    >
      Cancel
    </button>
  );
}

/**
 * The line for a wait_for or cancel_wait call. A wait that was set shows how
 * it stands now, so nothing more is drawn when it ends: the turn it wakes the
 * bot for opens with its own row.
 */
export function MainBotWaitLine({ toolName, input, resultText, failed, pending }: {
  toolName: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
  pending: boolean;
}) {
  const calledOff = mainBotToolKind(toolName) === 'unwait';
  const result = failed ? {} : parseMainBotWaitResult(resultText);
  const loaded = useMainBotWaitsStore((state) => state.loaded);
  const wait = useMainBotWaitsStore((state) => (result.waitId ? state.waits.find((entry) => entry.id === result.waitId) : undefined));
  useEffect(() => {
    // A line can be on screen before the Waiting list ever was (a search hit, a side pane).
    if (!loaded) void useMainBotWaitsStore.getState().load();
  }, [loaded]);
  // A wait just set is not in the list yet: read again once its result is in.
  const missing = Boolean(result.waitId) && loaded && !wait && !calledOff;
  useEffect(() => {
    if (missing) void useMainBotWaitsStore.getState().load();
  }, [missing, result.waitId]);

  const label = wait?.label || result.label || field(input, 'label') || field(input, 'wait') || 'something';
  const name = <span className="text-[var(--text-secondary)]">{label}</span>;

  if (calledOff) {
    return (
      <div className="my-1" data-main-bot-wait-line="called-off">
        <TraceLine
          as="div"
          icon={pending ? <LoaderCircle className="animate-spin" /> : <Square />}
          title={<>{pending ? 'Calling off the wait for' : failed ? 'Could not call off the wait for' : 'Called off the wait for'} {name}</>}
          tone={failed ? 'error' : 'default'}
          hint={failed && resultText ? resultText : undefined}
        />
      </div>
    );
  }
  if (pending || failed) {
    return (
      <div className="my-1" data-main-bot-wait-line={failed ? 'failed' : 'pending'}>
        <TraceLine
          as="div"
          icon={pending ? <LoaderCircle className="animate-spin" /> : <AlertTriangle />}
          title={<>{pending ? 'Setting a wait for' : 'Could not wait for'} {name}</>}
          tone={failed ? 'error' : 'default'}
          hint={failed && resultText ? resultText : undefined}
        />
      </div>
    );
  }
  // What was asked for had already happened: Aegis said so at once, and nothing waits.
  if (!result.waitId) {
    return (
      <div className="my-1" data-main-bot-wait-line="already">
        <TraceLine as="div" icon={<Check />} title={<>No wait needed for {name}</>} meta={result.already} hint={result.already} />
      </div>
    );
  }
  const waiting = wait ? wait.status === 'waiting' : !loaded;
  const meta = wait ? (waiting ? wait.problem || untilText(wait) : endedWord(wait)) : undefined;
  return (
    <div className="my-1" data-main-bot-wait-line={wait?.status ?? (loaded ? 'gone' : 'waiting')}>
      <TraceLine
        as="div"
        icon={<Clock />}
        title={<>{waiting ? 'Waiting for' : 'Waited for'} {name}</>}
        meta={meta}
        tone={waiting && wait?.problem ? 'waiting' : 'default'}
        hint={wait ? [wait.target, wait.kind === 'time' ? '' : `until ${wait.waitsFor}`].filter(Boolean).join(': ') || undefined : undefined}
        aside={waiting && wait ? <CancelWait id={wait.id} /> : undefined}
      />
    </div>
  );
}

/**
 * Every wait still waiting, at the top of the main bot's conversation: one
 * line that says how many, unfolding into what each waits for and until when.
 * Nothing is drawn when nothing waits.
 */
export function MainBotWaitingList({ messageCount, busy }: { messageCount: number; busy: boolean }) {
  const waiting = useMainBotWaitsStore((state) => state.waits).filter((wait) => wait.status === 'waiting');
  const open = useMainBotWaitsStore((state) => state.open);
  // Read again when the conversation moves (the bot set or called off one, or was woken by one) and by the clock while any waits.
  useEffect(() => {
    void useMainBotWaitsStore.getState().load();
  }, [messageCount, busy]);
  const any = waiting.length > 0;
  useEffect(() => {
    if (!any) return undefined;
    const timer = window.setInterval(() => void useMainBotWaitsStore.getState().load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [any]);

  if (!any) return null;
  const troubled = waiting.some((wait) => wait.problem);
  return (
    <div className="flex-shrink-0 border-b border-[var(--border)] px-4 text-[12px] leading-5 text-[var(--text-secondary)]" data-main-bot-waits>
      <div className="message-container">
        <button
          type="button"
          className="flex h-8 w-full items-center gap-1.5 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          aria-expanded={open}
          data-main-bot-waits-toggle
          onClick={() => useMainBotWaitsStore.getState().setOpen(!open)}
        >
          <Clock className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <span className="font-medium">Waiting</span>
          <span className="text-[var(--text-muted)]">{waiting.length}</span>
          {troubled ? <AlertTriangle className="h-3 w-3 flex-shrink-0 text-[var(--warning)]" aria-label="A wait cannot be looked at" /> : null}
          {!open ? <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{waiting.map((wait) => wait.label).join(' · ')}</span> : <span className="flex-1" />}
          <ChevronDown className={cn('h-3 w-3 flex-shrink-0 text-[var(--text-muted)] transition-transform', open ? 'rotate-180' : '')} aria-hidden="true" />
        </button>
        {open ? (
          <ul className="max-h-[40vh] overflow-auto pb-1.5">
            {waiting.map((wait) => (
              <li key={wait.id} className="flex min-w-0 items-center gap-2 py-[3px] pl-5" data-main-bot-wait={wait.id}>
                <span className="min-w-0 max-w-[45%] flex-shrink-0 truncate text-[var(--text-primary)]" title={wait.label}>{wait.label}</span>
                {wait.kind === 'time' ? null : (
                  <button
                    type="button"
                    className="min-w-0 truncate text-left text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline"
                    title={`${wait.target}: until ${wait.waitsFor}`}
                    onClick={() => (wait.url ? void window.electron.openExternalUrl(wait.url) : undefined)}
                  >
                    {wait.target}
                  </button>
                )}
                <span className="flex-1" />
                {wait.problem ? (
                  <span className="min-w-0 truncate text-[var(--warning)]" title={wait.problem}>{wait.problem}</span>
                ) : (
                  <span className="flex-shrink-0 text-[var(--text-muted)]" title={wait.kind === 'time' ? undefined : wait.checkedAt ? `Last looked at ${waitMoment(wait.checkedAt)}` : undefined}>
                    {untilText(wait)}
                  </span>
                )}
                <CancelWait id={wait.id} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** What opens the turn a wait woke the bot for: Aegis's word, not the person's. */
export function WaitOverRow({ titles }: { titles: string[] }) {
  const label = titles.join(' · ');
  return (
    <div className="mb-1.5 mt-4 flex" data-main-bot-wait-over>
      <span
        className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] pl-[7px] pr-[9px] text-[11.5px] text-[var(--text-secondary)]"
        title={`Wait over: ${label}`}
      >
        <Bell className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        <span className="flex-shrink-0 text-[var(--text-muted)]">Wait over</span>
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </div>
  );
}

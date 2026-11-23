// The main bot's waits, as its conversation shows them. A wait is something
// outside Aegis the bot asked to be woken for once: a time, a pull request, a
// GitHub Actions run. Aegis keeps it; no agent runs while it waits.
//
// Three places show one. The Waiting section at the top of the conversation's
// Environment card lists every wait still waiting, and is where one is
// cancelled (the person's own doing, so it goes straight to Aegis, not through
// a turn of the bot). The line in the turn where the bot set a wait shows how
// it stands now; three or more set in one turn fold into one line. And the
// turn a wait woke the bot for opens with a line saying which, and how it
// ended.

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { mainBotToolKind, parseMainBotWaitResult, type MainBotWaitView } from '../../../shared/main-bot';
import { AlertTriangle, Bell, Check, Clock, GitPullRequest, LoaderCircle, MoreHorizontal, Play, X } from '../icons';
import { TraceChevron, TraceLine, TraceNest } from '../TraceLine';
import * as DropdownMenu from '../ui/dropdown-menu';

/** How often the list is read again while something waits: a wait can end, or stop being readable, with nothing said in the conversation. */
const REFRESH_MS = 20_000;

interface WaitsState {
  waits: MainBotWaitView[];
  loaded: boolean;
  load: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useMainBotWaitsStore = create<WaitsState>((set, get) => ({
  waits: [],
  loaded: false,
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

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A moment ahead, as short as it stays clear: "in 35 min", "5:00 PM", "Mon 5:00 PM", "Nov 28". */
export function waitMoment(at: number, now = Date.now()): string {
  const ahead = at - now;
  if (ahead > 0 && ahead < 60 * 60_000) return `in ${Math.max(1, Math.round(ahead / 60_000))} min`;
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return clock(at);
  if (Math.abs(ahead) < 6 * 86_400_000) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(at)}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `owner/repo#482` reads as `repo #482`; a run as `repo · Actions run`. The whole of it is in the row's tooltip. */
export function shortWaitTarget(target: string): string {
  const pull = /^[^/\s]+\/([^#\s]+)#(\d+)$/.exec(target);
  if (pull) return `${pull[1]} #${pull[2]}`;
  const run = /^[^/\s]+\/(\S+) run \d+$/.exec(target);
  return run ? `${run[1]} · Actions run` : target;
}

/** Why a wait cannot be looked at, or could not be set, in a few words; the full text stays in the tooltip. */
export function shortWaitReason(text: string | null | undefined): string {
  const said = (text ?? '').trim();
  if (/not installed/i.test(said)) return 'GitHub CLI is not installed';
  if (/not signed in/i.test(said)) return 'GitHub CLI is signed out';
  if (/shows no such thing|does not show/i.test(said)) return 'not found on GitHub';
  if (/limiting requests|rate limit/i.test(said)) return 'GitHub is limiting requests';
  if (/already wait/i.test(said)) return 'already waiting for it';
  if (/as many as Aegis keeps/i.test(said)) return 'too many waits';
  if (/made again \d+ times/i.test(said)) return 'needs your say first';
  if (/acted on your own many times/i.test(said)) return 'needs your say first';
  const first = said.split(/[.:]/)[0];
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function KindIcon({ kind, className }: { kind: MainBotWaitView['kind']; className?: string }) {
  const Icon = kind === 'pr' ? GitPullRequest : kind === 'run' ? Play : Clock;
  return <Icon className={className} aria-hidden="true" />;
}

// ---- In the conversation ----

interface WaitCallProps {
  toolName: string;
  input: unknown;
  resultText: string | null;
  failed: boolean;
  pending: boolean;
}

/**
 * The line for a wait_for or cancel_wait call. A wait that was set shows how
 * it stands now, so nothing more is drawn when it ends: the turn it wakes the
 * bot for opens with a line of its own. It is cancelled in the Environment
 * card, not here.
 */
export function MainBotWaitLine({ toolName, input, resultText, failed, pending }: WaitCallProps) {
  const calledOff = mainBotToolKind(toolName) === 'unwait';
  const result = failed ? {} : parseMainBotWaitResult(resultText);
  const loaded = useMainBotWaitsStore((state) => state.loaded);
  const wait = useMainBotWaitsStore((state) => (result.waitId ? state.waits.find((entry) => entry.id === result.waitId) : undefined));
  useEffect(() => {
    // A line can be on screen before the conversation read the list (a search hit, a side pane).
    if (!loaded) void useMainBotWaitsStore.getState().load();
  }, [loaded]);
  // A wait just set is not in the list yet: read again once its result is in.
  const missing = Boolean(result.waitId) && loaded && !wait && !calledOff;
  useEffect(() => {
    if (missing) void useMainBotWaitsStore.getState().load();
  }, [missing, result.waitId]);

  const label = wait?.label || result.label || field(input, 'label') || field(input, 'wait') || 'something';
  const name = <span className="text-[var(--text-secondary)]">{label}</span>;
  const kind: MainBotWaitView['kind'] = wait?.kind ?? (field(input, 'pr') ? 'pr' : field(input, 'run') ? 'run' : 'time');

  if (calledOff) {
    return (
      <div className="my-1" data-main-bot-wait-line="called-off">
        <TraceLine
          as="div"
          icon={pending ? <LoaderCircle className="animate-spin" /> : <X />}
          title={<>{pending ? 'Calling off the wait for' : failed ? 'Could not call off the wait for' : 'Called off the wait for'} {name}</>}
          tone={failed ? 'error' : 'default'}
          hint={failed && resultText ? resultText : undefined}
        />
      </div>
    );
  }
  if (pending) {
    return (
      <div className="my-1" data-main-bot-wait-line="pending">
        <TraceLine as="div" icon={<LoaderCircle className="animate-spin" />} title={<>Setting a wait for {name}</>} />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="my-1" data-main-bot-wait-line="failed">
        <TraceLine as="div" icon={<AlertTriangle />} title={<>Could not wait for {name}</>} meta={shortWaitReason(resultText)} tone="error" hint={resultText ?? undefined} />
      </div>
    );
  }
  // What was asked for had already happened: Aegis said so at once, and nothing waits.
  if (!result.waitId) {
    return (
      <div className="my-1" data-main-bot-wait-line="already">
        <TraceLine as="div" icon={<Check />} title={<>No wait needed for {name}</>} meta={result.already ? `already ${result.already}` : undefined} hint={result.already} />
      </div>
    );
  }
  const waiting = wait ? wait.status === 'waiting' : !loaded;
  const meta = !wait
    ? undefined
    : !waiting
      ? wait.status === 'cancelled' ? 'cancelled' : wait.status === 'expired' ? 'expired' : wait.ended?.summary
      : wait.problem
        ? <span className="text-[var(--warning)]" title={wait.problem}>{shortWaitReason(wait.problem)}</span>
        : wait.kind === 'time' ? (wait.by !== null ? waitMoment(wait.by) : undefined) : wait.stands ?? undefined;
  return (
    <div className="my-1" data-main-bot-wait-line={wait?.status ?? (loaded ? 'gone' : 'waiting')}>
      <TraceLine as="div" icon={<KindIcon kind={kind} />} title={<>{waiting ? 'Waiting for' : 'Waited for'} {name}</>} meta={meta} hint={wait?.target || undefined} />
    </div>
  );
}

type WaitCall = Omit<WaitCallProps, 'pending'> & { toolUseId: string };

/** Waits set in one turn, folded into one line that opens. */
function MainBotWaitGroup({ calls }: { calls: WaitCall[] }) {
  const [open, setOpen] = useState(false);
  const waits = useMainBotWaitsStore((state) => state.waits);
  let waiting = 0;
  let over = 0;
  let unneeded = 0;
  let unset = 0;
  for (const call of calls) {
    if (call.failed) {
      unset += 1;
      continue;
    }
    const id = parseMainBotWaitResult(call.resultText).waitId;
    if (!id) unneeded += 1;
    // One not in the list yet has only just been set.
    else if ((waits.find((entry) => entry.id === id)?.status ?? 'waiting') === 'waiting') waiting += 1;
    else over += 1;
  }
  const parts = [waiting ? `${waiting} waiting` : '', over ? `${over} over` : '', unneeded ? `${unneeded} not needed` : '', unset ? `${unset} not set` : ''].filter(Boolean);
  return (
    <div className="my-1" data-main-bot-wait-group={open ? 'open' : 'closed'}>
      <TraceLine
        icon={<Clock />}
        title={<>Set <span className="text-[var(--text-secondary)]">{calls.length} waits</span></>}
        meta={parts.join(' · ')}
        trail={<TraceChevron expanded={open} />}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <TraceNest>
          {calls.map((call) => (
            <MainBotWaitLine key={call.toolUseId} toolName={call.toolName} input={call.input} resultText={call.resultText} failed={call.failed} pending={call.resultText === null && !call.failed} />
          ))}
        </TraceNest>
      ) : null}
    </div>
  );
}

/** How many waits set one after another in a turn it takes for them to fold into one line. */
const FOLD_FROM = 3;

/** A turn's task rows, with a run of wait_for calls folded into one line once there are enough of them. */
export function foldMainBotWaitCards<T extends WaitCall>(calls: T[], render: (call: T) => ReactNode): ReactNode[] {
  const rows: ReactNode[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length >= FOLD_FROM) rows.push(<MainBotWaitGroup key={`waits-${run[0].toolUseId}`} calls={run} />);
    else rows.push(...run.map(render));
    run = [];
  };
  for (const call of calls) {
    if (mainBotToolKind(call.toolName) === 'wait') {
      run.push(call);
      continue;
    }
    flush();
    rows.push(render(call));
  }
  flush();
  return rows;
}

/** What opens the turn a wait woke the bot for: Aegis's word, not the person's. One quiet line per wait, with how it ended; it opens to what Aegis read. */
export function WaitOverRow({ titles }: { titles: string[] }) {
  const waits = useMainBotWaitsStore((state) => state.waits);
  const loaded = useMainBotWaitsStore((state) => state.loaded);
  useEffect(() => {
    if (!loaded) void useMainBotWaitsStore.getState().load();
  }, [loaded]);
  return (
    <div className="mb-1 mt-4" data-main-bot-wait-over>
      {titles.map((title) => {
        // The label is all the conversation keeps: the latest wait of that name that is over is the one meant.
        const wait = [...waits].reverse().find((entry) => entry.label === title && entry.ended !== null && entry.status !== 'cancelled' && entry.status !== 'expired');
        return <WaitOverLine key={title} title={title} wait={wait} />;
      })}
    </div>
  );
}

function WaitOverLine({ title, wait }: { title: string; wait: MainBotWaitView | undefined }) {
  const [open, setOpen] = useState(false);
  const facts = wait?.facts ?? [];
  return (
    <div data-main-bot-wait-over-line={open ? 'open' : 'closed'}>
      <TraceLine
        as={facts.length ? 'button' : 'div'}
        icon={<Bell />}
        title={<>Wait over <span className="text-[var(--text-secondary)]">{title}</span></>}
        meta={wait?.ended?.summary}
        trail={facts.length ? <TraceChevron expanded={open} /> : undefined}
        aria-expanded={facts.length ? open : undefined}
        onClick={facts.length ? () => setOpen(!open) : undefined}
      />
      {open ? (
        <TraceNest>
          <div className="flex flex-col gap-0.5 py-1 text-[12px] leading-5 text-[var(--text-muted)]">
            <div>Read from GitHub{wait?.readAt ? ` at ${clock(wait.readAt)}` : ''}</div>
            {/* The link in a fact is for the bot; the row in the Environment card opens it for the person. */}
            {facts.map((fact) => <div key={fact} className="text-[var(--text-secondary)]">{fact.replace(/ \(https?:\/\/[^)\s]+\)/g, '')}</div>)}
          </div>
        </TraceNest>
      ) : null}
    </div>
  );
}

/**
 * Keeps the list of waits fresh while the main bot's conversation is open:
 * read again when the conversation moves (the bot set or called off one, or
 * was woken by one), and by the clock while any waits. It draws nothing.
 */
export function MainBotWaitsRefresh({ messageCount, busy }: { messageCount: number; busy: boolean }) {
  const any = useMainBotWaitsStore((state) => state.waits.some((wait) => wait.status === 'waiting'));
  useEffect(() => {
    void useMainBotWaitsStore.getState().load();
  }, [messageCount, busy]);
  useEffect(() => {
    if (!any) return undefined;
    const timer = window.setInterval(() => void useMainBotWaitsStore.getState().load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [any]);
  return null;
}

// ---- In the Environment card ----

function WaitRow({ wait }: { wait: MainBotWaitView }) {
  const open = () => {
    if (wait.url) void window.electron.openExternalUrl(wait.url).then((result) => { if (!result.ok) toast.error(result.message || 'Could not open GitHub.'); });
  };
  const when = wait.by !== null ? waitMoment(wait.by) : '';
  const hint = [
    wait.label,
    wait.target ? `${wait.target}: until ${wait.waitsFor}` : '',
    wait.by === null && wait.expiresAt !== null ? `No deadline. Stops watching ${waitMoment(wait.expiresAt)}.` : '',
    wait.problem ?? '',
  ].filter(Boolean).join('\n');
  return (
    <div className="group/wait flex items-start" data-main-bot-wait={wait.id}>
      <button type="button" className={`environment-summary-row min-w-0 flex-1 !items-start ${wait.url ? '' : '!cursor-default'}`} title={hint} onClick={open}>
        <KindIcon kind={wait.kind} className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{wait.label}</span>
            {when ? <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{when}</span> : null}
          </span>
          {wait.kind === 'time' ? null : (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
              <span className="min-w-0 truncate">
                {[shortWaitTarget(wait.target), wait.problem ? '' : wait.stands ?? ''].filter(Boolean).join(' · ')}
                {wait.problem ? <span className="text-[var(--warning)]"> · {shortWaitReason(wait.problem)}</span> : null}
              </span>
            </span>
          )}
        </span>
      </button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`${wait.label} options`}
            data-main-bot-wait-menu={wait.id}
            className="mt-0.5 inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 hover:bg-[var(--sidebar-item-hover)] focus-visible:opacity-100 group-hover/wait:opacity-100 data-[popup-open]:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-environment-hub-layer align="end" sideOffset={4}>
            {wait.url ? <DropdownMenu.Item onSelect={open}>Open on GitHub</DropdownMenu.Item> : null}
            <DropdownMenu.Item onSelect={() => void useMainBotWaitsStore.getState().cancel(wait.id)}>Cancel wait</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** Every wait still waiting, at the top of the main bot's Environment card. Nothing is drawn when nothing waits. */
export function EnvironmentWaitingSection() {
  const waiting = useMainBotWaitsStore((state) => state.waits).filter((wait) => wait.status === 'waiting');
  if (!waiting.length) return null;
  return (
    <section className="environment-summary-section px-1.5" aria-label="Waiting" data-main-bot-waits>
      <div className="flex items-baseline gap-1.5 px-2 py-1 text-[12px] font-medium text-[var(--text-secondary)]">
        <span>Waiting</span>
        <span className="font-normal text-[var(--text-muted)]">· {waiting.length}</span>
      </div>
      {waiting.map((wait) => <WaitRow key={wait.id} wait={wait} />)}
    </section>
  );
}

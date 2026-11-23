// The main bot in the app: its one conversation, and the service wired to
// this Mac's sessions and to the Macs it controls.

import { isHumanDrivenOnlyProvider } from '../../../shared/human-driven-providers';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MAIN_BOT_NAME, MAIN_BOT_ROLE, mainBotWaitTitles, type MainBotTaskState, type MainBotWaitView } from '../../../shared/main-bot';
import { opensTurn } from '../../../shared/turn-boundary';
import { parseTurnReport, turnReportTitle } from '../../../shared/turn-report';
import type { AgentProvider, SessionContinuePayload, SessionStartPayload } from '../../../shared/types';
import type { SessionRow } from '../../types';
import { PROVIDER_LABELS, PROVIDERS, readDesktopPreferences, resolveAgent } from '../../feishu/agent-settings';
import {
  createRemoteTask,
  isRemoteSessionId,
  readRemoteTask,
  remoteHostAgents,
  remoteHostOverview,
  sendToRemoteTask,
  stopRemoteTask,
} from '../../remote/integration';
import { machineName } from '../../remote/relay-auth';
import { getAgentRuntimeDirectory } from '../agent-runtime-directory';
import { getClaudeRuntimeStatusCached } from '../claude-runtime-status';
import * as sessions from '../session-store';
import { assistantText } from '../workflow/session-hooks';
import { MainBotMemory } from './memory';
import { MainBotService, NOT_SIGNED_IN, claudeForModel, localTaskState, type MainBotAgent, type MainBotChatLine, type MainBotDevice, type MainBotHost, type MainBotStart, type MainBotTask } from './service';
import { MainBotStore, type MainBotDb } from './store';
import { remoteStartSettings } from './start';
import { setMainBotTools } from './tools';
import { ghWaitProbes } from './wait-probes';

/** What the main process lends the bot: the same entry points the composer and the phone use. */
export interface MainBotDeps {
  userDataDir: string;
  /**
   * Starts a session; resolves with its id once it exists, null when it could
   * not start. A startup that fails after that is a turn that ended in an
   * error (`startTaskSession`).
   */
  start(payload: SessionStartPayload): Promise<string | null>;
  continue(payload: SessionContinuePayload): Promise<boolean>;
  stop(sessionId: string): void;
  /** Whether a session waits for the user to approve something. */
  waitsForApproval(sessionId: string): boolean;
  /** The session a sub-session or follow-up task still reports to; null for any other. */
  reportsTo(sessionId: string): string | null;
  /** The conversations whose workflow is still going. */
  sessionsRunningWorkflow(): string[];
  /** Workflows of conversations that stand still until the person acts, latest first. */
  workflowsWaiting(): Array<{ sessionId: string; runId: string; kind: 'start' | 'answer'; title: string; detail: string }>;
  /** Start, or call off, the workflow a conversation prepared that waits to be started. */
  decideWorkflow(sessionId: string, start: boolean, run: { id: string; revision?: number }): Promise<{ ok: true; title: string } | { ok: false; error: string }>;
  isGitRepo(path: string): Promise<boolean>;
  /** Start fields an agent needs beyond the prompt (Codex's file references). */
  startExtras(provider: AgentProvider, prompt: string, cwd: string): Promise<Partial<SessionStartPayload>>;
  /**
   * Put the bot's agent on an empty thread, and mark the place in its
   * conversation. False when a turn of it runs or is being sent; `entering`
   * says the caller is that send. `automatic`: its context filled up, the
   * person did not ask.
   */
  freshThread(sessionId: string, entering: boolean, automatic: boolean): boolean;
  /** A wait of the bot ended in a way the person is to hear of: shown as a system notification that opens its conversation. */
  waitOver?(sessionId: string, label: string, summary: string): void;
}

const AGENTS_TTL_MS = 60_000;
/** How often tasks on other Macs are looked at while the bot waits on one. */
const REMOTE_CHECK_MS = 5_000;
/** How often the bot's waits are gone through. Each is looked at only when its own time has come. */
const WAITS_CHECK_MS = 30_000;
/** How long after the Mac wakes up before GitHub is asked: the network takes a moment to come back. */
const WAKE_SETTLE_MS = 15_000;

let service: MainBotService | null = null;
let deps: MainBotDeps | null = null;
let localAgents: { at: number; agents: MainBotAgent[] } | null = null;
/** The clock the waits are gone through by: one, however often the app sets the bot up. */
let waitsTimer: ReturnType<typeof setInterval> | null = null;

export function mainBotSession(): SessionRow | undefined {
  try {
    return sessions.findSessionByRole(MAIN_BOT_ROLE);
  } catch {
    // No session database yet (tools built outside the app).
    return undefined;
  }
}

/** The bot's conversation, made on first use. It runs on Bubble in a folder of its own, outside every project. */
export function ensureMainBotSession(): SessionRow {
  const existing = mainBotSession();
  if (existing) return existing;
  if (!deps) throw new Error('The main bot is not available yet.');
  const cwd = join(deps.userDataDir, 'main-bot');
  mkdirSync(cwd, { recursive: true });
  // A conversation with no project: its folder is never offered as one.
  const created = sessions.createSession({ title: MAIN_BOT_NAME, cwd, projectCwd: cwd, provider: 'bubble', isChat: true });
  sessions.setSessionRole(created.id, MAIN_BOT_ROLE);
  return sessions.getSession(created.id) ?? created;
}

/** What the bot's agent reads besides the message, for a turn of its conversation; empty for any other. */
export function mainBotTurnContext(sessionId: string): string {
  if (!service || mainBotSession()?.id !== sessionId) return '';
  try {
    return service.turnContext(sessionId);
  } catch (error) {
    console.error('[main-bot] could not describe how things stand:', error);
    return '';
  }
}

/** A turn of a conversation is about to be sent: the bot's own may have to start on a fresh context first. */
export function prepareMainBotTurn(sessionId: string, typed = false): void {
  if (!service || mainBotSession()?.id !== sessionId) return;
  try {
    service.beforeMainTurn(typed);
  } catch (error) {
    console.error('[main-bot] could not start a fresh context:', error);
  }
}

/** The agent of a conversation said how full its context is: the bot's own starts afresh by itself when it fills up. */
export function noteMainBotContextUsage(sessionId: string, usedTokens: number, contextWindow: number): void {
  if (!service || mainBotSession()?.id !== sessionId) return;
  service.noteContextUsage(usedTokens, contextWindow);
}

/** The person asked for a fresh context: done now, or with the bot's next turn when one runs. */
export function refreshMainBotContext(): 'done' | 'pending' | 'unavailable' {
  if (!service || !mainBotSession()) return 'unavailable';
  try {
    return service.freshContext();
  } catch (error) {
    console.error('[main-bot] could not start a fresh context:', error);
    return 'unavailable';
  }
}

/** A turn ended on this Mac: the bot's own, or a task's it may be waiting on. */
export function noteMainBotTurnEnded(sessionId: string, status: 'completed' | 'error' | 'stopped', error?: string): void {
  const bot = service;
  if (!bot) return;
  const main = mainBotSession()?.id === sessionId;
  // After the rest of the turn's teardown, so the conversation reads as idle once it is.
  setTimeout(() => {
    (main ? bot.onMainTurnEnded(status) : bot.onTaskTurnEnded(sessionId, status, error)).catch((failure) => {
      console.error('[main-bot] could not handle a turn end:', failure);
    });
  }, 0);
}

/** A workflow a conversation on this Mac started changed: the bot may be waiting on that conversation. */
export function noteMainBotWorkflowChange(sessionId: string | null | undefined, status: string): void {
  const bot = service;
  if (!bot || !sessionId) return;
  // After the rest of what changed it, so the task reads as it stands then.
  setTimeout(() => {
    bot.onWorkflowChanged(sessionId, status).catch((failure) => console.error('[main-bot] could not handle a workflow change:', failure));
  }, 0);
}

/** The tasks whose waiting workflow the bot's conversation shows a card for; none while they are held back for the bot to speak first. */
export function mainBotWorkflowCards(): { tasks: string[]; held: boolean } {
  try {
    const held = service?.cardsHeld() ?? false;
    return { tasks: held ? [] : (service?.workflowCards() ?? []), held };
  } catch (error) {
    console.error('[main-bot] could not list waiting workflows:', error);
    return { tasks: [], held: false };
  }
}

/** Start or Cancel on such a card. */
export async function decideMainBotWorkflowCard(taskId: string, run: { id: string; revision: number }, start: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!service) return { ok: false, error: 'Ask Aegis is not available.' };
  return service.decideWorkflowCard(taskId, run, start).catch((failure) => ({ ok: false as const, error: String(failure) }));
}

/** The bot's waits, as its conversation lists them. */
export function mainBotWaits(): MainBotWaitView[] {
  try {
    return service?.waitViews() ?? [];
  } catch (error) {
    console.error('[main-bot] could not list the waits:', error);
    return [];
  }
}

/** Cancel pressed on a wait. */
export function cancelMainBotWait(id: string): { ok: true } | { ok: false; error: string } {
  if (!service) return { ok: false, error: 'Ask Aegis is not available.' };
  try {
    return service.cancelWaitByPerson(id);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the turn of a conversation that runs, or last ran, was begun by a wait of the bot that ended. */
export function mainBotTurnBeganWithWait(sessionId: string): boolean {
  try {
    return mainBotSession()?.id === sessionId && mainState()?.turn?.wait === true;
  } catch {
    return false;
  }
}

function checkMainBotWaits(all: boolean): void {
  void service?.checkWaits({ all }).catch((failure) => console.error('[main-bot] could not look at the waits:', failure));
}

/**
 * The Mac woke up. Timers do not count the time asleep, and what a wait is
 * for may have happened meanwhile: everything is looked at once the network
 * has had a moment.
 */
export function noteMainBotResume(): void {
  if (!service) return;
  const timer = setTimeout(() => checkMainBotWaits(true), WAKE_SETTLE_MS);
  timer.unref?.();
}

/** Something changed on a Mac this one controls. */
export function noteMainBotRemoteChange(): void {
  if (!service?.waitsOnRemote()) return;
  void service.checkRemote().catch((failure) => console.error('[main-bot] could not check tasks on another Mac:', failure));
}

function stateOf(
  row: SessionRow,
  waitsForApproval: boolean,
  runsWorkflow: boolean,
  workflowWaits: MainBotTask['workflowWaits'],
): { state: MainBotTaskState; waitingOn?: string } {
  let report = null;
  try {
    report = parseTurnReport(row.turn_report ? JSON.parse(row.turn_report) : null);
  } catch {
    // An unreadable report says nothing.
  }
  return localTaskState({
    waitsForApproval,
    running: row.status === 'running',
    runsWorkflow,
    workflowWaits,
    asks: report && (report.outcome === 'question' || report.outcome === 'blocked') ? turnReportTitle(report) : null,
    failed: row.status === 'error',
  });
}

function remoteState(status: string, waitingOn: string | undefined): MainBotTaskState {
  if (waitingOn) return 'needs approval';
  if (status === 'running') return 'working';
  if (status === 'error') return 'failed';
  return 'idle';
}

/** Why the bot may not write to a session on this Mac, when something else runs it. */
function closedToMessages(sessionId: string, needs: MainBotDeps, workflows: Set<string>): string | undefined {
  if (workflows.has(sessionId)) return 'It is running a workflow, which sends it its part of the work. Write to it once the workflow has ended.';
  const parent = needs.reportsTo(sessionId);
  if (!parent) return undefined;
  const title = sessions.getSession(parent)?.title;
  return `It was started by ${title ? `the task "${title}"` : 'another task'} and reports to that one. Write to that task instead, or tell the person to.`;
}

function localTasks(needs: MainBotDeps): MainBotTask[] {
  const { waitsForApproval } = needs;
  const workflows = new Set(needs.sessionsRunningWorkflow());
  // The latest one of a conversation is the one its card shows.
  const waiting = new Map<string, NonNullable<MainBotTask['workflowWaits']>>();
  for (const { sessionId, runId, kind, title, detail } of needs.workflowsWaiting()) {
    if (!waiting.has(sessionId)) waiting.set(sessionId, { runId, kind, title, detail });
  }
  const main = mainBotSession()?.id;
  const organization = sessions.getSessionOrganization().sessions;
  const device = machineName();
  return sessions
    .listSessions()
    .filter((row) => row.id !== main && row.conversation_scope !== 'dm' && !organization[row.id]?.archived)
    .map((row): MainBotTask => {
      const project = row.is_chat ? null : row.project_cwd || row.cwd || null;
      return {
        id: row.id,
        ...(row.task_number ? { number: row.task_number } : {}),
        title: row.title,
        deviceId: null,
        device,
        project: project ? basename(project) : null,
        agent: PROVIDER_LABELS[row.provider || 'claude'] ?? row.provider ?? 'Claude',
        model: row.model ?? null,
        ...stateOf(row, waitsForApproval(row.id), workflows.has(row.id), waiting.get(row.id)),
        ...(workflows.has(row.id) ? { runsWorkflow: true as const } : {}),
        ...(waiting.has(row.id) ? { workflowWaits: waiting.get(row.id) } : {}),
        branch: row.env_mode === 'worktree' ? (row.associated_worktree_branch ?? null) : null,
        ...(() => {
          const closed = closedToMessages(row.id, needs, workflows);
          return closed ? { closedToMessages: closed } : {};
        })(),
        updatedAt: Number(row.updated_at),
      };
    });
}

function remoteTasks(): MainBotTask[] {
  return remoteHostOverview().flatMap((host) =>
    host.sessions.map((session): MainBotTask => ({
      id: session.id,
      title: session.title,
      deviceId: host.id,
      device: host.name,
      project: session.project,
      agent: PROVIDER_LABELS[session.provider] ?? session.provider,
      model: session.model ?? null,
      state: remoteState(session.status, session.waitingOn),
      ...(session.waitingOn ? { waitingOn: session.waitingOn } : {}),
      updatedAt: session.updatedAt,
    })),
  );
}

function devices(): MainBotDevice[] {
  const here: MainBotDevice = {
    id: null,
    name: machineName(),
    online: true,
    projects: sessions.listProjects().filter((path) => existsSync(path)).map((path) => ({ name: basename(path), path })),
  };
  return [
    here,
    ...remoteHostOverview().map((host): MainBotDevice => ({
      id: host.id,
      name: host.name,
      online: host.online,
      projects: host.projects.map((project) => ({ name: project.name, remoteId: project.id, isRepo: project.isRepo })),
    })),
  ];
}

async function agentsOf(deviceId: string | null, model?: string): Promise<MainBotAgent[] | null> {
  if (deviceId !== null) {
    // Another Mac lists the agents it has set up.
    const catalog = await remoteHostAgents(deviceId);
    return catalog.map((entry) => ({ provider: entry.provider, label: PROVIDER_LABELS[entry.provider] ?? entry.provider, unavailable: null }));
  }
  let listed = localAgents;
  if (!listed || Date.now() - listed.at >= AGENTS_TTL_MS) {
    const report = await getAgentRuntimeDirectory();
    const agents = report.entries.map((entry): MainBotAgent => ({
      provider: entry.provider,
      label: PROVIDER_LABELS[entry.provider] ?? entry.title,
      // An agent only a person may drive is never given a task by the bot.
      unavailable: isHumanDrivenOnlyProvider(entry.provider)
        ? 'it only takes messages the person types to it in Aegis'
        : entry.state === 'ready' ? null : entry.state === 'login_required' ? NOT_SIGNED_IN : 'not installed or not working',
    }));
    listed = localAgents = { at: Date.now(), agents };
  }
  // The directory asks about Claude with no model in mind; the task's own start asks with its model, and so does this.
  return claudeForModel(listed.agents, async () => (await getClaudeRuntimeStatusCached(claudeModelFor(model))).ready);
}

/** The model a Claude task would run on: the one the bot named, else the composer's. */
function claudeModelFor(named: string | undefined): string | null {
  if (!deps) return named ?? null;
  const desktop = readDesktopPreferences(join(deps.userDataDir, 'renderer-state.json'));
  return resolveAgent({ provider: 'claude', ...(named ? { model: named } : {}) }, desktop).payload.model ?? null;
}

/** A dispatched task does the work: never the composer's leftover plan mode. */
function withoutPlanMode(payload: Partial<SessionStartPayload>): Partial<SessionStartPayload> {
  return {
    ...payload,
    ...(payload.claudeExecutionMode ? { claudeExecutionMode: 'execute' as const } : {}),
    ...(payload.codexExecutionMode ? { codexExecutionMode: 'execute' as const } : {}),
    ...(payload.bubblePermissionMode === 'plan' ? { bubblePermissionMode: payload.bubblePlanExitMode ?? ('default' as const) } : {}),
  };
}

async function start(input: MainBotStart, needs: MainBotDeps): Promise<{ id: string } | { error: string }> {
  const provider = input.agent as AgentProvider;
  if (!PROVIDERS.includes(provider)) return { error: `"${input.agent}" is not an agent Aegis knows.` };
  if (input.device.id !== null) {
    if (!input.project?.remoteId) return { error: `A task on ${input.device.name} needs one of its projects.` };
    // The permission mode the composer here would start this agent with, as below.
    const settings = remoteStartSettings(provider, input.model, readDesktopPreferences(join(needs.userDataDir, 'renderer-state.json')));
    return createRemoteTask(input.device.id, {
      projectId: input.project.remoteId,
      provider,
      prompt: input.effectivePrompt,
      worktree: input.worktree,
      ...(settings ? { settings } : {}),
    });
  }
  // The same model, permission mode and effort the composer would start this agent with.
  const desktop = readDesktopPreferences(join(needs.userDataDir, 'renderer-state.json'));
  const agent = resolveAgent({ provider, ...(input.model ? { model: input.model } : {}) }, desktop);
  const cwd = input.project?.path;
  const payload: SessionStartPayload = {
    title: input.title,
    prompt: input.prompt,
    effectivePrompt: input.effectivePrompt,
    skipTitleGeneration: true,
    background: true,
    scope: 'project',
    envMode: 'local',
    teamMode: 'solo',
    teamId: null,
    ...(cwd ? { cwd, projectCwd: cwd, createIsolatedWorkspace: input.worktree || undefined } : { chat: true }),
    ...withoutPlanMode(agent.payload),
    ...(cwd ? await needs.startExtras(provider, input.prompt, cwd).catch(() => ({})) : {}),
  } as SessionStartPayload;
  try {
    const id = await needs.start(payload);
    return id ? { id } : { error: 'The task could not start. If it appears in the sidebar, open it to see why.' };
  } catch (error) {
    return { error: `The task could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function lastTurn(taskId: string): Promise<{ asked: string | null; reply: string } | null> {
  if (isRemoteSessionId(taskId)) {
    const messages = await readRemoteTask(taskId);
    let last = -1;
    messages.forEach((message, index) => {
      if (message.role === 'user') last = index;
    });
    return {
      asked: last >= 0 ? messages[last].text : null,
      reply: messages.slice(last + 1).filter((message) => message.role === 'assistant' && message.text.trim()).map((message) => message.text).join('\n\n').trim(),
    };
  }
  if (!sessions.getSession(taskId)) return null;
  const history = sessions.getSessionHistory(taskId);
  let last = -1;
  history.forEach((message, index) => {
    if (opensTurn(message)) last = index;
  });
  const opener = last >= 0 ? history[last] : null;
  return {
    asked: opener && opener.type === 'user_prompt' ? opener.prompt : null,
    reply: history.slice(last + 1).map((message) => assistantText(message)).filter((part) => part.trim()).join('\n\n').trim(),
  };
}

function mainState(): ReturnType<MainBotHost['main']> {
  const row = mainBotSession();
  if (!row) return null;
  // Asked on every tool call, of a conversation that only grows: its last prompts, not its history.
  const opener = sessions.getLatestUserPrompts(row.id, 20).find((message) => opensTurn(message));
  return {
    id: row.id,
    busy: row.status === 'running',
    turn: opener
      ? { startedAt: Number(opener.createdAt ?? 0), typed: !opener.workflowPrompt, wait: Boolean(opener.workflowPrompt) && mainBotWaitTitles(opener.prompt) !== null }
      : null,
  };
}

/**
 * Everything said in the bot's conversation, oldest first: what the person
 * wrote, what the bot said, the label of each report that came in, and where
 * its context started afresh. Read when its context starts afresh and when it
 * looks something up, not with every message.
 */
function conversation(): MainBotChatLine[] {
  const row = mainBotSession();
  if (!row) return [];
  const lines: MainBotChatLine[] = [];
  const add = (who: MainBotChatLine['who'], text: string, at: unknown) => lines.push({ seq: lines.length + 1, at: Number(at ?? 0), who, text });
  for (const message of sessions.getSessionHistory(row.id)) {
    if (message.type === 'user_prompt') {
      if (message.prompt.trim()) add(message.workflowPrompt ? 'report' : 'person', message.prompt, message.createdAt);
    } else if (message.type === 'system' && message.subtype === 'context_refreshed') {
      add('fresh', '', message.createdAt);
    } else if (!message.parentToolUseId) {
      // (What a sub-agent of its said is not the bot's own word; Bubble marks that this way.)
      const text = assistantText(message).trim();
      if (text) add('you', text, message.createdAt);
    }
  }
  return lines;
}

export function setupMainBot(needs: MainBotDeps): MainBotService {
  deps = needs;
  const host: MainBotHost = {
    now: () => Date.now(),
    devices,
    tasks: () => [...localTasks(needs), ...remoteTasks()],
    agents: agentsOf,
    preferredAgent: () => {
      const preferred = readDesktopPreferences(join(needs.userDataDir, 'renderer-state.json'))['cowork.preferredProvider'];
      return PROVIDERS.includes(preferred as AgentProvider) ? preferred : 'claude';
    },
    isGitRepo: needs.isGitRepo,
    start: (input) => start(input, needs),
    send: async (taskId, prompt) => {
      if (isRemoteSessionId(taskId)) return sendToRemoteTask(taskId, prompt);
      if (!sessions.getSession(taskId)) return { error: 'That task no longer exists.' };
      return (await needs.continue({ sessionId: taskId, prompt } as SessionContinuePayload)) ? { ok: true } : { error: 'The message could not be sent to that task.' };
    },
    stop: async (taskId) => {
      if (isRemoteSessionId(taskId)) return stopRemoteTask(taskId);
      needs.stop(taskId);
      return { ok: true };
    },
    decideWorkflow: async (taskId, start, run) => {
      if (isRemoteSessionId(taskId)) return { error: 'A workflow on another Mac is started on that Mac.' };
      const done = await needs.decideWorkflow(taskId, start, run);
      return done.ok ? done : { error: done.error };
    },
    lastTurn,
    exists: (taskId) => isRemoteSessionId(taskId) || Boolean(sessions.getSession(taskId)),
    main: mainState,
    freshThread: (entering, automatic) => {
      const row = mainBotSession();
      return row ? needs.freshThread(row.id, entering, automatic) : false;
    },
    conversation,
    tellMain: (label, text) => {
      const row = mainBotSession();
      if (!row) return Promise.resolve(false);
      return needs.continue({ sessionId: row.id, prompt: label, effectivePrompt: text, workflowPrompt: 'follow-up' } as SessionContinuePayload);
    },
  };
  // Beside the bot's own folder, so the person can open and correct what it noted.
  const memory = new MainBotMemory(join(needs.userDataDir, 'main-bot', 'memory'));
  const bot = new MainBotService(new MainBotStore(sessions.getDatabase() as unknown as MainBotDb), host, memory, {
    probes: ghWaitProbes(),
    waitOver: (wait, outcome) => {
      const row = mainBotSession();
      if (row) needs.waitOver?.(row.id, wait.label, outcome.summary);
    },
  });
  service = bot;
  setMainBotTools(bot, () => mainBotSession()?.id ?? null);
  // Tasks whose turn ended while the app was closed report now.
  setTimeout(() => void bot.recover().catch((failure) => console.error('[main-bot] could not recover:', failure)), 3_000);
  const timer = setInterval(noteMainBotRemoteChange, REMOTE_CHECK_MS);
  timer.unref?.();
  // Waits: gone through by the clock, since nothing outside Aegis can call it. The first look is recover()'s.
  if (waitsTimer) clearInterval(waitsTimer);
  waitsTimer = setInterval(() => checkMainBotWaits(false), WAITS_CHECK_MS);
  waitsTimer.unref?.();
  return bot;
}

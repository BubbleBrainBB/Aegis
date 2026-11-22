// The Computer use gateway: the one place every desktop action of an agent
// passes through, whichever provider the agent runs on.
//
// A provider gets ten tools (tools.ts) over its own channel (Bubble: host
// tools). Each call lands here, bound to its Aegis session, and goes through
// the same steps before anything reaches cua-driver:
//   1. the switch, the platform and the driver binary
//   2. the session: unknown → refused; a read-only workflow member → refused;
//      Plan mode → observation only
//   3. the target: Aegis itself is never looked at or acted on
//   4. the lease: one session uses the desktop at a time
//   5. approval: a matching grant, or the COMPUTER USE card (not in Full Access)
//   6. the driver call, held to one window in the background
//   7. the screenshot saved for the session, a live frame for the HUD
// cua-driver has no approval of its own and does not know Aegis sessions, so
// none of this can be left to it or to a provider's permission pipeline.

import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  classifyComputerUseAction,
  displayNameForComputerUseApp,
  formatComputerUseLabel,
  isDeniedComputerUseTarget,
  type ComputerUseDriverStatus,
  type ComputerUseLiveFrame,
  type ComputerUseMediaRef,
} from '../../../shared/computer-use';
import type { ComputerUsePermissionInput } from '../../../shared/types';
import {
  COMPUTER_USE_DENIED_TARGET_MESSAGE,
  COMPUTER_USE_LEASE_MESSAGE,
  persistComputerUseMedia,
  type ComputerUseLease,
} from '../codex-computer-use';
import type { ComputerUseGrantRegistry } from '../codex-computer-use-grants';
import type { ComputerUseDriver, DriverToolResult } from './driver-host';
import {
  computerUseToolDefinition,
  normalizeSecondaryAction,
  parseXdotoolKey,
  type ComputerUseToolDefinition,
} from './tools';

export interface ComputerUseSessionFacts {
  /** Plan mode: the agent may look, not act. */
  planMode: boolean;
  /** Full Access: actions run without the approval card, as with Codex's own Computer use. */
  fullAccess: boolean;
  /** The role of a read-only workflow member; such a session gets no Computer use. */
  readOnlyWorkflowRole: string | null;
}

export interface ComputerUseApprovalDecision {
  allow: boolean;
  /** The user picked "until revoked". */
  untilRevoked: boolean;
}

/** What the gateway needs from the app around it. */
export interface ComputerUseGatewayHost {
  isEnabled(): boolean;
  driverStatus(): ComputerUseDriverStatus;
  /** null: no such session, and the call is refused. */
  getSession(sessionId: string): ComputerUseSessionFacts | null;
  /** Shows the COMPUTER USE card in the session and waits for the answer. */
  requestApproval(
    sessionId: string,
    input: ComputerUsePermissionInput,
    signal?: AbortSignal
  ): Promise<ComputerUseApprovalDecision>;
  emitLive(sessionId: string, frame: ComputerUseLiveFrame): void;
  userDataDir(): string;
  /** Process ids of Aegis itself: main, renderers and helpers. */
  ownProcessIds(): number[];
  /** A call refused because of what the session is (a read-only workflow member). */
  onRefused?(sessionId: string, toolName: string): void;
}

export interface ComputerUseToolResult {
  text: string;
  images: Array<{ mimeType: string; data: string }>;
  isError: boolean;
}

export interface ComputerUseCall {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  /** The agent's tool call id; frames and saved screenshots are filed under it. */
  toolUseId: string;
  signal?: AbortSignal;
}

export const COMPUTER_USE_OFF_MESSAGE = 'Computer use is turned off in Settings.';
export const COMPUTER_USE_PLAN_MESSAGE =
  'Plan mode is read-only: Computer use can look at apps but not act on them. Leave Plan mode to continue.';
export const COMPUTER_USE_SELECT_TEXT_MESSAGE =
  'select_text is not supported yet. Click the text field, then use press_key (for example super+a to select everything, or shift+Left / shift+Right) or type_text.';


/** Which macOS grants are missing, and where to turn them on. */
export function computerUsePermissionsMessage(missing: string[]): string {
  return `Aegis needs ${missing.join(' and ')} to use your computer. Ask the user to turn ${
    missing.length > 1 ? 'them' : 'it'
  } on for Aegis in System Settings → Privacy & Security (Settings → Browser → Computer use in Aegis has the links), then restart Aegis.`;
}

const TREE_TEXT_LIMIT = 40_000;
/** After opening an app: how often, and how long apart, its window is looked for. */
const WINDOW_WAIT_ATTEMPTS = 10;
const WINDOW_WAIT_MS = 400;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Computer use was cancelled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Computer use was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type ListedApp = {
  name: string;
  bundleId: string | null;
  pid: number;
  running: boolean;
  launchPath: string | null;
};

type AppState = {
  /** What the agent called it, lower-cased; later calls name it the same way. */
  query: string;
  name: string;
  bundleId: string | null;
  pid: number;
  windowId: number;
  windowTitle: string;
  snapshotId: string | null;
  tree: string;
};

function fail(text: string): ComputerUseToolResult {
  return { text, images: [], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function readListedApps(result: DriverToolResult): ListedApp[] {
  const apps = Array.isArray(result.structured?.apps) ? result.structured.apps : [];
  return apps.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) return [];
    return [
      {
        name,
        bundleId: asString(record.bundle_id) || null,
        pid: typeof record.pid === 'number' ? record.pid : 0,
        running: record.running === true,
        launchPath: asString(record.launch_path) || null,
      },
    ];
  });
}

function bundleNameOf(launchPath: string | null): string {
  const base = (launchPath || '').split('/').filter(Boolean).pop() || '';
  return base.replace(/\.app$/i, '');
}

/**
 * The app a name, path or bundle identifier means. An app answers to its
 * shown name (which may be localized) and to its bundle's own name.
 */
export function matchComputerUseApp(
  apps: ListedApp[],
  query: string
): { app: ListedApp } | { error: string } {
  const wanted = (displayNameForComputerUseApp(query) || query).trim().toLowerCase();
  const raw = query.trim().toLowerCase();
  const tests: Array<(app: ListedApp) => boolean> = [
    (app) => app.bundleId?.toLowerCase() === raw,
    (app) => app.launchPath?.toLowerCase() === raw.replace(/\/+$/, ''),
    (app) => app.name.toLowerCase() === wanted || app.name.toLowerCase() === raw,
    (app) => bundleNameOf(app.launchPath).toLowerCase() === wanted || bundleNameOf(app.launchPath).toLowerCase() === raw,
  ];
  for (const test of tests) {
    const hits = apps.filter(test);
    if (hits.length === 0) continue;
    // Two entries of one name (an app and its helper): the running one is meant.
    const running = hits.filter((app) => app.running);
    const narrowed = running.length > 0 ? running : hits;
    if (narrowed.length === 1) return { app: narrowed[0] };
    return {
      error: `"${query}" matches several apps: ${narrowed
        .map((app) => `${app.name}${app.bundleId ? ` [${app.bundleId}]` : ''}`)
        .join(', ')}. Use the bundle identifier.`,
    };
  }
  return { error: `No app named "${query}" was found. Call list_apps for the names and bundle identifiers.` };
}

/** The row of one element in a tree, for the approval card: `AXButton (Equals)`. */
function describeElement(tree: string, index: string): string | null {
  const escaped = index.replace(/[^0-9]/g, '');
  if (!escaped) return null;
  const line = tree.split('\n').find((row) => new RegExp(`^\\s*- \\[${escaped}\\] `).test(row));
  if (!line) return null;
  const text = line.replace(/^\s*- \[\d+\]\s*/, '').replace(/\s*\[(?:id|help|actions|enabled|custom_actions)=.*$/, '').trim();
  return text ? (text.length > 80 ? `${text.slice(0, 77)}…` : text) : null;
}

export class ComputerUseGateway {
  /** Per session: the apps it has looked at this turn. */
  private readonly states = new Map<string, Map<string, AppState>>();
  /** Screenshots saved for a tool call, until the provider adapter files them with its result. */
  private readonly mediaByCall = new Map<string, ComputerUseMediaRef[]>();
  /** The driver takes one desktop call at a time; so does the gateway. */
  private driverQueue: Promise<unknown> = Promise.resolve();
  /** Per session: the driver session its current turn runs under. */
  private readonly driverSessions = new Map<string, string>();
  private driverSessionCount = 0;
  /** Both macOS grants were seen by the running driver. */
  private permissionsGranted = false;

  constructor(
    private readonly host: ComputerUseGatewayHost,
    private readonly driver: ComputerUseDriver,
    private readonly shared: { lease: ComputerUseLease; grants: ComputerUseGrantRegistry }
  ) {}

  async call(call: ComputerUseCall): Promise<ComputerUseToolResult> {
    try {
      return await this.run(call);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** The screenshots a tool call saved, handed over once. */
  takeMediaRefs(sessionId: string, toolUseId: string): ComputerUseMediaRef[] {
    const key = `${sessionId}\0${toolUseId}`;
    const refs = this.mediaByCall.get(key) || [];
    this.mediaByCall.delete(key);
    return refs;
  }

  /** The session's turn ended: the desktop is free for another session. */
  finishTurn(sessionId: string): void {
    this.shared.lease.releaseThread(sessionId);
    this.states.delete(sessionId);
    for (const key of [...this.mediaByCall.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.mediaByCall.delete(key);
    }
    const label = this.driverSessions.get(sessionId);
    if (!label) return;
    this.driverSessions.delete(sessionId);
    // Ends the driver's session for the turn (its cursor overlay and
    // snapshots), behind whatever call is in flight, and only if the driver
    // is still there by then: tidying up never starts it.
    const tidy = () =>
      this.driver.isRunning() && this.host.isEnabled()
        ? this.driver.call('end_session', { session: label }).then(() => undefined)
        : Promise.resolve();
    this.driverQueue = this.driverQueue.then(tidy, tidy).catch(() => undefined);
  }

  /** The session was stopped or deleted: its grants go with it. */
  forgetSession(sessionId: string, reason: string): void {
    this.finishTurn(sessionId);
    this.shared.grants.revokeThread(sessionId, reason);
  }

  /** The switch went off, or the app is quitting. */
  async shutdown(reason: string): Promise<void> {
    for (const sessionId of [...this.states.keys()]) this.shared.lease.releaseThread(sessionId);
    this.states.clear();
    this.mediaByCall.clear();
    this.driverSessions.clear();
    this.permissionsGranted = false;
    this.shared.grants.revokeAll(reason);
    // Behind the calls already queued, so none of them finds the driver gone and starts another.
    const stop = () => this.driver.stop();
    const stopped = this.driverQueue.then(stop, stop);
    this.driverQueue = stopped.catch(() => undefined);
    await stopped;
  }

  /** At app quit: no waiting; the driver exits with this process anyway. */
  shutdownSync(): void {
    this.driver.stopSync();
  }

  private async run(call: ComputerUseCall): Promise<ComputerUseToolResult> {
    const { sessionId } = call;
    if (!this.host.isEnabled()) return fail(COMPUTER_USE_OFF_MESSAGE);
    const definition = computerUseToolDefinition(call.tool);
    if (!definition) return fail(`Unknown Computer use tool "${call.tool}".`);
    const facts = this.host.getSession(sessionId);
    if (!facts) return fail('Computer use is not available: this conversation is no longer open.');
    if (facts.readOnlyWorkflowRole) {
      this.host.onRefused?.(sessionId, call.tool);
      return fail(
        `This workflow ${facts.readOnlyWorkflowRole} is read-only; Computer use is not allowed. Report what you need in your result instead.`
      );
    }
    if (facts.planMode && definition.mutating) {
      // As when Codex leaves a mode that could act: standing grants do not survive it.
      this.shared.grants.revokeThread(sessionId, 'mode-exit');
      return fail(COMPUTER_USE_PLAN_MESSAGE);
    }
    if (definition.name === 'select_text') return fail(COMPUTER_USE_SELECT_TEXT_MESSAGE);

    const appQuery = asString(call.args.app);
    if (definition.name !== 'list_apps') {
      if (!appQuery) return fail('`app` is required: an app name, path or bundle identifier.');
      if (isDeniedComputerUseTarget(appQuery)) return fail(COMPUTER_USE_DENIED_TARGET_MESSAGE);
    }
    const status = this.host.driverStatus();
    if (status.state !== 'ready') return fail(status.message || "Computer use isn't available in this build.");

    const missing = await this.missingPermissions(call);
    if (missing) return fail(missing);

    if (definition.name === 'list_apps') return this.listApps(call);
    if (definition.name === 'get_app_state') return this.getAppState(call, facts, appQuery);
    return this.act(call, definition, facts, appQuery);
  }

  /**
   * The two macOS grants, as the driver itself sees them (it answers for the
   * app that started it and never asks macOS for anything). Checked until
   * both are there; a missing one is said in words instead of surfacing as a
   * failed click.
   */
  private async missingPermissions(call: ComputerUseCall): Promise<string | null> {
    if (this.permissionsGranted) return null;
    const result = await this.drive(call.sessionId, 'check_permissions', { prompt: false }, call.signal);
    const missing = [
      result.structured?.accessibility === true ? null : 'Accessibility',
      result.structured?.screen_recording === true ? null : 'Screen Recording',
    ].filter((name): name is string => Boolean(name));
    if (missing.length === 0) {
      this.permissionsGranted = true;
      return null;
    }
    // macOS answers per process: a driver started before the grant keeps saying no.
    const stop = () => this.driver.stop();
    this.driverQueue = this.driverQueue.then(stop, stop).catch(() => undefined);
    this.driverSessions.clear();
    return computerUsePermissionsMessage(missing);
  }

  // ── Observation ────────────────────────────────────────────────────────

  private async listApps(call: ComputerUseCall): Promise<ComputerUseToolResult> {
    this.emitPending(call, 'list_apps', null);
    const result = await this.drive(call.sessionId, 'list_apps', {}, call.signal);
    if (result.isError) return fail(result.text || 'Could not list apps.');
    const apps = readListedApps(result).filter((app) => !this.isOwnApp(app));
    const line = (app: ListedApp) => `- ${app.name}${app.bundleId ? ` [${app.bundleId}]` : ''}`;
    const running = apps.filter((app) => app.running);
    const installed = apps.filter((app) => !app.running);
    return {
      text: [
        `Running (${running.length}):`,
        ...running.map(line),
        '',
        `Installed, not running (${installed.length}):`,
        ...installed.map(line),
      ].join('\n'),
      images: [],
      isError: false,
    };
  }

  private async getAppState(
    call: ComputerUseCall,
    facts: ComputerUseSessionFacts,
    appQuery: string
  ): Promise<ComputerUseToolResult> {
    const { sessionId, signal } = call;
    const listed = await this.drive(sessionId, 'list_apps', {}, signal);
    if (listed.isError) return fail(listed.text || 'Could not list apps.');
    const match = matchComputerUseApp(readListedApps(listed), appQuery);
    if ('error' in match) return fail(match.error);
    const app = match.app;
    if (this.isOwnApp(app)) return fail(COMPUTER_USE_DENIED_TARGET_MESSAGE);

    let pid = app.running ? app.pid : 0;
    let window = pid ? await this.pickWindow(sessionId, pid, signal) : null;
    if (!window) {
      // Not running, or running without a window: opening it is an action.
      if (facts.planMode) {
        this.shared.grants.revokeThread(sessionId, 'mode-exit');
        return fail(`${app.name} is not open, and Plan mode is read-only: Computer use cannot open it. Leave Plan mode to continue.`);
      }
      const refused = await this.authorize(call, facts, {
        tool: 'get_app_state',
        risk: 'medium',
        app,
        question: `Open ${app.name}?`,
        paramLines: [{ label: 'action', value: 'Open the app in the background' }],
      });
      if (refused) return refused;
      this.emitPending(call, 'get_app_state', app.name);
      const launched = await this.drive(
        sessionId,
        'launch_app',
        app.bundleId ? { bundle_id: app.bundleId } : { name: app.launchPath || app.name },
        signal
      );
      if (launched.isError) return fail(launched.text || `Could not open ${app.name}.`);
      pid = typeof launched.structured?.pid === 'number' ? launched.structured.pid : pid;
      if (!pid) return fail(`${app.name} did not start.`);
      if (this.host.ownProcessIds().includes(pid)) return fail(COMPUTER_USE_DENIED_TARGET_MESSAGE);
      // A cold start takes a moment to put its window up.
      for (let attempt = 0; attempt < WINDOW_WAIT_ATTEMPTS && !window; attempt += 1) {
        if (attempt > 0) await delay(WINDOW_WAIT_MS, signal);
        window = await this.pickWindow(sessionId, pid, signal);
      }
      if (!window) return fail(`${app.name} is open but has no window to look at yet. Try get_app_state again.`);
    } else {
      this.emitPending(call, 'get_app_state', app.name);
    }

    const state: AppState = {
      query: appQuery.toLowerCase(),
      name: app.name,
      bundleId: app.bundleId,
      pid,
      windowId: window.windowId,
      windowTitle: window.title,
      snapshotId: null,
      tree: '',
    };
    const snapshot = await this.snapshot(call, state);
    if (snapshot.isError) return snapshot;
    this.statesOf(sessionId).set(stateKey(app), state);
    return snapshot;
  }

  private async pickWindow(
    sessionId: string,
    pid: number,
    signal?: AbortSignal
  ): Promise<{ windowId: number; title: string } | null> {
    const result = await this.drive(sessionId, 'list_windows', { pid }, signal);
    if (result.isError) return null;
    const windows = (Array.isArray(result.structured?.windows) ? result.structured.windows : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const bounds = (record.bounds && typeof record.bounds === 'object' ? record.bounds : {}) as Record<string, unknown>;
      const area = (asNumber(bounds.width) ?? 0) * (asNumber(bounds.height) ?? 0);
      if (typeof record.window_id !== 'number' || record.layer !== 0 || area <= 0) return [];
      return [
        {
          windowId: record.window_id,
          title: asString(record.title),
          onScreen: record.is_on_screen === true,
          z: typeof record.z_index === 'number' ? record.z_index : -1,
          area,
        },
      ];
    });
    // The key window: on screen first, then frontmost, then largest.
    windows.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || b.z - a.z || b.area - a.area);
    return windows[0] ?? null;
  }

  /** Reads the window: the tree for the agent, the screenshot for the agent, the HUD and the session's files. */
  private async snapshot(call: ComputerUseCall, state: AppState, preface = ''): Promise<ComputerUseToolResult> {
    const result = await this.drive(
      call.sessionId,
      'get_window_state',
      { pid: state.pid, window_id: state.windowId, screenshot_format: 'jpeg' },
      call.signal
    );
    if (result.isError) {
      return fail([preface, result.text || `Could not read ${state.name}.`].filter(Boolean).join('\n\n'));
    }
    const structured = result.structured || {};
    state.snapshotId = asString(structured.snapshot_id) || null;
    state.tree = typeof structured.tree_markdown === 'string' ? structured.tree_markdown : stripDriverHeader(result.text);
    const size =
      typeof structured.screenshot_width === 'number' && typeof structured.screenshot_height === 'number'
        ? ` · screenshot ${structured.screenshot_width}×${structured.screenshot_height} px`
        : '';
    const tree =
      state.tree.length > TREE_TEXT_LIMIT
        ? `${state.tree.slice(0, TREE_TEXT_LIMIT)}\n… (the tree was cut here)`
        : state.tree;
    const text = [
      preface,
      [
        `App: ${state.name}${state.bundleId ? ` [${state.bundleId}]` : ''}`,
        `Window: "${state.windowTitle || state.name}"${size}`,
        'Each element you can act on has an [index]: pass it as element_index. Coordinates are pixels of the screenshot.',
        ...(structured.truncated === true ? ['The tree is partial: the window has more elements than were read.'] : []),
      ].join('\n'),
      tree,
    ]
      .filter(Boolean)
      .join('\n\n');
    this.publishMedia(call, state.name, result.images);
    return { text, images: result.images, isError: false };
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private async act(
    call: ComputerUseCall,
    definition: ComputerUseToolDefinition,
    facts: ComputerUseSessionFacts,
    appQuery: string
  ): Promise<ComputerUseToolResult> {
    const state = this.findState(call.sessionId, appQuery);
    if (!state) {
      return fail(`Call get_app_state for "${appQuery}" first: it gives the window and the element indexes to act on.`);
    }
    if (
      isDeniedComputerUseTarget(state.bundleId) ||
      isDeniedComputerUseTarget(state.name) ||
      this.host.ownProcessIds().includes(state.pid)
    ) {
      return fail(COMPUTER_USE_DENIED_TARGET_MESSAGE);
    }
    const planned = planDriverCall(definition.name, call.args, state);
    if ('error' in planned) return fail(planned.error);

    const refused = await this.authorize(call, facts, {
      tool: definition.name,
      risk: definition.risk,
      app: state,
      question: `Allow Computer use to ${actionPhrase(definition.name)} in ${state.name}?`,
      paramLines: planned.paramLines,
    });
    if (refused) return refused;

    this.emitPending(call, definition.name, state.name);
    const result = await this.drive(call.sessionId, planned.tool, planned.args, call.signal);
    const outcome = result.text || (result.isError ? `${definition.name} failed.` : 'Done.');
    if (result.isError) return fail(outcome);
    // Every action returns what the window looks like now.
    const after = await this.snapshot(call, state, outcome);
    return after.isError ? { text: `${outcome}\n\n(The window could not be read afterwards: call get_app_state.)`, images: [], isError: false } : after;
  }

  /**
   * The lease, then a grant or the approval card. Returns the refusal to hand
   * back, or null when the action may run.
   */
  private async authorize(
    call: ComputerUseCall,
    facts: ComputerUseSessionFacts,
    request: {
      tool: string;
      risk: 'low' | 'medium';
      app: { name: string; bundleId: string | null };
      question: string;
      paramLines: Array<{ label: string; value: string }>;
    }
  ): Promise<ComputerUseToolResult | null> {
    const { sessionId, toolUseId } = call;
    if (!this.shared.lease.tryAcquire(sessionId, toolUseId)) return fail(COMPUTER_USE_LEASE_MESSAGE);
    if (facts.fullAccess) return null;
    const target = {
      threadId: sessionId,
      providerThreadId: null,
      generation: 0,
      server: AEGIS_COMPUTER_USE_SERVER_NAME,
      tool: request.tool,
      // By the name the card and the grant list show, as Codex's grants are.
      app: request.app.name,
      riskLevel: request.risk,
    };
    if (this.shared.grants.matchGrant(target)) return null;
    let decision: ComputerUseApprovalDecision;
    try {
      decision = await this.host.requestApproval(
        sessionId,
        {
          kind: 'computer-use',
          question: request.question,
          title: request.question,
          server: AEGIS_COMPUTER_USE_SERVER_NAME,
          toolName: request.tool,
          toolTitle: null,
          app: request.app.name,
          mutating: true,
          code: null,
          params: call.args,
          paramLines: request.paramLines,
          canAllowForSession: false,
          canAllowUntilRevoked: true,
        },
        call.signal
      );
    } catch (error) {
      this.shared.lease.release(sessionId, toolUseId);
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (!decision.allow) {
      this.shared.lease.release(sessionId, toolUseId);
      return fail(`The user declined: ${request.tool} in ${request.app.name} was not run.`);
    }
    if (decision.untilRevoked) this.shared.grants.createGrant(target);
    return null;
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  private isOwnApp(app: ListedApp): boolean {
    return (
      isDeniedComputerUseTarget(app.bundleId) ||
      isDeniedComputerUseTarget(app.name) ||
      (app.pid > 0 && this.host.ownProcessIds().includes(app.pid))
    );
  }

  private statesOf(sessionId: string): Map<string, AppState> {
    let states = this.states.get(sessionId);
    if (!states) {
      states = new Map();
      this.states.set(sessionId, states);
    }
    return states;
  }

  private findState(sessionId: string, appQuery: string): AppState | null {
    const raw = appQuery.toLowerCase();
    const wanted = (displayNameForComputerUseApp(appQuery) || appQuery).toLowerCase();
    for (const state of this.states.get(sessionId)?.values() ?? []) {
      if (
        state.query === raw ||
        state.name.toLowerCase() === wanted ||
        state.name.toLowerCase() === raw ||
        state.bundleId?.toLowerCase() === raw
      ) {
        return state;
      }
    }
    return null;
  }

  /**
   * Every call to the driver goes through here, one at a time, under the
   * driver session of the Aegis session's current turn. The switch is read
   * again at the moment of the call: a call queued before it went off must
   * not be what starts the driver again.
   */
  private drive(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<DriverToolResult> {
    const run = () => {
      if (!this.host.isEnabled()) throw new Error(COMPUTER_USE_OFF_MESSAGE);
      return this.driver.call(tool, { ...args, session: this.driverSession(sessionId) }, { signal });
    };
    const next = this.driverQueue.then(run, run);
    this.driverQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * The driver's own name for this turn of a session: it keeps snapshots and
   * the cursor overlay apart per name. A name the driver has ended cannot be
   * used again, so each turn gets a new one.
   */
  private driverSession(sessionId: string): string {
    let label = this.driverSessions.get(sessionId);
    if (!label) {
      const short = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'session';
      label = `aegis-${short}-${++this.driverSessionCount}`;
      this.driverSessions.set(sessionId, label);
    }
    return label;
  }

  private emitPending(call: ComputerUseCall, tool: string, app: string | null): void {
    const action = classifyComputerUseAction({ server: AEGIS_COMPUTER_USE_SERVER_NAME, tool, app });
    if (!action) return;
    this.host.emitLive(call.sessionId, {
      threadId: call.sessionId,
      toolUseId: call.toolUseId,
      label: formatComputerUseLabel(action, 'pending'),
      app: action.app,
      tool: action.tool,
      mutating: action.mutating,
      media: null,
      hasFreshMedia: false,
      at: Date.now(),
    });
  }

  private publishMedia(call: ComputerUseCall, app: string, images: DriverToolResult['images']): void {
    if (images.length === 0) return;
    const persisted = persistComputerUseMedia({
      userDataDir: this.host.userDataDir(),
      sessionId: call.sessionId,
      payload: images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
    });
    if (persisted.mediaRefs.length === 0) return;
    const key = `${call.sessionId}\0${call.toolUseId}`;
    this.mediaByCall.set(key, [...(this.mediaByCall.get(key) || []), ...persisted.mediaRefs]);
    this.host.emitLive(call.sessionId, {
      threadId: call.sessionId,
      toolUseId: call.toolUseId,
      label: `Looked at ${app}`,
      app,
      tool: 'get_app_state',
      mutating: false,
      media: persisted.mediaRefs[0],
      hasFreshMedia: true,
      at: Date.now(),
    });
  }
}

function stateKey(app: ListedApp): string {
  return (app.bundleId || app.name).toLowerCase();
}

/** Drops the two lines the driver puts before a tree: they name its own tokens, which agents never see. */
function stripDriverHeader(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^window_id=\d+ pid=\d+/.test(line) && !/^element_token for row/.test(line))
    .join('\n')
    .trim();
}

function actionPhrase(tool: string): string {
  switch (tool) {
    case 'click':
      return 'click';
    case 'perform_secondary_action':
      return 'perform an action';
    case 'set_value':
      return 'set a value';
    case 'scroll':
      return 'scroll';
    case 'drag':
      return 'drag';
    case 'press_key':
      return 'press a key';
    case 'type_text':
      return 'type';
    default:
      return tool;
  }
}

type PlannedCall = {
  tool: string;
  args: Record<string, unknown>;
  paramLines: Array<{ label: string; value: string }>;
};

/** One gateway action as the driver call that performs it, and the lines the approval card shows. */
export function planDriverCall(
  tool: string,
  args: Record<string, unknown>,
  state: Pick<AppState, 'pid' | 'windowId' | 'snapshotId' | 'tree'>
): PlannedCall | { error: string } {
  const windowTarget = { pid: state.pid, window_id: state.windowId };
  const paramLines: PlannedCall['paramLines'] = [];
  const elementIndex = asString(typeof args.element_index === 'number' ? String(args.element_index) : args.element_index);
  let elementToken: string | null = null;
  if (elementIndex) {
    if (!/^\d+$/.test(elementIndex)) return { error: `element_index "${elementIndex}" is not an index from the tree.` };
    if (!state.snapshotId) return { error: 'The element indexes are out of date: call get_app_state again.' };
    elementToken = `${state.snapshotId}:${elementIndex}`;
    const described = describeElement(state.tree, elementIndex);
    paramLines.push({ label: 'element', value: described ? `[${elementIndex}] ${described}` : `[${elementIndex}]` });
  }
  const needElement = (): { error: string } | null =>
    elementToken ? null : { error: 'element_index is required: an [index] from the tree get_app_state returned.' };

  switch (tool) {
    case 'click': {
      const x = asNumber(args.x);
      const y = asNumber(args.y);
      const button = asString(args.mouse_button) || 'left';
      if (!['left', 'right', 'middle'].includes(button)) return { error: 'mouse_button must be left, right or middle.' };
      const count = Math.max(1, Math.min(3, Math.round(asNumber(args.click_count) ?? 1)));
      if (button !== 'left') paramLines.push({ label: 'button', value: button });
      if (count > 1) paramLines.push({ label: 'clicks', value: String(count) });
      if (elementToken) {
        if (count === 2 && button === 'left') {
          return { tool: 'double_click', args: { element_token: elementToken }, paramLines };
        }
        return { tool: 'click', args: { element_token: elementToken, button }, paramLines };
      }
      if (x === null || y === null) return { error: 'Give an element_index, or both x and y from the screenshot.' };
      paramLines.push({ label: 'at', value: `${Math.round(x)}, ${Math.round(y)}` });
      return { tool: 'click', args: { ...windowTarget, x, y, button, count }, paramLines };
    }
    case 'perform_secondary_action': {
      const missing = needElement();
      if (missing) return missing;
      const action = normalizeSecondaryAction(asString(args.action));
      if (!action) return { error: 'action is required: one of the actions the element lists.' };
      paramLines.push({ label: 'action', value: action });
      return { tool: 'click', args: { element_token: elementToken, action }, paramLines };
    }
    case 'set_value': {
      const missing = needElement();
      if (missing) return missing;
      if (typeof args.value !== 'string') return { error: 'value is required.' };
      paramLines.push({ label: 'value', value: args.value });
      return { tool: 'set_value', args: { element_token: elementToken, value: args.value }, paramLines };
    }
    case 'scroll': {
      const missing = needElement();
      if (missing) return missing;
      const direction = asString(args.direction).toLowerCase();
      if (!['up', 'down', 'left', 'right'].includes(direction)) return { error: 'direction must be up, down, left or right.' };
      const pages = asNumber(args.pages) ?? 1;
      if (pages <= 0) return { error: 'pages must be more than 0.' };
      paramLines.push({ label: 'direction', value: direction }, { label: 'pages', value: String(pages) });
      // The driver scrolls an element in wheel notches; about five to a page.
      const amount = Math.max(1, Math.min(50, Math.round(pages * 5)));
      return { tool: 'scroll', args: { ...windowTarget, element_token: elementToken, direction, amount }, paramLines };
    }
    case 'drag': {
      const points = ['from_x', 'from_y', 'to_x', 'to_y'].map((key) => asNumber(args[key]));
      if (points.some((value) => value === null)) return { error: 'from_x, from_y, to_x and to_y are required.' };
      const [fromX, fromY, toX, toY] = points as number[];
      paramLines.push(
        { label: 'from', value: `${Math.round(fromX)}, ${Math.round(fromY)}` },
        { label: 'to', value: `${Math.round(toX)}, ${Math.round(toY)}` }
      );
      return { tool: 'drag', args: { ...windowTarget, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY }, paramLines };
    }
    case 'press_key': {
      const raw = asString(args.key);
      if (!raw) return { error: 'key is required.' };
      const parsed = parseXdotoolKey(raw);
      if ('error' in parsed) return parsed;
      paramLines.push({ label: 'key', value: raw });
      return parsed.modifiers.length > 0
        ? { tool: 'hotkey', args: { ...windowTarget, keys: [...parsed.modifiers, parsed.key] }, paramLines }
        : { tool: 'press_key', args: { ...windowTarget, key: parsed.key }, paramLines };
    }
    case 'type_text': {
      if (typeof args.text !== 'string' || !args.text) return { error: 'text is required.' };
      paramLines.push({ label: 'text', value: args.text.length > 200 ? `${args.text.slice(0, 197)}…` : args.text });
      return { tool: 'type_text', args: { ...windowTarget, text: args.text }, paramLines };
    }
    default:
      return { error: `Unknown Computer use tool "${tool}".` };
  }
}

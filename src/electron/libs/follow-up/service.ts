// Follow-up proposals: the agent proposes, the user decides, the Host starts.
// A proposal only becomes work through a user action. Sub-sessions skip the
// card: the user asked for them in words, so start_session starts one right
// away. Either way, when the session finishes a turn its result goes back to
// the conversation that started it, once that conversation is idle and none
// of the other sessions it started is still working.

import { opensTurn } from '../../../shared/turn-boundary';
import { randomUUID } from 'node:crypto';
import type { SessionContinuePayload, SessionStartPayload } from '../../../shared/types';
import type {
  FollowUpAction,
  FollowUpActionResult,
  FollowUpKind,
  FollowUpPlace,
  FollowUpProposalView,
  FollowUpStatus,
} from '../../../shared/follow-up';
import type { StreamMessage } from '../../types';
import { assistantText } from '../workflow/session-hooks';
import {
  buildFollowUpBrief,
  buildHereBrief,
  buildReportPrompt,
  buildSubSessionBrief,
  FOLLOW_UP_LIMITS,
  reportPromptLabel,
  SUB_SESSION_LIMITS,
} from './brief';
import type { FollowUpRow, FollowUpStore } from './store';

/** Open proposals one conversation may have before it must wait for the user. */
export const MAX_OPEN_FOLLOW_UPS = 5;
/** A start_session call without a tool_use id matches an identical one this recent. */
const RETRY_WINDOW_MS = 2 * 60_000;
const REPORT_MAX_CHARS = 6_000;

export interface FollowUpSessionInfo {
  title: string;
  cwd: string | null;
  provider: string;
  model: string | null;
  status: string;
  /** The project root; differs from cwd when the session runs in a worktree. */
  projectCwd?: string | null;
  /** True when the session runs in a git worktree of its own. */
  inWorktree?: boolean;
}

/** The folder a session works in, as start fields a sub-session sharing it copies. */
export type FollowUpSharedWorkspace = Pick<
  SessionStartPayload,
  'cwd' | 'projectCwd' | 'envMode' | 'worktreePath' | 'associatedWorktreePath' | 'associatedWorktreeBranch' | 'associatedWorktreeRef'
>;

export interface FollowUpWorkspace {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

export interface FollowUpHost {
  start(payload: SessionStartPayload, onCreated: (sessionId: string) => void): Promise<string | null>;
  continue(payload: SessionContinuePayload): Promise<boolean>;
  isBusy(sessionId: string): boolean;
  getSession(sessionId: string): FollowUpSessionInfo | null;
  history(sessionId: string): StreamMessage[];
  /** The parent's provider, model and permission settings, for the new session. */
  inheritedOptions(parentSessionId: string): Partial<SessionStartPayload>;
  /** A short label for the permission mode the new session would get. */
  permissionMode(parentSessionId: string): string | null;
  /** The parent's own folder, for a sub-session that shares it. */
  sharedWorkspace(parentSessionId: string): FollowUpSharedWorkspace | null;
  provision(projectCwd: string, label: string): Promise<FollowUpWorkspace>;
  worktreeExists(worktreePath: string): boolean;
  /** `git status --short` of a folder; null when unknown. */
  uncommitted(cwd: string): Promise<string[] | null>;
  broadcast(view: FollowUpProposalView): void;
}

export interface ProposeArgs {
  title: string;
  reason: string;
  plan: string;
  acceptance_criteria: string;
}

export interface StartSessionArgs {
  title: string;
  prompt: string;
  /** true: a new worktree; false: the caller's folder; omitted: follow the caller. */
  use_worktree?: boolean;
}

export type ToolOutcome = { ok: true; text: string } | { ok: false; error: string };

export class FollowUpService {
  private readonly children: Set<string>;
  /** Parents a delivery is being sent to right now. */
  private readonly delivering = new Set<string>();

  constructor(private readonly store: FollowUpStore, private readonly host: FollowUpHost) {
    this.children = new Set(store.childSessionIds());
  }

  /** Settle proposals a previous run left mid-start. Call once at startup. */
  recoverOnStartup(): void {
    this.store.recoverOnBoot();
  }

  /** Follow-up sessions get no proposal tool: one generation only. */
  isFollowUpSession(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  propose(callerSessionId: string, toolUseId: string | null, args: ProposeArgs): ToolOutcome {
    if (this.children.has(callerSessionId)) {
      return { ok: false, error: 'A follow-up task cannot propose further follow-up tasks. Mention the problem in your reply instead.' };
    }
    const session = this.host.getSession(callerSessionId);
    if (!session) return { ok: false, error: 'This conversation could not be found.' };
    if (!session.cwd) return { ok: false, error: 'This conversation has no project folder, so a follow-up task has nowhere to run.' };
    const fields = {
      title: args.title?.trim() ?? '',
      reason: args.reason?.trim() ?? '',
      plan: args.plan?.trim() ?? '',
      acceptance_criteria: args.acceptance_criteria?.trim() ?? '',
    };
    const limits: Record<keyof typeof fields, number> = {
      title: FOLLOW_UP_LIMITS.title,
      reason: FOLLOW_UP_LIMITS.reason,
      plan: FOLLOW_UP_LIMITS.plan,
      acceptance_criteria: FOLLOW_UP_LIMITS.acceptanceCriteria,
    };
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      if (!fields[key]) return { ok: false, error: `"${key}" is required.` };
      if (fields[key].length > limits[key]) return { ok: false, error: `"${key}" is longer than ${limits[key]} characters.` };
    }
    if (toolUseId) {
      const existing = this.store.findByToolUse(callerSessionId, toolUseId);
      if (existing) return { ok: true, text: this.proposeResultText(existing) };
    }
    if (this.store.countOpen(callerSessionId) >= MAX_OPEN_FOLLOW_UPS) {
      return {
        ok: false,
        error: `This conversation already has ${MAX_OPEN_FOLLOW_UPS} follow-up tasks waiting for the user. Mention this one in your reply instead.`,
      };
    }
    const { row } = this.store.insert({
      id: randomUUID(),
      parent_session_id: callerSessionId,
      tool_use_id: toolUseId,
      ...fields,
      project_cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      permission_mode: this.host.permissionMode(callerSessionId),
    });
    this.publish(row.id);
    return { ok: true, text: this.proposeResultText(row) };
  }

  withdraw(callerSessionId: string, proposalId: string): ToolOutcome {
    const row = this.store.get(proposalId);
    if (!row || row.parent_session_id !== callerSessionId) return { ok: false, error: 'No proposal with that id was made in this conversation.' };
    if (row.status === 'withdrawn') return { ok: true, text: 'The proposal was already withdrawn.' };
    if (!this.store.transition(proposalId, ['proposed'], 'withdrawn')) {
      return { ok: false, error: 'The user has already acted on this proposal, so it can no longer be withdrawn.' };
    }
    this.publish(proposalId);
    return { ok: true, text: 'The proposal was withdrawn.' };
  }

  /**
   * start_session: the user asked for a separate session, so it starts now.
   * A session that was itself started by another may only do this when the
   * user typed the request there; a brief from its parent does not count.
   */
  async startSession(callerSessionId: string, toolUseId: string | null, args: StartSessionArgs): Promise<ToolOutcome> {
    const session = this.host.getSession(callerSessionId);
    if (!session) return { ok: false, error: 'This conversation could not be found.' };
    if (!session.cwd) return { ok: false, error: 'This conversation has no project folder, so a new session has nowhere to run.' };
    const title = args.title?.trim() ?? '';
    const prompt = args.prompt?.trim() ?? '';
    // A retried call gets the session it already started, whatever happened since.
    const existing = toolUseId
      ? this.store.findByToolUse(callerSessionId, toolUseId)
      : this.store.findRecentSession(callerSessionId, title, prompt, RETRY_WINDOW_MS);
    if (existing) return this.startSessionOutcome(existing);
    // Only words the user typed start sessions: never a turn that a report,
    // a workflow or the starting session's brief began.
    if (!this.userTypedLatest(callerSessionId)) {
      return {
        ok: false,
        error: this.children.has(callerSessionId)
          ? 'Only the user can ask for a new session here: your current task came from the session that started you. Mention the work in your reply instead.'
          : 'Only the user can ask for a new session: this turn began with a message from Aegis, not from the user. Mention the work in your reply instead.',
      };
    }
    if (!title) return { ok: false, error: '"title" is required.' };
    if (!prompt) return { ok: false, error: '"prompt" is required.' };
    if (title.length > SUB_SESSION_LIMITS.title) return { ok: false, error: `"title" is longer than ${SUB_SESSION_LIMITS.title} characters.` };
    if (prompt.length > SUB_SESSION_LIMITS.prompt) return { ok: false, error: `"prompt" is longer than ${SUB_SESSION_LIMITS.prompt} characters.` };
    const place: FollowUpPlace = args.use_worktree === true ? 'worktree' : args.use_worktree === false ? 'shared' : session.inWorktree ? 'worktree' : 'shared';
    const { row } = this.store.insert({
      id: randomUUID(),
      kind: 'session',
      status: 'starting',
      place,
      parent_session_id: callerSessionId,
      tool_use_id: toolUseId,
      title,
      reason: '',
      plan: prompt,
      acceptance_criteria: '',
      // A worktree comes from the project, not from the parent's own worktree.
      project_cwd: place === 'worktree' ? session.projectCwd || session.cwd : session.cwd,
      provider: session.provider,
      model: session.model,
      permission_mode: this.host.permissionMode(callerSessionId),
    });
    this.publish(row.id);
    if (row.status === 'starting' && !row.child_session_id) await this.runStart(row.id);
    return this.startSessionOutcome(this.store.get(row.id) ?? row);
  }

  /** Take a session out from under the one that started it: it stops reporting back. */
  detach(childSessionId: string): FollowUpActionResult {
    const row = this.store.findByChild(childSessionId);
    if (!row) return { ok: false, error: 'This session was not started by another session.' };
    if (this.store.detach(childSessionId)) {
      this.children.delete(childSessionId);
      // Results its siblings held back while it ran can go now.
      void this.deliverPending(row.parent_session_id).catch((error) => console.error('[follow-up] could not deliver a result:', error));
    }
    return this.done(row.id);
  }

  /**
   * For a session working in the folder of the session that started it: that
   * session's title. Its worktree is not this session's to apply or discard.
   */
  sharedWorkspaceOwner(sessionId: string): { sessionId: string; title: string | null } | null {
    const row = this.store.findByChild(sessionId);
    if (!row || row.place !== 'shared') return null;
    return { sessionId: row.parent_session_id, title: this.host.getSession(row.parent_session_id)?.title ?? null };
  }

  list(): FollowUpProposalView[] {
    return this.store.list().map((row) => this.view(row));
  }

  async act(action: FollowUpAction): Promise<FollowUpActionResult> {
    const row = this.store.get(action.proposalId);
    if (!row) return { ok: false, error: 'This follow-up task no longer exists.' };
    // A repeated click (or a second window) with the same action gets the same answer.
    if (row.decision_action_id === action.actionId) return { ok: true, proposal: this.view(row) };
    const patch = { decision_action_id: action.actionId };
    const at = { expectedRevision: action.revision, patch };
    switch (action.kind) {
      case 'dismiss': {
        if (!this.store.transition(row.id, ['proposed', 'start_failed'], 'dismissed', at)) return this.stale(row.id);
        return this.done(row.id);
      }
      case 'here': {
        if (this.host.isBusy(row.parent_session_id)) {
          return { ok: false, error: 'This conversation is still working. Start the task here once it finishes.', proposal: this.view(row) };
        }
        if (!this.store.transition(row.id, ['proposed'], 'sent_here', at)) return this.stale(row.id);
        await this.sendHere(row);
        return this.done(row.id);
      }
      case 'start': {
        if (!this.store.transition(row.id, ['proposed'], 'starting', at)) return this.stale(row.id);
        this.publish(row.id);
        await this.runStart(row.id);
        return this.done(row.id);
      }
      case 'retry': {
        if (!this.store.transition(row.id, ['start_failed'], 'starting', at)) return this.stale(row.id);
        this.publish(row.id);
        await this.runStart(row.id);
        return this.done(row.id);
      }
      default:
        return { ok: false, error: 'Unknown action.' };
    }
  }

  /**
   * Send a follow-up's latest result to its parent by hand: for a result the
   * automatic delivery left on the card (a stopped turn, a failed send).
   */
  async continueWithReport(proposalId: string): Promise<FollowUpActionResult> {
    const row = this.store.get(proposalId);
    if (!row) return { ok: false, error: 'This follow-up task no longer exists.' };
    const latest = this.store.reports(row.id).at(-1);
    if (!latest) return { ok: false, error: 'The follow-up task has not reported a result yet.' };
    if (this.host.isBusy(row.parent_session_id) || this.delivering.has(row.parent_session_id)) {
      return { ok: false, error: 'This conversation is still working. Try again once it finishes.' };
    }
    const result = [{ proposal: row, summary: latest.summary, turnStatus: latest.turnStatus }];
    const sent = await this.host.continue({
      sessionId: row.parent_session_id,
      prompt: reportPromptLabel(result, { byHand: true }),
      effectivePrompt: buildReportPrompt(result),
      workflowPrompt: 'follow-up',
    });
    if (!sent) return { ok: false, error: 'The result could not be sent to this conversation.' };
    this.store.markProposalDelivered(row.id);
    return this.done(row.id);
  }

  /**
   * After a turn ends: send waiting follow-up results to the conversation
   * that can now take them. A follow-up's turn ending tries its parent; a
   * parent's own turn ending flushes what arrived while it worked. A turn the
   * user stopped starts nothing new.
   */
  async deliverAfterTurn(sessionId: string, status: 'completed' | 'error' | 'stopped'): Promise<void> {
    // Its own report goes up first, while it is idle: once its sessions' results
    // wake it, it counts as working and would hold its parent's delivery back.
    if (this.children.has(sessionId)) {
      const parent = this.store.findByChild(sessionId)?.parent_session_id;
      if (parent) await this.deliverPending(parent);
    }
    // Then what its own sessions reported while it worked (a sub-session can start some too).
    if (status !== 'stopped') await this.deliverPending(sessionId);
  }

  /** Send every undelivered result for one parent as a single message, when it is idle. */
  async deliverPending(parentSessionId: string): Promise<boolean> {
    if (this.delivering.has(parentSessionId) || this.host.isBusy(parentSessionId)) return false;
    if (!this.host.getSession(parentSessionId)) return false;
    // Sessions it started that are still working report later, all at once.
    if (this.store.childrenOf(parentSessionId).some((child) => child.kind === 'session' && this.host.isBusy(child.child_session_id!))) {
      return false;
    }
    const pending = this.store.undeliveredReports(parentSessionId);
    if (!pending.length) return false;
    // A proposal's latest result supersedes earlier ones; a sub-session's
    // replies all go, in order (its brief says each one is sent back).
    const latest = new Map<string, (typeof pending)[number]['report']>();
    for (const item of pending) latest.set(item.proposalId, item.report);
    const results = pending.flatMap(({ proposalId, report }) => {
      const proposal = this.store.get(proposalId);
      if (!proposal) return [];
      if (proposal.kind !== 'session' && latest.get(proposalId) !== report) return [];
      return [{ proposal, summary: report.summary, turnStatus: report.turnStatus }];
    });
    const eventIds = pending.map((item) => item.report.eventId);
    this.delivering.add(parentSessionId);
    // Marked first so a second turn end meanwhile cannot send the same result twice.
    this.store.markDelivered(eventIds);
    for (const id of latest.keys()) this.publish(id);
    let sent = false;
    try {
      sent = await this.host.continue({
        sessionId: parentSessionId,
        prompt: reportPromptLabel(results),
        effectivePrompt: buildReportPrompt(results),
        workflowPrompt: 'follow-up',
      });
    } catch (error) {
      console.error('[follow-up] could not deliver a result:', error);
    } finally {
      this.delivering.delete(parentSessionId);
      if (!sent) this.store.markDelivered(eventIds, null);
      for (const id of latest.keys()) this.publish(id);
    }
    return sent;
  }

  /** A turn ended somewhere. For a follow-up session, keep its result for the parent. */
  onTurnSettled(sessionId: string, status: 'completed' | 'error' | 'stopped', error?: string): void {
    if (!this.children.has(sessionId)) return;
    const row = this.store.findByChild(sessionId);
    if (!row) return;
    const history = this.host.history(sessionId);
    let lastPrompt = -1;
    history.forEach((message, index) => {
      if (opensTurn(message)) lastPrompt = index;
    });
    const promptAt = lastPrompt >= 0 ? history[lastPrompt].createdAt : undefined;
    const text = history
      .slice(lastPrompt + 1)
      .map((message) => assistantText(message))
      .filter((part) => part.trim())
      .join('\n\n')
      .trim();
    const summary =
      text.length > REPORT_MAX_CHARS ? `…${text.slice(-REPORT_MAX_CHARS)}` : text || error || (status === 'stopped' ? 'Stopped before replying.' : 'No reply.');
    const eventId = `${sessionId}:${promptAt ?? lastPrompt}:${status}`;
    if (this.store.insertReport({ eventId, proposalId: row.id, childSessionId: sessionId, turnStatus: status, summary })) {
      this.publish(row.id);
    }
  }

  private async sendHere(row: FollowUpRow): Promise<void> {
    let sent = false;
    let failure: string | null = null;
    try {
      // Checked again right before sending: the user may have sent a message meanwhile.
      if (this.host.isBusy(row.parent_session_id)) failure = 'This conversation started working before the task could be sent.';
      else {
        sent = await this.host.continue({
          sessionId: row.parent_session_id,
          prompt: `Follow-up task: ${row.title}`,
          effectivePrompt: buildHereBrief(row),
          workflowPrompt: 'follow-up',
        });
        if (!sent) failure = 'The task could not be sent to this conversation.';
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!sent) this.store.transition(row.id, ['sent_here'], 'proposed', { patch: { last_error: failure, decision_action_id: null } });
  }

  private async runStart(id: string): Promise<void> {
    const fail = (message: string) => {
      this.store.transition(id, ['starting'], 'start_failed', { patch: { last_error: message } });
    };
    try {
      let row = this.store.get(id);
      if (!row) return;
      // The session already exists from an earlier attempt: never make a second one.
      if (row.child_session_id) {
        const child = row.child_session_id;
        const ran = this.host.history(child).some((message) => assistantText(message).trim());
        if (!ran && this.host.getSession(child)) {
          const sent = await this.host.continue({
            sessionId: child,
            prompt: 'Retry the follow-up task',
            effectivePrompt: 'Start the follow-up task described in the first message of this conversation.',
            workflowPrompt: 'event',
          });
          if (!sent) return fail('The follow-up session could not be restarted. Open it and send a message to continue.');
        }
        this.store.transition(id, ['starting'], 'started', { patch: { last_error: null } });
        return;
      }
      if (row.place === 'shared') return await this.startShared(row);
      if (!row.worktree_path || !this.host.worktreeExists(row.worktree_path)) {
        let workspace: FollowUpWorkspace;
        try {
          workspace = await this.host.provision(row.project_cwd, row.title);
        } catch (error) {
          return fail(`Could not create a worktree: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.store.recordWorkspace(id, {
          repo_root: workspace.repoRoot,
          worktree_path: workspace.worktreePath,
          worktree_branch: workspace.branch,
          base_ref: workspace.baseRef,
        });
        row = this.store.get(id)!;
      }
      const parent = this.host.getSession(row.parent_session_id);
      const prompt =
        row.kind === 'session'
          ? await this.subSessionPrompt(row, { branch: row.worktree_branch!, baseRef: row.base_ref! })
          : {
              prompt: buildFollowUpBrief({
                proposal: row,
                parentTitle: parent?.title ?? null,
                branch: row.worktree_branch!,
                baseRef: row.base_ref!,
                parentUncommitted: await this.host.uncommitted(row.project_cwd).catch(() => null),
              }),
            };
      await this.launch(row, {
        ...prompt,
        cwd: row.worktree_path!,
        projectCwd: row.repo_root,
        envMode: 'worktree',
        worktreePath: row.worktree_path,
        associatedWorktreePath: row.worktree_path,
        associatedWorktreeBranch: row.worktree_branch,
        associatedWorktreeRef: row.base_ref,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.publish(id);
    }
  }

  /** A sub-session in its parent's own folder: no worktree to make. */
  private async startShared(row: FollowUpRow): Promise<void> {
    const workspace = this.host.sharedWorkspace(row.parent_session_id);
    if (!workspace?.cwd) {
      this.store.transition(row.id, ['starting'], 'start_failed', { patch: { last_error: 'The starting session has no folder to share.' } });
      return;
    }
    await this.launch(row, { ...(await this.subSessionPrompt(row, null)), ...workspace });
  }

  /** The brief the user sees (what the parent wrote) and the one the agent gets. */
  private async subSessionPrompt(
    row: FollowUpRow,
    worktree: { branch: string; baseRef: string } | null,
  ): Promise<Pick<SessionStartPayload, 'prompt' | 'effectivePrompt' | 'workflowPrompt'>> {
    const parent = this.host.getSession(row.parent_session_id);
    return {
      prompt: row.plan,
      effectivePrompt: buildSubSessionBrief({
        title: row.title,
        prompt: row.plan,
        parentSessionId: row.parent_session_id,
        parentTitle: parent?.title ?? null,
        worktree,
      }),
      workflowPrompt: 'sub-session',
    };
  }

  private async launch(row: FollowUpRow, fields: Partial<SessionStartPayload> & Pick<SessionStartPayload, 'prompt'>): Promise<void> {
    const payload: SessionStartPayload = {
      ...this.host.inheritedOptions(row.parent_session_id),
      title: row.title,
      skipTitleGeneration: true,
      background: true,
      scope: 'project',
      ...fields,
    };
    const sessionId = await this.host.start(payload, (created) => {
      // Registered before the runner starts, so the session never sees the proposal tool.
      this.children.add(created);
      this.store.bindChild(row.id, created);
    });
    if (sessionId) this.store.transition(row.id, ['starting'], 'started', { patch: { last_error: null } });
    else {
      this.store.transition(row.id, ['starting'], 'start_failed', {
        patch: { last_error: 'The session could not start. If it appears in the sidebar, open it to see why.' },
      });
    }
  }

  /** Whether the caller's current turn began with a message the user typed. */
  private userTypedLatest(sessionId: string): boolean {
    const history = this.host.history(sessionId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      // The prompt that opened the turn, not one steered into it later.
      if (message.type === 'user_prompt' && opensTurn(message)) return !message.workflowPrompt;
    }
    return false;
  }

  private startSessionOutcome(row: FollowUpRow): ToolOutcome {
    if (row.status === 'start_failed') {
      return { ok: false, error: `The session could not start: ${row.last_error ?? 'unknown error'}` };
    }
    const where = row.place === 'shared' ? 'in this folder, shared with you' : row.worktree_branch ? `in its own worktree on branch ${row.worktree_branch}` : 'in its own worktree';
    return {
      ok: true,
      text: JSON.stringify({
        sessionId: row.child_session_id,
        proposalId: row.id,
        status: row.status,
        note:
          `Started session "${row.title}" ${where}. It runs on its own; its result comes back here as a message when its turn ends ` +
          '(after the other sessions you started finish too). At most one line on that, then continue or end your turn; do not wait for it.',
      }),
    };
  }

  private proposeResultText(row: FollowUpRow): string {
    return JSON.stringify({
      proposalId: row.id,
      status: row.status,
      note:
        'The user now sees this proposal as a card and decides whether to run it. Continue your current task. ' +
        'Do not do the proposed work unless the user asks; if your current task ends up fixing it, withdraw the proposal.',
    });
  }

  private stale(id: string): FollowUpActionResult {
    const row = this.store.get(id);
    return { ok: false, error: 'This follow-up task has already been decided.', ...(row ? { proposal: this.view(row) } : {}) };
  }

  private done(id: string): FollowUpActionResult {
    const row = this.store.get(id);
    if (!row) return { ok: false, error: 'This follow-up task no longer exists.' };
    const view = this.view(row);
    this.host.broadcast(view);
    return { ok: true, proposal: view };
  }

  private publish(id: string): void {
    const row = this.store.get(id);
    if (row) this.host.broadcast(this.view(row));
  }

  private view(row: FollowUpRow): FollowUpProposalView {
    return {
      id: row.id,
      revision: Number(row.revision),
      kind: (row.kind ?? 'proposal') as FollowUpKind,
      parentSessionId: row.parent_session_id,
      toolUseId: row.tool_use_id,
      title: row.title,
      reason: row.reason,
      plan: row.plan,
      acceptanceCriteria: row.acceptance_criteria,
      provider: row.provider,
      model: row.model,
      permissionMode: row.permission_mode,
      status: row.status as FollowUpStatus,
      childSessionId: row.child_session_id,
      place: (row.place ?? 'worktree') as FollowUpPlace,
      worktreeBranch: row.worktree_branch,
      baseRef: row.base_ref,
      lastError: row.last_error,
      detachedAt: row.detached_at === null || row.detached_at === undefined ? null : Number(row.detached_at),
      reports: this.store.reports(row.id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

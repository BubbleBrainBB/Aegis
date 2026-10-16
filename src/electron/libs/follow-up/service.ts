// Follow-up proposals: the agent proposes, the user decides, the Host starts.
// A proposal only becomes work through a user action. When a follow-up
// finishes, its result goes back to the conversation that proposed it: right
// away when that conversation is idle, otherwise once its turn ends.

import { randomUUID } from 'node:crypto';
import type { SessionContinuePayload, SessionStartPayload } from '../../../shared/types';
import type {
  FollowUpAction,
  FollowUpActionResult,
  FollowUpProposalView,
  FollowUpStatus,
} from '../../../shared/follow-up';
import type { StreamMessage } from '../../types';
import { assistantText } from '../workflow/session-hooks';
import { buildFollowUpBrief, buildHereBrief, buildReportPrompt, FOLLOW_UP_LIMITS } from './brief';
import type { FollowUpRow, FollowUpStore } from './store';

/** Open proposals one conversation may have before it must wait for the user. */
export const MAX_OPEN_FOLLOW_UPS = 5;
const REPORT_MAX_CHARS = 6_000;

export interface FollowUpSessionInfo {
  title: string;
  cwd: string | null;
  provider: string;
  model: string | null;
  status: string;
}

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
    const sent = await this.host.continue({
      sessionId: row.parent_session_id,
      prompt: `Follow-up result: ${row.title}`,
      effectivePrompt: buildReportPrompt([{ proposal: row, summary: latest.summary, turnStatus: latest.turnStatus }]),
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
    const parent = this.children.has(sessionId) ? this.store.findByChild(sessionId)?.parent_session_id : status === 'stopped' ? null : sessionId;
    if (parent) await this.deliverPending(parent);
  }

  /** Send every undelivered result for one parent as a single message, when it is idle. */
  async deliverPending(parentSessionId: string): Promise<boolean> {
    if (this.delivering.has(parentSessionId) || this.host.isBusy(parentSessionId)) return false;
    if (!this.host.getSession(parentSessionId)) return false;
    const pending = this.store.undeliveredReports(parentSessionId);
    if (!pending.length) return false;
    // One message per proposal's latest result; earlier ones are superseded.
    const latest = new Map<string, (typeof pending)[number]['report']>();
    for (const item of pending) latest.set(item.proposalId, item.report);
    const results = [...latest].flatMap(([proposalId, report]) => {
      const proposal = this.store.get(proposalId);
      return proposal ? [{ proposal, summary: report.summary, turnStatus: report.turnStatus }] : [];
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
        prompt: `Follow-up result${results.length === 1 ? '' : 's'}: ${results.map((result) => result.proposal.title).join(' · ')}`,
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
      if (message.type === 'user_prompt') lastPrompt = index;
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
      const brief = buildFollowUpBrief({
        proposal: row,
        parentTitle: parent?.title ?? null,
        branch: row.worktree_branch!,
        baseRef: row.base_ref!,
        parentUncommitted: await this.host.uncommitted(row.project_cwd).catch(() => null),
      });
      const payload: SessionStartPayload = {
        ...this.host.inheritedOptions(row.parent_session_id),
        title: row.title,
        prompt: brief,
        skipTitleGeneration: true,
        background: true,
        scope: 'project',
        cwd: row.worktree_path!,
        projectCwd: row.repo_root,
        envMode: 'worktree',
        worktreePath: row.worktree_path,
        associatedWorktreePath: row.worktree_path,
        associatedWorktreeBranch: row.worktree_branch,
        associatedWorktreeRef: row.base_ref,
      };
      const sessionId = await this.host.start(payload, (created) => {
        // Registered before the runner starts, so the session never sees the proposal tool.
        this.children.add(created);
        this.store.bindChild(id, created);
      });
      if (sessionId) this.store.transition(id, ['starting'], 'started', { patch: { last_error: null } });
      else fail('The follow-up session could not start. If it appears in the sidebar, open it to see why.');
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.publish(id);
    }
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
      worktreeBranch: row.worktree_branch,
      baseRef: row.base_ref,
      lastError: row.last_error,
      reports: this.store.reports(row.id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

// Persistence for follow-up proposals in the app's SQLite database. Every
// state change is a conditional update, so a double click, two windows or a
// late callback cannot move a proposal twice.

import type { FollowUpReportView, FollowUpStatus } from '../../../shared/follow-up';

/** The slice of better-sqlite3 (and node:sqlite, in tests) this store uses. */
export interface FollowUpDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface FollowUpRow {
  id: string;
  revision: number;
  parent_session_id: string;
  tool_use_id: string | null;
  title: string;
  reason: string;
  plan: string;
  acceptance_criteria: string;
  project_cwd: string;
  provider: string;
  model: string | null;
  permission_mode: string | null;
  status: FollowUpStatus;
  decision_action_id: string | null;
  child_session_id: string | null;
  repo_root: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_ref: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type NewFollowUp = Pick<
  FollowUpRow,
  | 'id'
  | 'parent_session_id'
  | 'tool_use_id'
  | 'title'
  | 'reason'
  | 'plan'
  | 'acceptance_criteria'
  | 'project_cwd'
  | 'provider'
  | 'model'
  | 'permission_mode'
>;

/** Columns a transition may set besides status and revision. */
export type FollowUpPatch = Partial<
  Pick<
    FollowUpRow,
    'decision_action_id' | 'child_session_id' | 'repo_root' | 'worktree_path' | 'worktree_branch' | 'base_ref' | 'last_error'
  >
>;

const PATCH_COLUMNS: ReadonlyArray<keyof FollowUpPatch> = [
  'decision_action_id',
  'child_session_id',
  'repo_root',
  'worktree_path',
  'worktree_branch',
  'base_ref',
  'last_error',
];

export class FollowUpStore {
  constructor(private readonly db: FollowUpDb, private readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS follow_up_proposals (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        parent_session_id TEXT NOT NULL,
        tool_use_id TEXT,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        plan TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        project_cwd TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT,
        status TEXT NOT NULL,
        decision_action_id TEXT,
        child_session_id TEXT UNIQUE,
        repo_root TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        base_ref TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (parent_session_id, tool_use_id)
      );
      CREATE INDEX IF NOT EXISTS idx_follow_up_parent ON follow_up_proposals (parent_session_id);
      CREATE TABLE IF NOT EXISTS follow_up_reports (
        event_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_follow_up_reports_proposal ON follow_up_reports (proposal_id);
    `);
    const reportColumns = db.prepare('PRAGMA table_info(follow_up_reports)').all() as Array<{ name: string }>;
    if (!reportColumns.some((column) => column.name === 'delivered_at')) {
      db.exec('ALTER TABLE follow_up_reports ADD COLUMN delivered_at INTEGER');
      // Results from before automatic delivery count as handled: never send them late.
      db.exec('UPDATE follow_up_reports SET delivered_at = created_at');
    }
  }

  /**
   * Insert a proposal. A retried tool call (same parent and tool_use id)
   * returns the proposal it already made instead of a second one.
   */
  insert(record: NewFollowUp): { row: FollowUpRow; created: boolean } {
    if (record.tool_use_id) {
      const existing = this.findByToolUse(record.parent_session_id, record.tool_use_id);
      if (existing) return { row: existing, created: false };
    }
    const at = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO follow_up_proposals (id, revision, parent_session_id, tool_use_id, title, reason, plan,
          acceptance_criteria, project_cwd, provider, model, permission_mode, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      )
      .run(
        record.id,
        record.parent_session_id,
        record.tool_use_id,
        record.title,
        record.reason,
        record.plan,
        record.acceptance_criteria,
        record.project_cwd,
        record.provider,
        record.model,
        record.permission_mode,
        at,
        at,
      );
    const row =
      (record.tool_use_id ? this.findByToolUse(record.parent_session_id, record.tool_use_id) : null) ?? this.get(record.id);
    if (!row) throw new Error('The follow-up proposal could not be saved.');
    return { row, created: row.id === record.id };
  }

  get(id: string): FollowUpRow | null {
    return (this.db.prepare('SELECT * FROM follow_up_proposals WHERE id = ?').get(id) as FollowUpRow | undefined) ?? null;
  }

  findByToolUse(parentSessionId: string, toolUseId: string): FollowUpRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM follow_up_proposals WHERE parent_session_id = ? AND tool_use_id = ?')
        .get(parentSessionId, toolUseId) as FollowUpRow | undefined) ?? null
    );
  }

  findByChild(childSessionId: string): FollowUpRow | null {
    return (
      (this.db.prepare('SELECT * FROM follow_up_proposals WHERE child_session_id = ?').get(childSessionId) as
        | FollowUpRow
        | undefined) ?? null
    );
  }

  /** Proposals still waiting on the user; dismissed and withdrawn ones do not count. */
  countOpen(parentSessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM follow_up_proposals WHERE parent_session_id = ? AND status IN ('proposed', 'start_failed')`,
      )
      .get(parentSessionId) as { n: number | bigint };
    return Number(row.n);
  }

  list(limit = 500): FollowUpRow[] {
    return this.db.prepare('SELECT * FROM follow_up_proposals ORDER BY created_at DESC LIMIT ?').all(limit) as FollowUpRow[];
  }

  childSessionIds(): string[] {
    return (
      this.db.prepare('SELECT child_session_id FROM follow_up_proposals WHERE child_session_id IS NOT NULL').all() as Array<{
        child_session_id: string;
      }>
    ).map((row) => row.child_session_id);
  }

  /**
   * Move a proposal from one of `from` to `to`, optionally only at
   * `expectedRevision`. Returns false when another change got there first.
   */
  transition(
    id: string,
    from: readonly FollowUpStatus[],
    to: FollowUpStatus,
    options: { expectedRevision?: number; patch?: FollowUpPatch } = {},
  ): boolean {
    const sets = ['status = ?', 'revision = revision + 1', 'updated_at = ?'];
    const values: unknown[] = [to, this.now()];
    for (const column of PATCH_COLUMNS) {
      if (options.patch && column in options.patch) {
        sets.push(`${column} = ?`);
        values.push(options.patch[column] ?? null);
      }
    }
    let where = `id = ? AND status IN (${from.map(() => '?').join(', ')})`;
    values.push(id, ...from);
    if (options.expectedRevision !== undefined) {
      where += ' AND revision = ?';
      values.push(options.expectedRevision);
    }
    const result = this.db.prepare(`UPDATE follow_up_proposals SET ${sets.join(', ')} WHERE ${where}`).run(...values);
    return Number(result.changes) > 0;
  }

  /** Bind the session that runs a proposal; only once, only while starting. */
  bindChild(id: string, childSessionId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE follow_up_proposals SET child_session_id = ?, updated_at = ?
         WHERE id = ? AND status = 'starting' AND child_session_id IS NULL`,
      )
      .run(childSessionId, this.now(), id);
    return Number(result.changes) > 0;
  }

  /** Record where the worktree landed, so a retry reuses it. */
  recordWorkspace(id: string, workspace: Pick<FollowUpRow, 'repo_root' | 'worktree_path' | 'worktree_branch' | 'base_ref'>): void {
    this.db
      .prepare(
        `UPDATE follow_up_proposals SET repo_root = ?, worktree_path = ?, worktree_branch = ?, base_ref = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(workspace.repo_root, workspace.worktree_path, workspace.worktree_branch, workspace.base_ref, this.now(), id);
  }

  /**
   * After a restart nothing is mid-start: a proposal that already has its
   * session counts as started (the user continues there); one without failed.
   */
  recoverOnBoot(): number {
    const at = this.now();
    const started = this.db
      .prepare(
        `UPDATE follow_up_proposals SET status = 'started', revision = revision + 1, updated_at = ?
         WHERE status = 'starting' AND child_session_id IS NOT NULL`,
      )
      .run(at);
    const failed = this.db
      .prepare(
        `UPDATE follow_up_proposals SET status = 'start_failed', revision = revision + 1, updated_at = ?,
           last_error = 'Aegis quit before the follow-up session started.'
         WHERE status = 'starting' AND child_session_id IS NULL`,
      )
      .run(at);
    return Number(started.changes) + Number(failed.changes);
  }

  /** Store a result once; returns false for an event already stored. */
  insertReport(report: { eventId: string; proposalId: string; childSessionId: string; turnStatus: string; summary: string }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO follow_up_reports (event_id, proposal_id, child_session_id, turn_status, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(report.eventId, report.proposalId, report.childSessionId, report.turnStatus, report.summary, this.now());
    return Number(result.changes) > 0;
  }

  reports(proposalId: string): FollowUpReportView[] {
    return (
      this.db
        .prepare('SELECT * FROM follow_up_reports WHERE proposal_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(proposalId) as ReportRow[]
    ).map(reportView);
  }

  /**
   * Results not yet sent to a conversation, oldest first, by proposal. Turns
   * the user stopped are left out: they wait on the card instead.
   */
  undeliveredReports(parentSessionId: string): Array<{ proposalId: string; report: FollowUpReportView }> {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM follow_up_reports r JOIN follow_up_proposals p ON p.id = r.proposal_id
           WHERE p.parent_session_id = ? AND r.delivered_at IS NULL AND r.turn_status != 'stopped'
           ORDER BY r.created_at ASC, r.rowid ASC`,
        )
        .all(parentSessionId) as ReportRow[]
    ).map((row) => ({ proposalId: row.proposal_id, report: reportView(row) }));
  }

  /** Mark results as sent (or, with `at` null, as not sent after all). */
  markDelivered(eventIds: readonly string[], at: number | null = this.now()): void {
    const statement = this.db.prepare('UPDATE follow_up_reports SET delivered_at = ? WHERE event_id = ?');
    for (const eventId of eventIds) statement.run(at, eventId);
  }

  /** Mark every result of a proposal as sent. */
  markProposalDelivered(proposalId: string): void {
    this.db
      .prepare('UPDATE follow_up_reports SET delivered_at = ? WHERE proposal_id = ? AND delivered_at IS NULL')
      .run(this.now(), proposalId);
  }
}

interface ReportRow {
  event_id: string;
  proposal_id: string;
  turn_status: string;
  summary: string;
  created_at: number;
  delivered_at: number | null;
}

function reportView(row: ReportRow): FollowUpReportView {
  return {
    eventId: row.event_id,
    turnStatus: row.turn_status as FollowUpReportView['turnStatus'],
    summary: row.summary,
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : Number(row.delivered_at),
  };
}

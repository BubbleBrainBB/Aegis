// What the main bot is waiting to hear about: one row per task it started or
// wrote to. A row is armed until that task's turn ends; then it holds the
// report until the bot's conversation can take it. A task armed again before
// its report was taken keeps that report beside the one to come.
// Beside it, what the bot handed out: one row per task it started or was asked
// to write to, with the goal it serves and its last report. That row stays
// after the report was taken, so the bot can look up how a piece of work went
// without having it in its conversation. And a few values of its own.
// And its waits (waits.ts): one row per thing outside Aegis it asked to be
// woken for. A row is waiting until what it waits for happens or its deadline
// comes; then it holds how it ended until the bot's conversation took that.
// Rows that ended stay for a while: they say how often a wait was made again.

import type { MainBotWaitKind, MainBotWaitStatus } from '../../../shared/main-bot';

export interface MainBotDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface MainBotReport {
  status: string;
  text: string;
  at: number;
}

export interface MainBotWatch {
  taskId: string;
  title: string;
  device: string;
  /** When the bot last started or wrote to the task. */
  armedAt: number;
  /** Messages for a task that was working; it gets them when its turn ends. */
  held: string[];
  /** Set once the turn ended: how, and what the agent said. */
  report: MainBotReport | null;
  /** Reports of earlier turns the bot has not taken yet, oldest first. */
  earlier: MainBotReport[];
}

/** A task the bot handed work to: one it started, or one of the person's it was asked to write to. */
export interface MainBotDispatch {
  taskId: string;
  /** As they were when the bot last touched it; a list shows the task as it is now. */
  title: string;
  device: string;
  project: string | null;
  agent: string;
  /** What the person wanted that this task serves. */
  goal: string;
  origin: 'started' | 'adopted';
  createdAt: number;
  updatedAt: number;
  /** Its last report; `readAt` once the bot's conversation took it. */
  report: { status: string; gist: string; at: number; readAt: number | null } | null;
  /** Set once the task was found deleted. */
  goneAt: number | null;
}

/** A wait Aegis keeps for the bot. What it holds as JSON is read by waits.ts. */
export interface MainBotWait {
  id: number;
  label: string;
  kind: MainBotWaitKind;
  /** The pull request or run; null for a time alone. */
  target: Record<string, unknown> | null;
  /** One name per thing waited on; null for a time alone. */
  targetKey: string | null;
  events: string[];
  /** Its deadline, when it has one. */
  by: number | null;
  /** When it ends unheard, without one. */
  expiresAt: number | null;
  /** What the bot noted for itself when it set it. */
  note: string;
  taskId: string | null;
  taskTitle: string | null;
  /** How often it was made again on the same thing without the person saying so. */
  generation: number;
  baseline: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  status: MainBotWaitStatus;
  nextCheckAt: number | null;
  checkedAt: number | null;
  failures: number;
  problem: string | null;
  outcome: Record<string, unknown> | null;
  createdAt: number;
  endedAt: number | null;
  deliveredAt: number | null;
}

interface WaitRow {
  id: number | bigint;
  label: string;
  kind: string;
  target: string | null;
  target_key: string | null;
  events: string | null;
  by_at: number | bigint | null;
  expires_at: number | bigint | null;
  note: string;
  task_id: string | null;
  task_title: string | null;
  generation: number | bigint;
  baseline: string | null;
  progress: string | null;
  status: string;
  next_check_at: number | bigint | null;
  checked_at: number | bigint | null;
  failures: number | bigint;
  problem: string | null;
  outcome: string | null;
  created_at: number | bigint;
  ended_at: number | bigint | null;
  delivered_at: number | bigint | null;
}

function objectFrom(text: string | null): Record<string, unknown> | null {
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Unreadable: as if nothing had been kept.
    return null;
  }
}

const numberOrNull = (value: number | bigint | null): number | null => (value === null ? null : Number(value));

function waitFromRow(row: WaitRow): MainBotWait {
  let events: string[] = [];
  try {
    const parsed = row.events ? (JSON.parse(row.events) as unknown) : [];
    if (Array.isArray(parsed)) events = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // An unreadable list holds nothing: only being merged, closed or its deadline ends such a wait.
  }
  const kind: MainBotWaitKind = row.kind === 'pr' || row.kind === 'run' ? row.kind : 'time';
  const status: MainBotWaitStatus = (['waiting', 'fired', 'delivered', 'cancelled', 'expired'] as const).find((entry) => entry === row.status) ?? 'cancelled';
  return {
    id: Number(row.id),
    label: row.label,
    kind,
    target: objectFrom(row.target),
    targetKey: row.target_key,
    events,
    by: numberOrNull(row.by_at),
    expiresAt: numberOrNull(row.expires_at),
    note: row.note,
    taskId: row.task_id,
    taskTitle: row.task_title,
    generation: Number(row.generation),
    baseline: objectFrom(row.baseline),
    progress: objectFrom(row.progress),
    status,
    nextCheckAt: numberOrNull(row.next_check_at),
    checkedAt: numberOrNull(row.checked_at),
    failures: Number(row.failures),
    problem: row.problem,
    outcome: objectFrom(row.outcome),
    createdAt: Number(row.created_at),
    endedAt: numberOrNull(row.ended_at),
    deliveredAt: numberOrNull(row.delivered_at),
  };
}

interface DispatchRow {
  task_id: string;
  title: string;
  device: string;
  project: string | null;
  agent: string;
  goal: string;
  origin: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  report_status: string | null;
  report_gist: string | null;
  report_at: number | bigint | null;
  report_read_at: number | bigint | null;
  gone_at: number | bigint | null;
}

function dispatchFromRow(row: DispatchRow): MainBotDispatch {
  return {
    taskId: row.task_id,
    title: row.title,
    device: row.device,
    project: row.project,
    agent: row.agent,
    goal: row.goal,
    origin: row.origin === 'started' ? 'started' : 'adopted',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    report:
      row.report_status === null
        ? null
        : {
            status: row.report_status,
            gist: row.report_gist ?? '',
            at: Number(row.report_at ?? 0),
            readAt: row.report_read_at === null ? null : Number(row.report_read_at),
          },
    goneAt: row.gone_at === null ? null : Number(row.gone_at),
  };
}

interface Row {
  task_id: string;
  title: string;
  device: string;
  armed_at: number | bigint;
  held: string | null;
  report_status: string | null;
  report_text: string | null;
  reported_at: number | bigint | null;
  earlier: string | null;
}

function reportsFrom(text: string | null): MainBotReport[] {
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is MainBotReport =>
        Boolean(item) && typeof item.status === 'string' && typeof item.text === 'string' && typeof item.at === 'number',
    );
  } catch {
    // An unreadable list holds nothing.
    return [];
  }
}

function fromRow(row: Row): MainBotWatch {
  let held: string[] = [];
  try {
    const parsed = row.held ? (JSON.parse(row.held) as unknown) : [];
    if (Array.isArray(parsed)) held = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // An unreadable list holds nothing.
  }
  return {
    taskId: row.task_id,
    title: row.title,
    device: row.device,
    armedAt: Number(row.armed_at),
    held,
    report: row.report_status === null ? null : { status: row.report_status, text: row.report_text ?? '', at: Number(row.reported_at ?? 0) },
    earlier: reportsFrom(row.earlier),
  };
}

export class MainBotStore {
  constructor(private readonly db: MainBotDb) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS main_bot_watches (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        device TEXT NOT NULL DEFAULT '',
        armed_at INTEGER NOT NULL,
        held TEXT,
        report_status TEXT,
        report_text TEXT,
        reported_at INTEGER,
        earlier TEXT
      )
    `);
    const columns = db.prepare('PRAGMA table_info(main_bot_watches)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'earlier')) db.exec('ALTER TABLE main_bot_watches ADD COLUMN earlier TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS main_bot_dispatches (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '',
        project TEXT,
        agent TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'adopted',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        report_status TEXT,
        report_gist TEXT,
        report_at INTEGER,
        report_read_at INTEGER,
        gone_at INTEGER
      )
    `);
    db.exec('CREATE TABLE IF NOT EXISTS main_bot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS main_bot_waits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        target TEXT,
        target_key TEXT,
        events TEXT,
        by_at INTEGER,
        expires_at INTEGER,
        note TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        task_title TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        baseline TEXT,
        progress TEXT,
        status TEXT NOT NULL DEFAULT 'waiting',
        next_check_at INTEGER,
        checked_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        problem TEXT,
        outcome TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        delivered_at INTEGER
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_main_bot_waits_status ON main_bot_waits(status)');
    // Earlier builds kept only which tasks the bot had taken on.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'main_bot_tasks'").get() !== undefined) {
      db.exec(`
        INSERT OR IGNORE INTO main_bot_dispatches (task_id, origin, created_at, updated_at)
        SELECT task_id, 'adopted', taken_at, taken_at FROM main_bot_tasks
      `);
      db.exec('DROP TABLE main_bot_tasks');
    }
  }

  get(taskId: string): MainBotWatch | null {
    const row = this.db.prepare('SELECT * FROM main_bot_watches WHERE task_id = ?').get(taskId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  all(): MainBotWatch[] {
    return (this.db.prepare('SELECT * FROM main_bot_watches ORDER BY armed_at').all() as Row[]).map(fromRow);
  }

  /** Watch a task from now. A report the bot has not taken yet stays, to go with what comes next. */
  arm(input: { taskId: string; title: string; device: string; at: number }): void {
    const before = this.get(input.taskId);
    const earlier = before ? [...before.earlier, ...(before.report ? [before.report] : [])] : [];
    this.db
      .prepare(
        `INSERT INTO main_bot_watches (task_id, title, device, armed_at, earlier)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           title = excluded.title, device = excluded.device, armed_at = excluded.armed_at, earlier = excluded.earlier,
           report_status = NULL, report_text = NULL, reported_at = NULL`,
      )
      .run(input.taskId, input.title, input.device, input.at, earlier.length ? JSON.stringify(earlier) : null);
  }

  setHeld(taskId: string, held: string[]): void {
    this.db.prepare('UPDATE main_bot_watches SET held = ? WHERE task_id = ?').run(held.length ? JSON.stringify(held) : null, taskId);
  }

  setReport(taskId: string, report: { status: string; text: string; at: number }): void {
    this.db
      .prepare('UPDATE main_bot_watches SET report_status = ?, report_text = ?, reported_at = ? WHERE task_id = ?')
      .run(report.status, report.text, report.at, taskId);
  }

  /**
   * The bot took the first `count` reports of a task (earlier ones, then the
   * latest). With the latest taken the watch is over; a task armed again
   * meanwhile stays watched, without what was taken.
   */
  dropDelivered(taskId: string, count: number): void {
    const watch = this.get(taskId);
    if (!watch || count <= 0) return;
    if (watch.report && count > watch.earlier.length) {
      this.remove(taskId);
      return;
    }
    const left = watch.earlier.slice(count);
    this.db.prepare('UPDATE main_bot_watches SET earlier = ? WHERE task_id = ?').run(left.length ? JSON.stringify(left) : null, taskId);
  }

  /**
   * Take back reports of a task the bot has not taken yet, where `stale` says
   * so. The first `sent` of them are on their way to the bot and stay: they
   * are let go of by their place once it took them. Returns how many went.
   */
  dropEarlier(taskId: string, stale: (report: MainBotReport) => boolean, sent = 0): number {
    const watch = this.get(taskId);
    if (!watch) return 0;
    const left = watch.earlier.filter((report, index) => index < sent || !stale(report));
    const dropped = watch.earlier.length - left.length;
    if (dropped) this.db.prepare('UPDATE main_bot_watches SET earlier = ? WHERE task_id = ?').run(left.length ? JSON.stringify(left) : null, taskId);
    return dropped;
  }

  /**
   * Stop waiting for a task's current turn. Reports the bot has not taken yet
   * stay: the last of them becomes what the watch holds.
   */
  disarm(taskId: string): void {
    const watch = this.get(taskId);
    if (!watch || watch.report) return;
    const last = watch.earlier[watch.earlier.length - 1];
    if (!last) {
      this.remove(taskId);
      return;
    }
    const earlier = watch.earlier.slice(0, -1);
    this.db
      .prepare('UPDATE main_bot_watches SET held = NULL, earlier = ?, report_status = ?, report_text = ?, reported_at = ? WHERE task_id = ?')
      .run(earlier.length ? JSON.stringify(earlier) : null, last.status, last.text, last.at, taskId);
  }

  remove(taskId: string): void {
    this.db.prepare('DELETE FROM main_bot_watches WHERE task_id = ?').run(taskId);
  }

  // ---- What the bot handed out ----

  /**
   * The bot started this task, or the person had it write to it. Writing to a
   * task again brings its row up to date; the goal it was first given, and
   * how it came to the bot, stay.
   */
  record(input: {
    taskId: string;
    title: string;
    device: string;
    project: string | null;
    agent: string;
    goal: string;
    origin: 'started' | 'adopted';
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO main_bot_dispatches (task_id, title, device, project, agent, goal, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           title = excluded.title, device = excluded.device, project = excluded.project, agent = excluded.agent,
           goal = CASE WHEN main_bot_dispatches.goal = '' THEN excluded.goal ELSE main_bot_dispatches.goal END,
           updated_at = excluded.updated_at, gone_at = NULL`,
      )
      .run(input.taskId, input.title, input.device, input.project, input.agent, input.goal, input.origin, input.at, input.at);
  }

  dispatch(taskId: string): MainBotDispatch | null {
    const row = this.db.prepare('SELECT * FROM main_bot_dispatches WHERE task_id = ?').get(taskId) as DispatchRow | undefined;
    return row ? dispatchFromRow(row) : null;
  }

  /** Latest first. */
  dispatches(): MainBotDispatch[] {
    return (this.db.prepare('SELECT * FROM main_bot_dispatches ORDER BY updated_at DESC, created_at DESC, rowid DESC').all() as DispatchRow[]).map(dispatchFromRow);
  }

  /** A task the bot may write to without the person asking again. */
  hasTaken(taskId: string): boolean {
    return this.db.prepare('SELECT 1 FROM main_bot_dispatches WHERE task_id = ? AND gone_at IS NULL').get(taskId) !== undefined;
  }

  /** A turn of the task ended: what it said, not yet taken by the bot. */
  setDispatchReport(taskId: string, report: { status: string; gist: string; at: number }): void {
    this.db
      .prepare('UPDATE main_bot_dispatches SET report_status = ?, report_gist = ?, report_at = ?, report_read_at = NULL, updated_at = ? WHERE task_id = ?')
      .run(report.status, report.gist, report.at, report.at, taskId);
  }

  /** The bot's conversation took the report of `reportAt`. One that came in meanwhile stays untaken. */
  markReportRead(taskId: string, reportAt: number, at: number): void {
    this.db.prepare('UPDATE main_bot_dispatches SET report_read_at = ? WHERE task_id = ? AND report_at = ?').run(at, taskId, reportAt);
  }

  markGone(taskId: string, at: number): void {
    this.db.prepare('UPDATE main_bot_dispatches SET gone_at = ? WHERE task_id = ? AND gone_at IS NULL').run(at, taskId);
  }

  // ---- Values of its own ----

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM main_bot_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM main_bot_meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO main_bot_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- Its waits ----

  addWait(input: {
    label: string;
    kind: MainBotWaitKind;
    target: Record<string, unknown> | null;
    targetKey: string | null;
    events: string[];
    by: number | null;
    expiresAt: number | null;
    note: string;
    taskId: string | null;
    taskTitle: string | null;
    generation: number;
    baseline: Record<string, unknown> | null;
    progress: Record<string, unknown> | null;
    nextCheckAt: number | null;
    checkedAt: number | null;
    at: number;
  }): MainBotWait {
    const done = this.db
      .prepare(
        `INSERT INTO main_bot_waits
           (label, kind, target, target_key, events, by_at, expires_at, note, task_id, task_title, generation, baseline, progress, next_check_at, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.label,
        input.kind,
        input.target ? JSON.stringify(input.target) : null,
        input.targetKey,
        JSON.stringify(input.events),
        input.by,
        input.expiresAt,
        input.note,
        input.taskId,
        input.taskTitle,
        input.generation,
        input.baseline ? JSON.stringify(input.baseline) : null,
        input.progress ? JSON.stringify(input.progress) : null,
        input.nextCheckAt,
        input.checkedAt,
        input.at,
      );
    const row = this.db.prepare('SELECT * FROM main_bot_waits WHERE id = ?').get(Number(done.lastInsertRowid ?? 0)) as WaitRow | undefined;
    if (row) return waitFromRow(row);
    // A driver that does not say which row it wrote: the one just made is the newest.
    return waitFromRow(this.db.prepare('SELECT * FROM main_bot_waits ORDER BY id DESC LIMIT 1').get() as WaitRow);
  }

  wait(id: number): MainBotWait | null {
    const row = this.db.prepare('SELECT * FROM main_bot_waits WHERE id = ?').get(id) as WaitRow | undefined;
    return row ? waitFromRow(row) : null;
  }

  /** The waits that stand a certain way, oldest first; without one, all of them. */
  waits(status?: MainBotWaitStatus): MainBotWait[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM main_bot_waits WHERE status = ? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM main_bot_waits ORDER BY id').all();
    return (rows as WaitRow[]).map(waitFromRow);
  }

  /** The waits that are over, the one that ended last first. */
  endedWaits(limit: number): MainBotWait[] {
    return (this.db.prepare("SELECT * FROM main_bot_waits WHERE status != 'waiting' ORDER BY ended_at DESC, id DESC LIMIT ?").all(limit) as WaitRow[]).map(waitFromRow);
  }

  /** The last wait made on one thing, however it ended. */
  latestWaitOn(targetKey: string): MainBotWait | null {
    const row = this.db.prepare('SELECT * FROM main_bot_waits WHERE target_key = ? ORDER BY id DESC LIMIT 1').get(targetKey) as WaitRow | undefined;
    return row ? waitFromRow(row) : null;
  }

  /** A look at what a wait is for left it waiting: when, what was seen, and when to look next. */
  noteWaitChecked(id: number, input: { checkedAt: number | null; nextCheckAt: number | null; failures: number; problem: string | null; progress?: Record<string, unknown> | null }): void {
    if (input.progress === undefined) {
      this.db
        .prepare("UPDATE main_bot_waits SET checked_at = COALESCE(?, checked_at), next_check_at = ?, failures = ?, problem = ? WHERE id = ? AND status = 'waiting'")
        .run(input.checkedAt, input.nextCheckAt, input.failures, input.problem, id);
      return;
    }
    this.db
      .prepare("UPDATE main_bot_waits SET checked_at = COALESCE(?, checked_at), next_check_at = ?, failures = ?, problem = ?, progress = ? WHERE id = ? AND status = 'waiting'")
      .run(input.checkedAt, input.nextCheckAt, input.failures, input.problem, input.progress ? JSON.stringify(input.progress) : null, id);
  }

  /** Have every wait on GitHub looked at with the next round. */
  dueWaitsNow(at: number): void {
    this.db.prepare("UPDATE main_bot_waits SET next_check_at = ? WHERE status = 'waiting' AND kind != 'time'").run(at);
  }

  /** A wait is over: what it waited for happened, or its deadline came. False when it no longer waited. */
  fireWait(id: number, outcome: Record<string, unknown>, at: number): boolean {
    const done = this.db
      .prepare("UPDATE main_bot_waits SET status = 'fired', outcome = ?, ended_at = ?, next_check_at = NULL, problem = NULL WHERE id = ? AND status = 'waiting'")
      .run(JSON.stringify(outcome), at, id);
    return Number(done.changes) > 0;
  }

  /** A wait ends without waking the bot: called off, or left unheard for too long. False when it no longer waited. */
  endWait(id: number, status: 'cancelled' | 'expired', at: number): boolean {
    const done = this.db.prepare("UPDATE main_bot_waits SET status = ?, ended_at = ?, next_check_at = NULL WHERE id = ? AND status = 'waiting'").run(status, at, id);
    return Number(done.changes) > 0;
  }

  /** The bot's conversation took how these waits ended. */
  markWaitsDelivered(ids: number[], at: number): void {
    for (const id of ids) this.db.prepare("UPDATE main_bot_waits SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'fired'").run(at, id);
  }

  /** Forget waits that ended long ago. */
  pruneWaits(before: number): void {
    this.db.prepare("UPDATE main_bot_waits SET baseline = NULL, progress = NULL WHERE status != 'waiting' AND baseline IS NOT NULL").run();
    this.db.prepare("DELETE FROM main_bot_waits WHERE status IN ('delivered', 'cancelled', 'expired') AND ended_at IS NOT NULL AND ended_at < ?").run(before);
  }
}

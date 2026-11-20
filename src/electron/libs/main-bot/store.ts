// What the main bot is waiting to hear about: one row per task it started or
// wrote to. A row is armed until that task's turn ends; then it holds the
// report until the bot's conversation can take it. A task armed again before
// its report was taken keeps that report beside the one to come.
// Beside it, what the bot handed out: one row per task it started or was asked
// to write to, with the goal it serves and its last report. That row stays
// after the report was taken, so the bot can look up how a piece of work went
// without having it in its conversation. And a few values of its own.

export interface MainBotDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
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

  /** Take back reports of a task the bot has not taken yet, where `stale` says so. Returns how many. */
  dropEarlier(taskId: string, stale: (report: MainBotReport) => boolean): number {
    const watch = this.get(taskId);
    if (!watch) return 0;
    const left = watch.earlier.filter((report) => !stale(report));
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
}

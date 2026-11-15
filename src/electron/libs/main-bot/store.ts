// What the main bot is waiting to hear about: one row per task it started or
// wrote to. A row is armed until that task's turn ends; then it holds the
// report until the bot's conversation can take it. A task armed again before
// its report was taken keeps that report beside the one to come.
// Beside it, the tasks the bot has taken on: the ones it may write to without
// the user asking again.

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
    db.exec('CREATE TABLE IF NOT EXISTS main_bot_tasks (task_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL)');
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

  // ---- The tasks the bot has taken on ----

  /** The bot started this task, or the user had it write to it. */
  take(taskId: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO main_bot_tasks (task_id, taken_at) VALUES (?, ?)').run(taskId, at);
  }

  hasTaken(taskId: string): boolean {
    return this.db.prepare('SELECT 1 FROM main_bot_tasks WHERE task_id = ?').get(taskId) !== undefined;
  }

  taken(): string[] {
    return (this.db.prepare('SELECT task_id FROM main_bot_tasks').all() as Array<{ task_id: string }>).map((row) => row.task_id);
  }

  forget(taskId: string): void {
    this.db.prepare('DELETE FROM main_bot_tasks WHERE task_id = ?').run(taskId);
  }
}

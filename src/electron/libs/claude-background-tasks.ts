/**
 * Turns Claude Code's background task frames into what Aegis shows.
 *
 * - `background_tasks_changed` (REPLACE semantics) becomes the composer's
 *   chip list. The CLI sends it only when the set changes — never at a turn
 *   start — so the list must survive every turn's `system/init`. A new
 *   process starts with no tasks: its first init clears whatever an earlier
 *   process left on screen.
 * - `task_notification` (a background task completed, failed or stopped)
 *   becomes a transcript row, so its outcome shows whether or not the agent
 *   mentions it. A process resuming a session reports the previous process's
 *   unfinished tasks this way too (`stopped`, task unknown to this process).
 *
 * Pure, so the frame rules are unit-testable without the CLI.
 */

import type { BackgroundTaskInfo, BackgroundTaskOutcome } from '../../shared/types';

export type BackgroundTaskEvent =
  | { kind: 'tasks'; tasks: BackgroundTaskInfo[] }
  | { kind: 'outcome'; outcome: BackgroundTaskOutcome };

type WireTask = {
  task_id?: string;
  task_type?: string;
  description?: string;
  subagent_type?: string;
  ambient?: boolean;
};

type WireFrame = {
  type?: string;
  subtype?: string;
  task_id?: string;
  run_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  subagent_type?: string;
  status?: string;
  summary?: string;
  is_backgrounded?: boolean;
  parent_task_id?: string;
  skip_transcript?: boolean;
  ambient?: boolean;
  patch?: { is_backgrounded?: boolean };
  tasks?: WireTask[];
};

interface KnownTask {
  toolUseId?: string;
  description?: string;
  taskType?: string;
  backgrounded: boolean;
  /** Launched by a subagent: its outcome belongs to that subagent's trace. */
  nested: boolean;
  hidden: boolean;
}

const OUTCOME_STATUSES = new Set(['completed', 'failed', 'stopped']);

export class ClaudeBackgroundTasks {
  private readonly known = new Map<string, KnownTask>();
  /** Runs already reported ended (task_id + run_id): a repeat adds no row. */
  private readonly ended = new Set<string>();
  private sawInit = false;
  private sawSnapshot = false;
  private shown = false;

  /**
   * Feed every raw SDK frame. Returns what to show (possibly nothing) and
   * whether the frame was fully handled here (the caller drops it).
   */
  observe(frame: WireFrame): { events: BackgroundTaskEvent[]; consumed: boolean } {
    if (frame.type !== 'system') return { events: [], consumed: false };

    if (frame.subtype === 'init') {
      const first = !this.sawInit;
      this.sawInit = true;
      // A new process has no tasks: clear what an earlier one left.
      if (first && !this.sawSnapshot) return { events: [this.snapshot([])], consumed: false };
      return { events: [], consumed: false };
    }

    if (frame.subtype === 'task_started' && frame.task_id) {
      this.known.set(frame.task_id, {
        toolUseId: frame.tool_use_id,
        description: frame.description,
        taskType: frame.task_type,
        backgrounded: frame.is_backgrounded !== false,
        nested: Boolean(frame.parent_task_id),
        hidden: frame.skip_transcript === true || frame.ambient === true,
      });
      return { events: [], consumed: false };
    }

    if (frame.subtype === 'task_updated' && frame.task_id && frame.patch?.is_backgrounded) {
      const task = this.known.get(frame.task_id);
      if (task) task.backgrounded = true;
      return { events: [], consumed: false };
    }

    if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
      this.sawSnapshot = true;
      const running = frame.tasks.filter((task) => task.task_id && !task.ambient);
      for (const task of running) {
        const known = this.known.get(task.task_id!);
        if (known) {
          known.backgrounded = true;
          known.description ??= task.description;
          known.taskType ??= task.task_type;
        } else {
          this.known.set(task.task_id!, {
            description: task.description,
            taskType: task.task_type,
            backgrounded: true,
            nested: false,
            hidden: false,
          });
        }
      }
      return {
        events: [
          this.snapshot(
            running.map((task) => ({
              taskId: task.task_id!,
              toolUseId: this.known.get(task.task_id!)?.toolUseId,
              description: task.description ?? '',
              taskType: task.task_type ?? '',
              subagentType: task.subagent_type,
            }))
          ),
        ],
        consumed: true,
      };
    }

    if (frame.subtype === 'task_notification' && frame.task_id) {
      const status = frame.status ?? '';
      if (!OUTCOME_STATUSES.has(status)) return { events: [], consumed: false };
      // A resumed task keeps its task_id but gets a new run_id.
      const run = `${frame.task_id}\n${frame.run_id ?? ''}`;
      if (this.ended.has(run)) return { events: [], consumed: false };
      this.ended.add(run);
      const task = this.known.get(frame.task_id);
      this.known.delete(frame.task_id);
      if (frame.skip_transcript || frame.ambient) return { events: [], consumed: false };
      // Foreground work (a subagent the tool call waited on) reports through
      // its own trace row; so does anything a subagent launched. A task this
      // process never saw start is one a previous process left behind.
      if (task && (task.hidden || task.nested || !task.backgrounded)) return { events: [], consumed: false };
      return {
        events: [
          {
            kind: 'outcome',
            outcome: {
              taskId: frame.task_id,
              toolUseId: frame.tool_use_id ?? task?.toolUseId,
              status: status as BackgroundTaskOutcome['status'],
              summary: frame.summary ?? '',
              description: task?.description,
              taskType: task?.taskType,
            },
          },
        ],
        consumed: false,
      };
    }

    return { events: [], consumed: false };
  }

  /** The process ended: its background tasks ended with it. */
  end(): BackgroundTaskEvent[] {
    if (!this.shown) return [];
    return [this.snapshot([])];
  }

  private snapshot(tasks: BackgroundTaskInfo[]): BackgroundTaskEvent {
    this.shown = tasks.length > 0;
    return { kind: 'tasks', tasks };
  }
}

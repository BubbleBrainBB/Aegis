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
 * - A backgrounded Bash call's tool result names the file its output goes
 *   to; that is remembered while the task runs, for the composer's peek.
 *   Only a Bash call's own result counts, and only when the CLI's structured
 *   result names the task: text any other tool returns proves nothing.
 * - The first snapshot can list a task before its task_started names the
 *   tool call; that frame then re-sends the list with the call filled in.
 *
 * Pure, so the frame rules are unit-testable without the CLI.
 */

import type { BackgroundTaskInfo, BackgroundTaskOutcome } from '../../shared/types';
import { isTaskOutputPath, parseBackgroundOutputPath } from '../../shared/background-task-output';

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
  message?: { content?: unknown };
  tool_use_result?: unknown;
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
  /** Running tasks' output files, by task id. */
  private readonly outputFiles = new Map<string, string>();
  /** Bash calls made and not yet answered: only their results name output files. */
  private readonly bashCalls = new Set<string>();
  /** The chip list last sent. */
  private current: BackgroundTaskInfo[] = [];
  private sawInit = false;
  private sawSnapshot = false;
  private shown = false;

  /**
   * Feed every raw SDK frame. Returns what to show (possibly nothing) and
   * whether the frame was fully handled here (the caller drops it).
   */
  observe(frame: WireFrame): { events: BackgroundTaskEvent[]; consumed: boolean } {
    if (frame.type === 'assistant') {
      this.noteBashCalls(frame);
      return { events: [], consumed: false };
    }
    if (frame.type === 'user') {
      this.noteOutputFile(frame);
      return { events: [], consumed: false };
    }
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
      // Listed before its call was known: show the chip with its call now.
      const toolUseId = frame.tool_use_id;
      if (toolUseId && this.current.some((task) => task.taskId === frame.task_id && !task.toolUseId)) {
        const tasks = this.current.map((task) => (task.taskId === frame.task_id ? { ...task, toolUseId } : task));
        return { events: [this.snapshot(tasks)], consumed: false };
      }
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
      this.outputFiles.delete(frame.task_id);
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

  /** Where a running task's output goes, when its tool result said. */
  outputFile(taskId: string): string | undefined {
    return this.outputFiles.get(taskId);
  }

  private noteBashCalls(frame: WireFrame): void {
    const content = frame.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; id?: unknown; name?: unknown }>) {
      if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') this.bashCalls.add(block.id);
    }
  }

  private noteOutputFile(frame: WireFrame): void {
    const content = frame.message?.content;
    if (!Array.isArray(content)) return;
    const results = (content as Array<{ type?: string; tool_use_id?: unknown; content?: unknown }>)
      .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string');
    if (results.length !== 1) {
      for (const block of results) this.bashCalls.delete(block.tool_use_id as string);
      return;
    }
    const [block] = results;
    const toolUseId = block.tool_use_id as string;
    if (!this.bashCalls.delete(toolUseId)) return;
    // The CLI's structured result (it belongs to the frame's one tool result)
    // says the call went to the background; the text only says where.
    const taskId = (frame.tool_use_result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId;
    if (typeof taskId !== 'string') return;
    const known = this.known.get(taskId);
    if (known?.toolUseId && known.toolUseId !== toolUseId) return;
    const text = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
        : '';
    const path = parseBackgroundOutputPath(text);
    if (path && isTaskOutputPath(path, taskId)) this.outputFiles.set(taskId, path);
  }

  /** The process ended: its background tasks ended with it. */
  end(): BackgroundTaskEvent[] {
    if (!this.shown) return [];
    return [this.snapshot([])];
  }

  private snapshot(tasks: BackgroundTaskInfo[]): BackgroundTaskEvent {
    this.current = tasks;
    this.shown = tasks.length > 0;
    return { kind: 'tasks', tasks };
  }
}

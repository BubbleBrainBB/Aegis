/**
 * Claude Code's task tools (TaskCreate / TaskUpdate) replaced TodoWrite: each
 * call creates or changes one task, a task's id arrives only in the
 * TaskCreate result ("Task #3 created successfully: …"), and later updates
 * name it by that id. Replaying the calls in order yields the same list a
 * TodoWrite snapshot carries, so the todo progress card and session handoff
 * keep working for Claude sessions.
 */

export type ClaudeTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface ReplayedClaudeTask {
  id: string;
  content: string;
  status: ClaudeTaskStatus;
  activeForm?: string;
}

export interface ClaudeTaskToolCall {
  id?: string;
  name?: string;
  input?: unknown;
}

/** Calls that change the list; TaskList / TaskGet only read it. */
export const CLAUDE_TASK_WRITE_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate']);

// Claude Code parses its own result with this same pattern.
const CREATED_RESULT = /^Task #(\S+) created successfully/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function status(value: unknown): ClaudeTaskStatus | 'deleted' | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
    ? value
    : undefined;
}

/** The text of a tool_result's content (a string or an array of text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/**
 * Replays TaskCreate / TaskUpdate calls, in order, into a task list. Updates
 * to tasks created outside `calls` (an earlier turn) are skipped, since their
 * subject is unknown. Returns null when `calls` holds no task writes.
 */
export function replayClaudeTaskCalls(
  calls: ClaudeTaskToolCall[],
  resultTextFor: (toolUseId: string) => string | undefined
): { tasks: ReplayedClaudeTask[]; writes: number } | null {
  const tasks = new Map<string, ReplayedClaudeTask>();
  let writes = 0;
  for (const call of calls) {
    if (!call.name || !CLAUDE_TASK_WRITE_TOOLS.has(call.name) || !isRecord(call.input)) continue;
    writes += 1;
    if (call.name === 'TaskCreate') {
      const content = text(call.input.subject);
      if (!content) continue;
      const created = call.id ? CREATED_RESULT.exec(resultTextFor(call.id)?.trim() ?? '') : null;
      // Until its result arrives a new task is keyed by its call, which no
      // update can name yet.
      const id = created?.[1] ?? `call:${call.id ?? tasks.size}`;
      tasks.set(id, { id, content, status: 'pending', activeForm: text(call.input.activeForm) });
      continue;
    }
    const id = text(call.input.taskId);
    const task = id ? tasks.get(id) : undefined;
    if (!id || !task) continue;
    const next = status(call.input.status);
    if (next === 'deleted') {
      tasks.delete(id);
      continue;
    }
    tasks.set(id, {
      ...task,
      content: text(call.input.subject) ?? task.content,
      activeForm: text(call.input.activeForm) ?? task.activeForm,
      status: next ?? task.status,
    });
  }
  return writes > 0 ? { tasks: [...tasks.values()], writes } : null;
}

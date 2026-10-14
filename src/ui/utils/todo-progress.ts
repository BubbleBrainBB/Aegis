import {
  CLAUDE_TASK_WRITE_TOOLS,
  replayClaudeTaskCalls,
  toolResultText,
  type ClaudeTaskToolCall,
} from '../../shared/claude-task-tools';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoProgressItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface TodoProgressState {
  todos: TodoProgressItem[];
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
}

interface TodoWriteLikeBlock {
  id?: string;
  name: string;
  input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTodoStatus(value: unknown): TodoStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'in_progress' || normalized === 'completed') {
    return normalized;
  }
  return null;
}

function parseTodoItem(value: unknown): TodoProgressItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const content = typeof value.content === 'string' ? value.content.trim() : '';
  const status = normalizeTodoStatus(value.status);
  const activeForm =
    typeof value.activeForm === 'string' && value.activeForm.trim().length > 0
      ? value.activeForm.trim()
      : undefined;

  if (!content || !status) {
    return null;
  }

  return {
    content,
    status,
    activeForm,
  };
}

function lastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index])) return index;
  return -1;
}

function summarize(todos: TodoProgressItem[]): TodoProgressState | null {
  if (todos.length === 0) return null;
  const completedCount = todos.filter((todo) => todo.status === 'completed').length;
  const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length;
  return {
    todos,
    completedCount,
    inProgressCount,
    pendingCount: todos.length - completedCount - inProgressCount,
  };
}

/**
 * The latest todo list: a TodoWrite snapshot, or Claude's TaskCreate /
 * TaskUpdate calls replayed (their ids come from `toolResults`), whichever
 * was written last. `priorTaskCalls` are the session's task calls before
 * `blocks`, so an update to a task created in an earlier turn still finds it.
 */
export function extractLatestTodoProgress(
  blocks: TodoWriteLikeBlock[],
  toolResults?: Map<string, { content?: unknown }>,
  priorTaskCalls: ClaudeTaskToolCall[] = []
): TodoProgressState | null {
  const lastTaskWrite = lastIndex(blocks, (block) => CLAUDE_TASK_WRITE_TOOLS.has(block.name));
  const lastTodoWrite = lastIndex(blocks, (block) => block.name === 'TodoWrite');
  if (lastTaskWrite > lastTodoWrite) {
    const replayed = replayClaudeTaskCalls([...priorTaskCalls, ...blocks], (id) => {
      const result = toolResults?.get(id);
      return result ? toolResultText(result.content) : undefined;
    });
    return replayed
      ? summarize(replayed.tasks.map(({ content, status, activeForm }) => ({ content, status, activeForm })))
      : null;
  }

  const todoWriteBlocks = blocks.filter((block) => block.name === 'TodoWrite');
  if (todoWriteBlocks.length === 0) {
    return null;
  }

  const latestBlock = [...todoWriteBlocks].reverse().find((block) => {
    if (!isRecord(block.input)) return false;
    return Array.isArray(block.input.todos);
  });

  if (!latestBlock || !isRecord(latestBlock.input) || !Array.isArray(latestBlock.input.todos)) {
    return null;
  }

  const todos = latestBlock.input.todos
    .map((todo) => parseTodoItem(todo))
    .filter((todo): todo is TodoProgressItem => !!todo);

  return summarize(todos);
}

import { CheckCircle2, Circle, ListTodo, LoaderCircle } from './icons';
import type { TodoProgressItem, TodoProgressState } from '../utils/todo-progress';

function TodoStatusIcon({ item }: { item: TodoProgressItem }) {
  if (item.status === 'completed') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />;
  }

  if (item.status === 'in_progress') {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />;
  }

  return <Circle className="h-3.5 w-3.5 text-[var(--text-muted)]" />;
}

// Rows use the reply's body size and the trace's 12px for secondary text and
// 14px icons, so the card reads as part of the turn rather than louder than it.
export function TodoProgressCard({
  state,
  className = '',
}: {
  state: TodoProgressState;
  className?: string;
}) {
  const summaryParts = [
    `${state.completedCount}/${state.todos.length} completed`,
    state.inProgressCount > 0 ? `${state.inProgressCount} in progress` : null,
    state.pendingCount > 0 ? `${state.pendingCount} pending` : null,
  ].filter(Boolean) as string[];

  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/90 px-3 py-2.5 ${className}`.trim()}
    >
      <div className="flex items-baseline gap-2">
        <ListTodo className="h-3.5 w-3.5 flex-shrink-0 self-center text-[var(--text-secondary)]" />
        <span className="flex-shrink-0 whitespace-nowrap font-medium text-[var(--text-primary)]">Todo progress</span>
        <span className="trace-text min-w-0 truncate text-[var(--text-muted)]">{summaryParts.join(' · ')}</span>
      </div>

      <div className="mt-2 space-y-1">
        {state.todos.map((todo, index) => {
          const displayText =
            todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;

          return (
            <div key={`${todo.content}-${index}`} className="flex items-start gap-2">
              <span className="flex h-5 flex-shrink-0 items-center">
                <TodoStatusIcon item={todo} />
              </span>
              <div className="min-w-0">
                <div
                  className={`leading-5 ${
                    todo.status === 'completed'
                      ? 'text-[var(--text-secondary)] line-through'
                      : 'text-[var(--text-primary)]'
                  }`}
                >
                  {displayText}
                </div>
                {todo.status === 'in_progress' && todo.activeForm && todo.activeForm !== todo.content && (
                  <div className="trace-text text-[var(--text-muted)]">{todo.content}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

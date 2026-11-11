import { formatAge } from '../utils/sidebar-view';
import { formatTaskNumber, type TaskSuggestion } from '../utils/task-mentions';

/** The composer's `#` menu: tasks to reference, by number and title. */
export function TaskMentionMenu({
  suggestions,
  selectedIndex,
  onSelect,
}: {
  suggestions: TaskSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: TaskSuggestion) => void;
}) {
  return (
    <div
      className="mx-4 mb-3 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_10px_28px_rgba(0,0,0,0.045)]"
      data-task-mention-menu
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
        <span>Tasks</span>
        <kbd className="rounded border border-[var(--border)] px-1 font-sans text-[10px] normal-case leading-4 tracking-normal">Tab</kbd>
      </div>
      <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
        {suggestions.map((suggestion, index) => (
          <button
            key={suggestion.id}
            type="button"
            data-task-number={suggestion.number}
            aria-selected={index === selectedIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(suggestion);
            }}
            className={`flex w-full items-center gap-2.5 rounded-[var(--radius-lg)] px-2.5 py-1.5 text-left text-[12px] leading-4 transition-colors ${
              index === selectedIndex ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]/80'
            }`}
          >
            <span className="flex-shrink-0 tabular-nums text-[var(--text-muted)]">{formatTaskNumber(suggestion.number)}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{suggestion.title}</span>
            <span className="flex-shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{formatAge(suggestion.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  filterTaskSuggestions,
  getTaskMentionState,
  insertTaskMention,
  type TaskSuggestion,
} from '../utils/task-mentions';

/**
 * The composer's `#` menu: the tasks the typed number or title names. Picking
 * one hands the prompt back with that task's conversation link in place of the
 * typed text.
 */
export function useTaskMentions({
  prompt,
  cursorIndex,
  currentSessionId,
  enabled,
  onInsert,
}: {
  prompt: string;
  cursorIndex: number;
  /** The task being written in, which cannot name itself. */
  currentSessionId?: string | null;
  /** Off where a reference would not resolve (runtimes without them, tasks on another Mac) and while another menu has the input. */
  enabled: boolean;
  onInsert: (next: { prompt: string; cursorIndex: number }) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Arrow keys mean the menu is in use; until then Enter still sends the message.
  const [navigated, setNavigated] = useState(false);

  const mention = useMemo(
    () => (enabled ? getTaskMentionState(prompt, cursorIndex) : null),
    [cursorIndex, enabled, prompt]
  );
  const query = mention?.query ?? null;

  const suggestions = useMemo(() => {
    if (query === null) return [];
    // Read when the menu opens rather than subscribing: every streamed
    // message replaces the sessions map.
    const tasks: TaskSuggestion[] = Object.values(useAppStore.getState().sessions).flatMap((session) =>
      session.number && session.id !== currentSessionId && !session.hiddenFromThreads && !session.isDraft && !session.device
        ? [{ id: session.id, number: session.number, title: session.title, updatedAt: session.updatedAt }]
        : []
    );
    return filterTaskSuggestions(tasks, query);
  }, [currentSessionId, query]);

  useEffect(() => {
    setSelectedIndex(0);
    setNavigated(false);
  }, [query]);

  // `#167` that names no task (a pull request, a heading) shows nothing.
  const open = mention !== null && suggestions.length > 0;

  const select = (suggestion: TaskSuggestion) => {
    if (mention) onInsert(insertTaskMention(prompt, mention, suggestion.id));
  };

  return {
    open,
    suggestions,
    selectedIndex: Math.min(selectedIndex, Math.max(0, suggestions.length - 1)),
    select,
    /** True when the menu took the key. */
    handleKeyDown: (event: KeyboardEvent): boolean => {
      // Modified keys select text and move the cursor; they stay with the editor.
      if (!open || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSelectedIndex((current) => (current + step + suggestions.length) % suggestions.length);
        setNavigated(true);
        return true;
      }
      // Tab picks. Enter does only after the arrows: "PR #167" then Enter must send.
      if (event.key === 'Tab' || (event.key === 'Enter' && navigated)) {
        event.preventDefault();
        select(suggestions[Math.min(selectedIndex, suggestions.length - 1)]);
        return true;
      }
      return false;
    },
  };
}

import { createSessionLink, extractSessionLinks } from '../../shared/session-links';

/**
 * Naming another task in the composer by its short number: typing `#` offers
 * the tasks, and picking one puts its conversation link in the prompt. A typed
 * `#128` is never a reference on its own, because the same text names pull
 * requests and issues.
 */

export interface TaskMentionState {
  query: string;
  start: number;
  end: number;
}

export interface TaskSuggestion {
  id: string;
  number: number;
  title: string;
  updatedAt: number;
}

export function formatTaskNumber(number: number): string {
  return `#${number}`;
}

/**
 * The `#query` the cursor sits at the end of. The `#` may follow any text
 * written without spaces (Chinese) but not a word, path, entity or file
 * mention it is part of (`C#`, `page#top`, `&#39;`, `@#notes`).
 *
 * What a pick replaces ends at the cursor, so the text after it stays: a
 * closing bracket, or the rest of a sentence written without spaces. Only a
 * number the cursor is inside of is taken whole.
 */
export function getTaskMentionState(prompt: string, cursorIndex: number): TaskMentionState | null {
  const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
  const match = prompt.slice(0, cursor).match(/(?<![\w/#&@])#([^\s#]*)$/);
  if (!match) return null;
  const query = match[1];
  let end = cursor;
  if (/^\d*$/.test(query)) while (end < prompt.length && /\d/.test(prompt[end])) end += 1;
  return { query, start: cursor - query.length - 1, end };
}

/** 0 the number itself, 1 a number or title that starts with the query, 2 a title that contains it. */
function rankTask(task: TaskSuggestion, query: string): number | null {
  const number = String(task.number);
  const title = task.title.toLowerCase();
  if (number === query) return 0;
  if (/^\d+$/.test(query) && number.startsWith(query)) return 1;
  if (title.startsWith(query)) return 1;
  return title.includes(query) ? 2 : null;
}

/** Tasks a query names, best first; the most recent ones while nothing is typed. */
export function filterTaskSuggestions(tasks: readonly TaskSuggestion[], rawQuery: string, limit = 8): TaskSuggestion[] {
  const query = rawQuery.trim().toLowerCase();
  const recent = (a: TaskSuggestion, b: TaskSuggestion) => b.updatedAt - a.updatedAt;
  if (!query) return [...tasks].sort(recent).slice(0, limit);
  return tasks
    .flatMap((task) => {
      const rank = rankTask(task, query);
      return rank === null ? [] : [{ task, rank }];
    })
    .sort((a, b) => a.rank - b.rank || recent(a.task, b.task))
    .slice(0, limit)
    .map((entry) => entry.task);
}

/** Replace the typed `#query` with the task's conversation link, which the composer shows as a chip. */
export function insertTaskMention(
  prompt: string,
  mention: TaskMentionState,
  sessionId: string
): { prompt: string; cursorIndex: number } {
  // A link runs until a space or closing punctuation (extractSessionLinks);
  // any other text after it would be read as part of it, so a space goes between.
  // The same holds before it: after a colon ("see:#128") it would not be read as a link.
  const before = prompt.slice(0, mention.start);
  const rest = prompt.slice(mention.end);
  const link = `${/[\w/:]$/.test(before) ? ' ' : ''}${createSessionLink(sessionId)}`;
  const gap = /^[\s<>"'`[\]()，。！？；、]/.test(rest) ? '' : ' ';
  return {
    prompt: `${before}${link}${gap}${rest}`,
    cursorIndex: mention.start + link.length + (gap || /^\s/.test(rest) ? 1 : 0),
  };
}

/**
 * A task on another Mac is sent there whole, so a link to a task on this Mac
 * would name nothing it can read. The message to show when a prompt bound
 * for another Mac holds one, else null.
 */
export function localReferenceError(
  prompt: string,
  sessions: Readonly<Record<string, { device?: unknown } | undefined>>
): string | null {
  const local = extractSessionLinks(prompt).some((link) => {
    const session = sessions[link.sessionId];
    return session !== undefined && !session.device;
  });
  return local ? "A task on another Mac can't read tasks on this Mac. Remove the reference to send." : null;
}

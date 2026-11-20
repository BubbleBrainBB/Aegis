// Day dividers for a conversation that runs on for days (the main bot's): one
// above the first thing drawn on each day, in the reader's local time.

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function startOfLocalDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Today / Yesterday / the weekday within a week / "Nov 12", with the year once it differs. */
export function conversationDayLabel(day: number, now: number): string {
  const date = new Date(day);
  // Rounded: a day is 23 or 25 hours long where the clocks change.
  const daysAgo = Math.round((startOfLocalDay(now) - startOfLocalDay(day)) / 86_400_000);
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo < 7) return WEEKDAY_FORMAT.format(date);
  return date.getFullYear() === new Date(now).getFullYear()
    ? MONTH_DAY_FORMAT.format(date)
    : MONTH_DAY_YEAR_FORMAT.format(date);
}

/**
 * Where a new day starts in a list of rows: the index of the first row of each
 * day, with that day's start. A row without a time (nothing is drawn for it,
 * or it carries none) never opens a day. A row stamped earlier than the day
 * already shown stays in it, so the dates above only ever move forward.
 */
export function dayStarts(times: ReadonlyArray<number | null | undefined>): Map<number, number> {
  const starts = new Map<number, number>();
  let shown = -Infinity;
  times.forEach((time, index) => {
    if (typeof time !== 'number' || !Number.isFinite(time)) return;
    const day = startOfLocalDay(time);
    if (day <= shown) return;
    shown = day;
    starts.set(index, day);
  });
  return starts;
}

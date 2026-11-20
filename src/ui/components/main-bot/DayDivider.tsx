import { useMinuteClock } from '../../hooks/useMinuteClock';
import { conversationDayLabel } from '../../utils/conversation-days';

/**
 * The day the rows below were written on: a plain grey rule with the date in
 * its middle. Quiet on purpose, so it does not read as the wavy "New" rule
 * that marks a fresh context.
 */
export function DayDivider({ day, first = false }: { day: number; first?: boolean }) {
  // The label moves on with the clock: "Today" turns into "Yesterday" at midnight.
  const label = conversationDayLabel(day, useMinuteClock());
  return (
    <div role="separator" aria-label={label} className={`${first ? 'mb-5' : 'mb-5 mt-7'} flex items-center gap-3.5`} data-day-divider={label}>
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-[var(--border)]" />
      <time dateTime={isoDay(day)} className="flex-shrink-0 text-[12px] leading-[18px] text-[var(--text-muted)]">{label}</time>
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-[var(--border)]" />
    </div>
  );
}

function isoDay(day: number): string {
  const date = new Date(day);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

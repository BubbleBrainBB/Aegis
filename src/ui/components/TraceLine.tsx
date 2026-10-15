import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronRight, LoaderCircle } from './icons';

/**
 * Status tints for a line: `active` lifts the title while a step runs or waits,
 * `waiting` colors the icon and meta amber, `error` colors the icon red.
 */
export type TraceTone = 'default' | 'active' | 'waiting' | 'error';

interface TraceLineProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** What kind of step this is. Always present so every title shares one left edge. */
  icon: ReactNode;
  title: ReactNode;
  /** Small facts after the title: elapsed, diff stat, exit code, failed count. */
  meta?: ReactNode;
  /** One glyph after the meta: chevron, spinner, link arrow or interrupted mark. */
  trail?: ReactNode;
  tone?: TraceTone;
  /** Native tooltip for the whole line. */
  hint?: string;
  /** Static lines (errors, approvals) render as a div instead of a button. */
  as?: 'button' | 'div';
}

/** One step in an agent trace: icon, title, meta, trailing glyph. */
export function TraceLine({
  icon,
  title,
  meta,
  trail,
  tone = 'default',
  hint,
  as = 'button',
  className = '',
  ...props
}: TraceLineProps) {
  const content = (
    <>
      <span className="trace-line-icon" aria-hidden="true">{icon}</span>
      <span className="trace-line-title">{title}</span>
      {meta ? <span className="trace-line-meta">{meta}</span> : null}
      {trail ? <span className="trace-line-trail" aria-hidden="true">{trail}</span> : null}
    </>
  );
  const classes = `trace-line ${className}`.trim();
  if (as === 'div') {
    return <div className={classes} data-tone={tone} title={hint}>{content}</div>;
  }
  return <button type="button" className={classes} data-tone={tone} title={hint} {...props}>{content}</button>;
}

/** Children and details of a line: indented to its title under a guide at the icon's center. */
export function TraceNest({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`trace-nest ${className}`.trim()}>{children}</div>;
}

export function TraceChevron({ expanded }: { expanded: boolean }) {
  return <ChevronRight className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />;
}

export function TraceSpinner() {
  return <LoaderCircle className="animate-spin" />;
}

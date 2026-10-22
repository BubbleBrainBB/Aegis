import { useState, type CSSProperties, type FocusEvent } from 'react';
import type { ClaudeContextUsage } from '../../shared/types';
import { getContextLevelColorVar, getContextUsageLevel } from '../utils/context-usage';

const RING_CIRCUMFERENCE = 37.7;
// Segments narrower than this vanish into the 1.5px gaps, so the bar skips
// them; their rows still list the tokens.
const MIN_SEGMENT_PERCENT = 0.15;

type ContextCategory = ClaudeContextUsage['categories'][number];

export type ContextBreakdown = {
  categories: ContextCategory[];
  counts?: ClaudeContextUsage['counts'];
};

export type ContextWindowUsage = {
  used: number;
  /** Window size; 0 when the provider has not reported one. */
  total: number;
  percent: number;
  estimated?: boolean;
};

// Claude Code names its rows in English and offers no stable id, so color
// follows the name; anything unlisted shares the neutral.
const CATEGORY_COLORS: Record<string, string> = {
  Messages: 'var(--context-messages)',
  'System tools': 'var(--context-system-tools)',
  'MCP tools': 'var(--context-mcp-tools)',
  'System prompt': 'var(--context-system-prompt)',
  Skills: 'var(--context-skills)',
};

const FREE_FILL = 'color-mix(in srgb, var(--text-primary) 7%, transparent)';
const BUFFER_FILL =
  'repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-primary) 18%, transparent) 0 2px, color-mix(in srgb, var(--text-primary) 5%, transparent) 2px 5px)';

export function formatContextTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const trim = (scaled: number) => scaled.toFixed(1).replace(/\.0$/, '');
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function categoryCount(name: string, counts: ContextBreakdown['counts']): string | null {
  const count =
    name === 'MCP tools' ? counts?.mcpTools
    : name === 'Memory files' ? counts?.memoryFiles
    : name === 'Custom agents' ? counts?.agents
    : name === 'Skills' ? counts?.skills
    : undefined;
  if (!count) return null;
  const noun = name === 'MCP tools' ? 'tool' : name === 'Memory files' ? 'file' : name === 'Custom agents' ? 'agent' : 'skill';
  return plural(count, noun);
}

function UsageRing({ percent }: { percent: number }) {
  const progress = Math.min(100, Math.max(0, percent));
  return (
    <svg className="h-4 w-4 -rotate-90" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke={getContextLevelColorVar(getContextUsageLevel(progress))}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
        style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
      />
    </svg>
  );
}

type Row = { key: string; name: string; tokens: number; fill: string; count?: string | null; reserve?: boolean };

function buildRows(usage: ContextWindowUsage, breakdown: ContextBreakdown | undefined) {
  const categories = breakdown?.categories ?? [];
  const used = categories
    .filter((category) => category.kind === 'used' && category.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);
  if (used.length === 0) return null;

  const rows: Row[] = used.map((category) => ({
    key: `used:${category.name}`,
    name: category.name,
    tokens: category.tokens,
    fill: CATEGORY_COLORS[category.name] ?? 'var(--context-other)',
    count: categoryCount(category.name, breakdown?.counts),
  }));
  const buffer = categories.find((category) => category.kind === 'buffer');
  const reportedFree = categories.find((category) => category.kind === 'free');
  // Sessions saved before free space was kept only carry used and buffer rows.
  const freeTokens = reportedFree?.tokens ?? (usage.total > 0 ? Math.max(0, usage.total - usage.used - (buffer?.tokens ?? 0)) : 0);
  if (freeTokens > 0) {
    rows.push({ key: 'free', name: reportedFree?.name ?? 'Free space', tokens: freeTokens, fill: FREE_FILL, reserve: true });
  }
  if (buffer && buffer.tokens > 0) {
    rows.push({ key: 'buffer', name: buffer.name, tokens: buffer.tokens, fill: BUFFER_FILL, reserve: true });
  }
  const deferred = categories
    .filter((category) => category.kind === 'deferred' && category.tokens > 0)
    .map((category) => ({ name: category.name.replace(/\s*\(deferred\)$/i, ''), tokens: category.tokens }));
  return { rows, deferred };
}

function Swatch({ fill, outline }: { fill?: string; outline?: boolean }) {
  const style: CSSProperties = outline
    ? { boxShadow: 'inset 0 0 0 1px var(--text-muted)' }
    : { background: fill, boxShadow: fill === FREE_FILL ? 'inset 0 0 0 1px var(--border)' : undefined };
  return <i className="block h-2 w-2 rounded-[2px]" style={style} />;
}

const ROW = 'grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 text-[12px] leading-5';

export function ContextUsagePopover({
  modelLabel,
  usage,
  breakdown,
  waitingLabel = 'Waiting for usage from this model.',
}: {
  modelLabel: string;
  usage: ContextWindowUsage | null;
  breakdown?: ContextBreakdown;
  waitingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [deferredOpen, setDeferredOpen] = useState(false);
  const percent = usage?.percent ?? 0;
  const level = getContextUsageLevel(percent);
  const hasTotal = !!usage && usage.total > 0;
  const detail = usage ? buildRows(usage, breakdown) : null;
  const segments = usage && hasTotal
    ? (detail?.rows ?? [
        { key: 'used', name: 'Used', tokens: usage.used, fill: getContextLevelColorVar(level) },
        { key: 'free', name: 'Free space', tokens: Math.max(0, usage.total - usage.used), fill: FREE_FILL },
      ])
        .map((row) => ({ ...row, width: (row.tokens / usage.total) * 100 }))
        .filter((segment) => segment.width >= MIN_SEGMENT_PERCENT)
    : [];
  const deferredTotal = detail?.deferred.reduce((sum, row) => sum + row.tokens, 0) ?? 0;

  const closeUnlessInside = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={closeUnlessInside}
    >
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        aria-label="Context window usage"
      >
        <UsageRing percent={percent} />
      </button>

      {open && (
        // The bottom padding bridges the gap to the ring, so moving the
        // pointer onto the card does not close it.
        <div className="absolute bottom-full right-0 z-40 pb-1.5">
          <div
            className={`flex ${detail ? 'w-[300px]' : 'w-[248px]'} max-w-[calc(100vw-1.5rem)] flex-col gap-2.5 rounded-[10px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] p-3 text-[13px] font-normal leading-[18px] text-[var(--text-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)]`}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[var(--text-secondary)]">{modelLabel}</span>
                {hasTotal ? (
                  <span
                    className="shrink-0 text-[20px] font-semibold leading-6 tracking-[-0.01em] tabular-nums"
                    style={level === 'safe' ? undefined : { color: getContextLevelColorVar(level) }}
                  >
                    {percent}%
                  </span>
                ) : null}
              </div>
              <span className="text-[11px] leading-4 text-[var(--text-muted)] tabular-nums">
                {usage
                  ? `${formatContextTokens(usage.used)}${hasTotal ? ` of ${formatContextTokens(usage.total)}` : ''} tokens${usage.estimated ? ' · estimated' : ''}`
                  : waitingLabel}
              </span>
            </div>

            {segments.length > 0 ? (
              <div className="flex h-2 gap-[1.5px] overflow-hidden rounded-full">
                {segments.map((segment) => (
                  <i key={segment.key} className="block h-full" style={{ width: `${segment.width}%`, background: segment.fill }} />
                ))}
              </div>
            ) : null}

            {detail ? (
              <div className="flex flex-col gap-px">
                {detail.rows.map((row) => (
                  <div key={row.key} className={ROW}>
                    <Swatch fill={row.fill} />
                    <span className={`flex min-w-0 items-baseline gap-1.5 ${row.reserve ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>
                      <span className="truncate">{row.name}</span>
                      {row.count ? <span className="shrink-0 text-[11px] text-[var(--text-muted)] tabular-nums">{row.count}</span> : null}
                    </span>
                    <span className={`tabular-nums ${row.reserve ? 'text-[var(--text-muted)]' : ''}`}>{formatContextTokens(row.tokens)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {detail && detail.deferred.length > 0 ? (
              <div className="flex flex-col gap-px">
                <button
                  type="button"
                  className={`${ROW} w-full rounded-[4px] text-left text-[var(--text-muted)] hover:text-[var(--text-secondary)]`}
                  aria-expanded={deferredOpen}
                  data-context-deferred-toggle
                  onClick={() => setDeferredOpen((value) => !value)}
                >
                  <svg
                    className={`h-2 w-2 transition-transform ${deferredOpen ? 'rotate-90' : ''}`}
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 1l3 3-3 3" />
                  </svg>
                  <span className="truncate">Deferred tools</span>
                  <span className="tabular-nums">{formatContextTokens(deferredTotal)}</span>
                </button>
                {deferredOpen
                  ? detail.deferred.map((row) => (
                      <div key={row.name} className={`${ROW} pl-4 text-[var(--text-muted)]`}>
                        <Swatch outline />
                        <span className="truncate">{row.name}</span>
                        <span className="tabular-nums">{formatContextTokens(row.tokens)}</span>
                      </div>
                    ))
                  : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

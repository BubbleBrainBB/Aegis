import { useState, type ReactNode } from 'react';
import type { AgentProvider, UsageCostByType } from '../../types';
import { formatBillingCount, formatCompactNumber, formatCurrency, formatShortDate } from '../../utils/usage-format';
import { costAxis, type OverviewAgentRow, type OverviewDay, type UsageOverview } from '../../utils/usage-overview-model';

const SERIES_COLORS = ['var(--usage-series-1)', 'var(--usage-series-2)', 'var(--usage-series-3)', 'var(--usage-series-4)'];
const OTHER_COLOR = 'var(--usage-series-other)';

/** The agent's color in the list and the chart: the four that cost most have their own. */
function seriesColor(row: OverviewAgentRow | undefined): string {
  return row && row.series !== null ? SERIES_COLORS[row.series] : OTHER_COLOR;
}

/** What an agent without dollars used, in its own unit. */
function ownUnitLabel(own: NonNullable<OverviewAgentRow['own']>): string {
  const parts: string[] = [];
  if (own.messages > 0) parts.push(`${formatBillingCount(own.messages)} ${own.messages === 1 ? 'message' : 'messages'}`);
  if (own.credits > 0) parts.push(`${formatBillingCount(own.credits)} credits`);
  if (parts.length) return parts.join(' · ');
  if (own.tokens > 0) return `${formatCompactNumber(own.tokens)} tokens`;
  return `${own.sessions.toLocaleString('en-US')} ${own.sessions === 1 ? 'session' : 'sessions'}`;
}

function formatShare(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
}

/**
 * The top of the overview: the cost total, agents ranked by cost beside cost
 * per day, and the cost split by type.
 */
export function UsageOverviewCards({ overview, logoFor, onSelectAgent }: {
  overview: UsageOverview;
  logoFor(provider: AgentProvider): ReactNode;
  onSelectAgent(provider: AgentProvider): void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-usage-total>
        <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
          {formatCurrency(overview.totalCostUsd, overview.estimated)}
        </span>
        <span className="text-[17px] font-medium text-[var(--text-secondary)]">at API prices</span>
        <span className="ml-2 text-[13px] tabular-nums text-[var(--text-muted)]" data-usage-total-detail>
          {formatCompactNumber(overview.totalTokens)} tokens · {overview.sessionCount.toLocaleString('en-US')} {overview.sessionCount === 1 ? 'session' : 'sessions'}
        </span>
      </div>

      <div className="@container">
        <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] @[720px]:flex-row">
          <AgentList agents={overview.agents} logoFor={logoFor} onSelectAgent={onSelectAgent} />
          <DailyCost overview={overview} logoFor={logoFor} />
        </div>
      </div>

      {overview.costByType && overview.totalCostUsd > 0 ? <CostByType split={overview.costByType} /> : null}
    </>
  );
}

function AgentList({ agents, logoFor, onSelectAgent }: {
  agents: OverviewAgentRow[];
  logoFor(provider: AgentProvider): ReactNode;
  onSelectAgent(provider: AgentProvider): void;
}) {
  return (
    // Beside the chart the list is as wide as its longest row needs, up to 336px: the rest is the chart's.
    <div className="flex flex-none flex-col gap-2.5 border-b border-[var(--border)] px-5 py-4 @[720px]:w-fit @[720px]:min-w-[224px] @[720px]:max-w-[336px] @[720px]:border-b-0 @[720px]:border-r" data-usage-agents>
      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">By agent</div>
      <div className="-mx-2 flex flex-col">
        {agents.map((row) => (
          <button
            key={row.provider}
            type="button"
            onClick={() => onSelectAgent(row.provider)}
            data-usage-agent={row.provider}
            className="flex h-[30px] items-center gap-2 rounded-md px-2 text-left text-[13px] tabular-nums outline-none transition-colors hover:bg-[var(--sidebar-item-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
          >
            <span
              className="h-2 w-2 flex-none rounded-full"
              style={{ backgroundColor: row.costUsd === null ? 'transparent' : seriesColor(row) }}
              aria-hidden="true"
            />
            {logoFor(row.provider)}
            <span className="min-w-0 flex-1 truncate pr-3 font-medium text-[var(--text-primary)]" data-usage-agent-name>{row.title}</span>
            {row.costUsd === null ? (
              <span className="whitespace-nowrap text-[var(--text-secondary)]" data-usage-agent-own>{ownUnitLabel(row.own!)}</span>
            ) : (
              <span className="whitespace-nowrap text-[var(--text-primary)]" data-usage-agent-cost>{formatCurrency(row.costUsd, row.estimated)}</span>
            )}
            <span className="w-11 flex-none text-right text-[12.5px] text-[var(--text-secondary)]">
              {row.share === null ? '' : formatShare(row.share)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatAxisUsd(value: number): string {
  if (value >= 1000) return `$${formatCompactNumber(Number(value.toPrecision(3)))}`;
  if (value >= 1) return `$${Number(value.toFixed(2))}`;
  return `$${Number(value.toPrecision(2))}`;
}

/**
 * One line per agent over the range, a point per day. The four agents that
 * cost most have their own line; the rest share one gray line. Hovering a
 * point lists that day, each agent by its logo.
 */
function DailyCost({ overview, logoFor }: { overview: UsageOverview; logoFor(provider: AgentProvider): ReactNode }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { days, agents } = overview;
  const rowOf = new Map(agents.map((row) => [row.provider, row]));
  const costOn = (day: OverviewDay, provider: AgentProvider) =>
    day.agents.find((entry) => entry.provider === provider)?.costUsd ?? 0;
  const dollarRows = agents.filter((row) => row.costUsd !== null);
  const lines = [
    ...dollarRows.filter((row) => row.series !== null).map((row) => ({
      key: row.provider as string,
      color: seriesColor(row),
      values: days.map((day) => costOn(day, row.provider)),
    })),
    ...(dollarRows.some((row) => row.series === null) ? [{
      key: 'other',
      color: OTHER_COLOR,
      values: days.map((day) => day.agents.reduce((sum, entry) => sum + (rowOf.get(entry.provider)?.series === null ? entry.costUsd : 0), 0)),
    }] : []),
  ];
  const max = lines.reduce((peak, line) => Math.max(peak, ...line.values), 0);
  const { ticks, top } = costAxis(max);
  // Points run edge to edge; a single point sits in the middle.
  const xOf = (index: number) => (days.length > 1 ? (index / (days.length - 1)) * 100 : 50);
  // A year of days is a point every pixel or two: a finer line keeps the days apart.
  const strokeWidth = days.length > 120 ? 1 : 1.5;
  const yOf = (value: number) => 100 - (value / top) * 100;
  const active = hovered !== null ? days[hovered] : null;
  // The middle label only when there is room between the two ends.
  const axisLabels = days.length >= 5
    ? [days[0].date, days[Math.floor((days.length - 1) / 2)].date, days[days.length - 1].date]
    : days.length ? [days[0].date, days[days.length - 1].date] : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3.5 px-5 py-4" data-usage-daily-cost>
      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Daily cost</div>
      <div className="flex gap-2">
        <div className="relative h-[170px] w-[34px] flex-none text-[11px] tabular-nums text-[var(--text-muted)]" aria-hidden="true">
          {[0, ...ticks].map((tick) => (
            <span key={tick} className="absolute right-0 translate-y-1/2 whitespace-nowrap leading-none" style={{ bottom: `${(tick / top) * 100}%` }}>
              {formatAxisUsd(tick)}
            </span>
          ))}
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="relative h-[170px] border-b border-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" onMouseLeave={() => setHovered(null)}>
            {ticks.map((tick) => (
              <span key={tick} className="absolute inset-x-0 border-t border-[var(--border)]" style={{ bottom: `${(tick / top) * 100}%` }} aria-hidden="true" />
            ))}
            {/* Stretched to the plot; strokes keep their width. Drawn back to front, so the agent that costs most is on top. */}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
              {[...lines].reverse().map((line) => {
                const points = line.values.map((value, index) => `${xOf(index).toFixed(2)},${yOf(value).toFixed(2)}`);
                return (
                  <g key={line.key} data-usage-cost-line={line.key} style={{ color: line.color }}>
                    {points.length > 1 ? (
                      <polygon points={`${xOf(0)},100 ${points.join(' ')} ${xOf(points.length - 1)},100`} style={{ fill: 'color-mix(in srgb, currentColor 8%, transparent)' }} />
                    ) : null}
                    <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </svg>
            {active ? (
              <>
                <span className="pointer-events-none absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--text-primary)_22%,transparent)]" style={{ left: `${xOf(hovered!)}%` }} aria-hidden="true" />
                {lines.map((line) => (
                  <span
                    key={line.key}
                    className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-[var(--bg-primary)]"
                    style={{ left: `${xOf(hovered!)}%`, top: `${yOf(line.values[hovered!])}%`, backgroundColor: line.color }}
                    data-usage-cost-dot={line.key}
                    aria-hidden="true"
                  />
                ))}
              </>
            ) : null}
            {/* One strip per point, reaching halfway to its neighbours. */}
            <div className="absolute inset-0 flex">
              {days.map((day, index) => (
                <div
                  key={day.date}
                  className="h-full min-w-0"
                  style={{ flex: `${index === 0 || index === days.length - 1 ? 0.5 : 1} 0 0` }}
                  // By moves, not by entering: React skips an enter when the pointer's last element is gone
                  // (the page was swapped under a resting pointer), and the strip would stay dead until re-entered.
                  onMouseMove={() => setHovered(index)}
                  data-usage-cost-point={day.date}
                />
              ))}
            </div>
            {active && active.totalCostUsd > 0 ? (
              <div
                role="tooltip"
                className="pointer-events-none absolute top-0 z-10 flex w-[224px] flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--popover-bg,var(--bg-primary))] px-3.5 py-3 text-[12.5px] tabular-nums shadow-[0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]"
                // Beside the point, on the side with more room.
                style={xOf(hovered!) < 50 ? { left: `calc(${xOf(hovered!)}% + 12px)` } : { right: `calc(${100 - xOf(hovered!)}% + 12px)` }}
                data-usage-cost-tip={active.date}
              >
                <div className="flex justify-between gap-3 pb-0.5 text-[13px] font-semibold text-[var(--text-primary)]">
                  <span>{formatShortDate(active.date)}</span>
                  <span>{formatCurrency(active.totalCostUsd, overview.estimated)}</span>
                </div>
                {[...active.agents].sort((left, right) => right.costUsd - left.costUsd).map((entry) => {
                  const row = rowOf.get(entry.provider);
                  return (
                    <div key={entry.provider} className="flex items-center gap-2 text-[var(--text-secondary)]" data-usage-cost-tip-row={entry.provider}>
                      {logoFor(entry.provider)}
                      <span className="min-w-0 flex-1 truncate">{row?.title ?? entry.provider}</span>
                      <span className="text-[var(--text-primary)]">{formatCurrency(entry.costUsd, row?.estimated)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
            {axisLabels.map((date, index) => <span key={`${index}-${date}`}>{formatShortDate(date)}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// Four steps of the theme's accent, light to full.
const TYPE_COLORS = [30, 55, 78, 100].map((percent) => `color-mix(in srgb, var(--accent) ${percent}%, transparent)`);

/** The cost as four kinds of tokens, each with how many tokens it was. */
function CostByType({ split }: { split: UsageCostByType }) {
  const types = [
    { key: 'input', label: 'Input', costUsd: split.inputCostUsd, tokens: split.inputTokens, color: TYPE_COLORS[0] },
    { key: 'cache-read', label: 'Cache read', costUsd: split.cacheReadCostUsd, tokens: split.cacheReadTokens, color: TYPE_COLORS[1] },
    { key: 'cache-write', label: 'Cache write', costUsd: split.cacheWriteCostUsd, tokens: split.cacheWriteTokens, color: TYPE_COLORS[2] },
    { key: 'output', label: 'Output', costUsd: split.outputCostUsd, tokens: split.outputTokens, color: TYPE_COLORS[3] },
  ];
  // Amounts an agent returned for a model with no listed rates: nothing to split them by.
  const unsplit = split.unsplitCostUsd >= 0.005 ? split.unsplitCostUsd : 0;

  return (
    <div className="@container flex flex-col gap-3.5 rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-5 py-4" data-usage-cost-types>
      <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Cost by type</div>
      <div className="flex h-2 gap-0.5" aria-hidden="true">
        {types.map((type) => (type.costUsd > 0 ? (
          <span key={type.key} className="min-w-1 rounded-[3px]" style={{ flex: `${type.costUsd} 0 0`, backgroundColor: type.color }} />
        ) : null))}
        {unsplit ? <span className="min-w-1 rounded-[3px]" style={{ flex: `${unsplit} 0 0`, backgroundColor: OTHER_COLOR }} /> : null}
      </div>
      <div className={`grid grid-cols-2 gap-4 ${unsplit ? '@[640px]:grid-cols-5' : '@[640px]:grid-cols-4'}`}>
        {types.map((type) => (
          <div key={type.key} className="flex min-w-0 flex-col gap-1 tabular-nums" data-usage-cost-type={type.key}>
            <span className="flex items-center gap-[7px] text-[12.5px] text-[var(--text-secondary)]">
              <span className="h-2 w-2 flex-none rounded-sm" style={{ backgroundColor: type.color }} aria-hidden="true" />
              {type.label}
            </span>
            <span className="truncate pl-[15px] text-[13.5px] font-medium text-[var(--text-primary)]">
              {/* A share of the total by list rates, so it is always an estimate. */}
              {formatCurrency(type.costUsd, true)}
              <span className="text-[12.5px] font-normal text-[var(--text-muted)]"> · {formatCompactNumber(Math.round(type.tokens))}</span>
            </span>
          </div>
        ))}
        {unsplit ? (
          <div className="flex min-w-0 flex-col gap-1 tabular-nums" data-usage-cost-type="other" title="Amounts agents returned for models with no listed rates. They cannot be split by type.">
            <span className="flex items-center gap-[7px] text-[12.5px] text-[var(--text-secondary)]">
              <span className="h-2 w-2 flex-none rounded-sm" style={{ backgroundColor: OTHER_COLOR }} aria-hidden="true" />
              Other
            </span>
            <span className="truncate pl-[15px] text-[13.5px] font-medium text-[var(--text-primary)]">{formatCurrency(unsplit)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

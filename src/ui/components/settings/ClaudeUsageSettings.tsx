import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import grokLogo from '../../assets/grok.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import openaiLogo from '../../assets/openai.svg';
import piLogo from '../../assets/pi-logo-auto.svg';
import bubbleLogo from '../../assets/bubble-logo-auto.svg';
import qoderLogo from '../../assets/qoder.svg';
import devinLogo from '../../assets/devin-color.svg';
import mimoLogo from '../../assets/xiaomimimo.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { OpenCodeLogo } from '../OpenCodeLogo';
import { ChevronDown } from '../icons';
import type {
  AgentProvider,
  ClaudePlanUsageReport,
  ClaudePlanUsageWindow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  CodexRateLimitReport,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  GrokPlanUsageReport,
  QoderPlanUsageReport,
} from '../../types';
import { useKimiModelConfig } from '../../hooks/useKimiModelConfig';
import { usePlanUsage } from '../../hooks/usePlanUsage';
import { useAgentUsageReport } from '../../hooks/useAgentUsageReport';
import { useAppStore } from '../../store/useAppStore';
import { PreferenceSelect } from './GeneralSettingsContent';

// Steps of the theme's accent, so the heatmap follows light, dark and custom themes.
const HEATMAP_LEVEL_COLORS = [22, 40, 58, 78, 100].map((p) => `color-mix(in srgb, var(--accent) ${p}%, transparent)`);

type UsageProviderCard = {
  id: AgentProvider;
  title: string;
  logo: ReactNode;
  report: ClaudeUsageReport | null;
  loading: boolean;
  error: string | null;
};

type ProviderUsageState = {
  report: ClaudeUsageReport | null;
  loading: boolean;
  error: string | null;
};

const USAGE_PROVIDERS: Array<{ id: AgentProvider; title: string; logoSrc?: string }> = [
  { id: 'claude', title: 'Claude Code', logoSrc: claudeLogo },
  { id: 'codex', title: 'Codex CLI', logoSrc: openaiLogo },
  { id: 'opencode', title: 'OpenCode' },
  { id: 'kimi', title: 'Kimi Code', logoSrc: moonshotLogo },
  { id: 'grok', title: 'Grok Build', logoSrc: grokLogo },
  { id: 'pi', title: 'Pi', logoSrc: piLogo },
  { id: 'qoder', title: 'Qoder', logoSrc: qoderLogo },
  { id: 'bubble', title: 'Bubble', logoSrc: bubbleLogo },
  { id: 'deepseek', title: 'DeepSeek Harness', logoSrc: deepseekLogo },
  { id: 'devin', title: 'Devin', logoSrc: devinLogo },
  { id: 'mimo', title: 'MiMo Code', logoSrc: mimoLogo },
  { id: 'minimax', title: 'MiniMax Code', logoSrc: minimaxLogo },
];

type ActivityViewMode = 'daily' | 'weekly' | 'cumulative';

export function ClaudeUsageSettingsContent() {
  const activeProvider = useAppStore((state) => state.usageSettingsProvider);
  const setActiveProvider = useAppStore((state) => state.setUsageSettingsProvider);
  // The year feeds the activity heatmap and streaks; the model table follows the picked range.
  const [rangeDays, setRangeDays] = useState<ClaudeUsageRangeDays>(365);
  const usage = useAgentUsageReport(activeProvider, 365);
  const rangeUsage = useAgentUsageReport(activeProvider, rangeDays, rangeDays !== 365);
  const { report: codexRateLimits, loading: codexRateLimitsLoading, error: codexRateLimitsError } =
    usePlanUsage('codex', activeProvider === 'codex');
  const { report: claudePlanUsage, loading: claudePlanUsageLoading, error: claudePlanUsageError } =
    usePlanUsage('claude', activeProvider === 'claude');
  const { report: grokPlanUsage, loading: grokPlanUsageLoading, error: grokPlanUsageError } =
    usePlanUsage('grok', activeProvider === 'grok');
  const { report: qoderPlanUsage, loading: qoderPlanUsageLoading, error: qoderPlanUsageError } =
    usePlanUsage('qoder', activeProvider === 'qoder');
  const kimiModelConfig = useKimiModelConfig();
  const kimiModelLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const model of kimiModelConfig.availableModels) {
      if (model.label && model.label !== model.name) {
        labels[model.name] = model.label;
      }
    }
    return labels;
  }, [kimiModelConfig]);

  const providers = useMemo<UsageProviderCard[]>(
    () =>
      USAGE_PROVIDERS.map((provider) => {
        const state: ProviderUsageState = provider.id === activeProvider
          ? { report: usage.report?.usage ?? null, loading: usage.loading, error: usage.error }
          : { report: null, loading: false, error: null };
        return {
          id: provider.id,
          title: provider.title,
          logo: provider.logoSrc ? (
            <img src={provider.logoSrc} alt="" className={`h-3.5 w-3.5 flex-shrink-0 ${[claudeLogo, openaiLogo, grokLogo, moonshotLogo, mimoLogo].includes(provider.logoSrc) ? 'settings-monochrome-logo' : ''}`} aria-hidden="true" />
          ) : (
            <OpenCodeLogo className="h-3.5 w-3.5 flex-shrink-0" />
          ),
          ...state,
          // Kimi attributes usage by raw model id (e.g. kimi-code/kimi-for-coding);
          // relabel with the picker's display names ("K2.7 Coding") so the card
          // matches what the user selected.
          report:
            provider.id === 'kimi' && state.report
              ? relabelUsageReportModels(state.report, kimiModelLabels)
              : state.report,
        };
      }),
    [kimiModelLabels, activeProvider, usage]
  );

  const activeProviderCard = providers.find((provider) => provider.id === activeProvider) || providers[0];
  const activeReport = activeProviderCard.report;
  const stats = useMemo(() => (activeReport ? computeUsageStats(activeReport) : null), [activeReport]);
  // The picked range's report (the year's when "1 year" is picked, or until the range loads).
  const rangeReport = useMemo(() => {
    const raw = rangeDays === 365 ? null : rangeUsage.report?.usage ?? null;
    if (!raw) return activeReport;
    return activeProvider === 'kimi' ? relabelUsageReportModels(raw, kimiModelLabels) : raw;
  }, [rangeDays, rangeUsage.report, activeReport, activeProvider, kimiModelLabels]);
  // Sessions ran but every result summed to zero tokens: the provider's CLI
  // does not report token counts (qodercli through 1.1.1 only exposes a
  // context ratio). Hide the token report entirely instead of showing a
  // misleading empty state — the plan-limits panel moves up in its place.
  // The agent's plan limits as one strip of chips (Claude, Codex, Grok, Qoder).
  const planLimits =
    activeProvider === 'claude' ? claudePlanLimits(claudePlanUsage, claudePlanUsageLoading, claudePlanUsageError)
      : activeProvider === 'codex' ? codexPlanLimits(codexRateLimits, codexRateLimitsLoading, codexRateLimitsError)
        : activeProvider === 'grok' ? grokPlanLimits(grokPlanUsage, grokPlanUsageLoading, grokPlanUsageError)
          : activeProvider === 'qoder' ? qoderPlanLimits(qoderPlanUsage, qoderPlanUsageLoading, qoderPlanUsageError)
            : null;
  const tokenReportHidden = Boolean(
    activeReport && activeReport.totals.totalTokens <= 0 && activeReport.totals.sessionCount > 0
  );

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 truncate text-[12px] leading-4 text-[var(--text-muted)]" role="status" data-usage-report-status="">
          {usage.report ? <>
            Updated {formatLocalTime(usage.report.fetchedAt)}
            {usage.loading || rangeUsage.loading ? ' · Refreshing…' : usage.error ? ' · Update failed; showing saved data' : ''}
          </> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tokenReportHidden ? null : <UsageRangeSwitch value={rangeDays} onChange={setRangeDays} />}
          <UsageProviderPicker
            provider={activeProviderCard}
            providers={providers}
            onSelectProvider={setActiveProvider}
          />
        </div>
      </div>

      {planLimits ? <PlanLimitStrip limits={planLimits} /> : null}

      {tokenReportHidden
        ? null
        : renderUsageState(activeProviderCard) || (
            <>
              <div className="flex items-baseline gap-2" data-usage-total>
                <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
                  {formatCompactNumber(ledgerTotalTokens(rangeReport!))}
                </span>
                <span className="text-[17px] font-medium text-[var(--text-secondary)]">tokens</span>
              </div>

              <ModelLedger report={rangeReport!} yearDaily={activeReport!.daily} />

              <TokenActivitySection daily={activeReport!.daily} stats={stats!} />
            </>
          )}

    </div>
  );
}

function UsageProviderPicker({ provider, providers, onSelectProvider }: {
  provider: UsageProviderCard;
  providers: UsageProviderCard[];
  onSelectProvider: (id: AgentProvider) => void;
}) {
  return <div className="usage-provider-picker flex items-center" data-settings-label="Usage provider">
    <PreferenceSelect label="Usage provider" value={provider.id} options={providers.map(entry => ({value: entry.id, label: entry.title, icon: entry.logo}))} onChange={value => onSelectProvider(value as AgentProvider)} />
  </div>;
}

/* ---------- Stats ---------- */

interface UsageStats {
  totalTokens: number;
  peakDayTokens: number;
  peakDayDate: string | null;
  totalCostUsd: number;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
}

function computeUsageStats(report: ClaudeUsageReport): UsageStats {
  const daily = report.daily;
  let dailyTotalTokens = 0;
  let peakDayTokens = 0;
  let peakDayDate: string | null = null;
  let activeDays = 0;
  let longestStreak = 0;
  let runningStreak = 0;

  for (const point of daily) {
    dailyTotalTokens += point.totalTokens;
    if (point.totalTokens > peakDayTokens) {
      peakDayTokens = point.totalTokens;
      peakDayDate = point.date;
    }
    if (point.totalTokens > 0) {
      activeDays += 1;
      runningStreak += 1;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
  }

  // Current streak counts back from the last day; an empty "today" doesn't
  // break a streak that is still alive as of yesterday.
  let currentStreak = 0;
  let index = daily.length - 1;
  if (index >= 0 && daily[index].totalTokens <= 0) {
    index -= 1;
  }
  while (index >= 0 && daily[index].totalTokens > 0) {
    currentStreak += 1;
    index -= 1;
  }

  return {
    // Sum of the daily series so the strip, heatmap, and cumulative views all
    // agree; report.totals counts from a different source (result.usage).
    totalTokens: dailyTotalTokens,
    peakDayTokens,
    peakDayDate,
    totalCostUsd: report.totals.totalCostUsd,
    currentStreak,
    longestStreak,
    activeDays,
  };
}

/* ---------- Token activity ---------- */

function TokenActivitySection({ daily, stats }: { daily: ClaudeUsageDailyPoint[]; stats: UsageStats }) {
  const [mode, setMode] = useState<ActivityViewMode>('daily');

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-5 py-4" data-usage-activity>
      <div className="flex items-center justify-between">
        <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">Activity</div>
        <div className="flex items-center gap-4 text-[12.5px]">
          {(
            [
              ['daily', 'Daily'],
              ['weekly', 'Weekly'],
              ['cumulative', 'Cumulative'],
            ] as Array<[ActivityViewMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`transition-colors ${
                mode === value
                  ? 'font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <ActivityHeatmap daily={daily} mode={mode} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-[var(--text-muted)]" data-usage-activity-stats>
        {stats.peakDayDate ? (
          <span>
            Busiest day{' '}
            <span className="font-medium text-[var(--text-primary)]">
              {formatShortDate(stats.peakDayDate)} · {formatCompactNumber(stats.peakDayTokens)}
            </span>
          </span>
        ) : null}
        <span>
          Current streak <span className="font-medium text-[var(--text-primary)]">{formatDays(stats.currentStreak)}</span>
        </span>
        <span>
          Longest <span className="font-medium text-[var(--text-primary)]">{formatDays(stats.longestStreak)}</span>
        </span>
      </div>
    </div>
  );
}

function formatDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/* ---------- Range switch ---------- */

const RANGE_OPTIONS: Array<[ClaudeUsageRangeDays, string]> = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, '1 year'],
];

function UsageRangeSwitch({ value, onChange }: { value: ClaudeUsageRangeDays; onChange(value: ClaudeUsageRangeDays): void }) {
  return (
    <div role="radiogroup" aria-label="Usage range" className="inline-flex items-center gap-0.5 rounded-[9px] bg-[var(--bg-tertiary)] p-[3px]" data-usage-range>
      {RANGE_OPTIONS.map(([days, label]) => (
        <button
          key={days}
          type="button"
          role="radio"
          aria-checked={value === days}
          onClick={() => onChange(days)}
          className={`h-[26px] whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] transition-colors ${
            value === days
              ? 'bg-[var(--bg-primary)] font-medium text-[var(--text-primary)] shadow-[0_0_0_1px_var(--border),0_1px_2px_rgba(0,0,0,0.04)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Model ledger ---------- */

/** The range's tokens as the table adds them up, so the headline and its Total row agree. */
function ledgerTotalTokens(report: ClaudeUsageReport): number {
  const sum = report.models.reduce((total, model) => total + model.totalTokens, 0);
  return sum > 0 ? sum : report.totals.totalTokens;
}

const LEDGER_VISIBLE_MODELS = 5;

/** The cost column says what the figures are: billed, API-equivalent, estimated or partial. */
function costColumnLabel(report: ClaudeUsageReport): string {
  if (report.costMode === 'partial') return 'Priced usage only';
  if (report.costBasis === 'api-standard') return 'API equivalent cost';
  if (report.costMode === 'unavailable' || report.costMode === 'estimated') return 'Estimated cost';
  return 'Total cost';
}

function formatPerMillion(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString('en-US')}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

/** Tokens per bucket for a sparkline: days for short ranges, weeks (13) otherwise. */
function trendSeries(daily: ClaudeUsageDailyPoint[], rangeDays: number, pick: (point: ClaudeUsageDailyPoint) => number): number[] {
  if (rangeDays <= 30) return daily.slice(-rangeDays).map(pick);
  const days = daily.slice(-91);
  const weeks: number[] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7).reduce((sum, point) => sum + pick(point), 0));
  }
  return weeks;
}

function Sparkline({ values }: { values: number[] }) {
  const width = 84;
  const height = 20;
  const max = Math.max(...values, 0);
  if (values.length < 2 || max <= 0) return <span className="text-[var(--text-muted)]">—</span>;
  const points = values.map((value, index) => [
    (index / (values.length - 1)) * (width - 3) + 1.5,
    height - 2 - (value / max) * (height - 5),
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block text-[var(--accent)]">
      <polygon points={`1.5,${height - 2} ${line} ${lastX.toFixed(1)},${height - 2}`} style={{ fill: 'color-mix(in srgb, currentColor 10%, transparent)' }} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="1.75" fill="currentColor" />
    </svg>
  );
}

function lastUsedLabel(daily: ClaudeUsageDailyPoint[], used: (point: ClaudeUsageDailyPoint) => boolean): string {
  for (let index = daily.length - 1; index >= 0; index -= 1) {
    if (!used(daily[index])) continue;
    if (index === daily.length - 1) return 'Today';
    const date = parseDateKey(daily[index].date);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return '—';
}

type LedgerRow = {
  key: string;
  label: string;
  tokens: number;
  cost: number | null;
  sessions: number | null;
  cacheHit: number | null;
  models: string[];
};

/**
 * One table compares every model in the range: tokens with a share bar,
 * share, cost, cost per 1M tokens, sessions, cache hit, a trend and when it
 * was last used. The busiest models show; the rest fold into one row.
 */
function ModelLedger({ report, yearDaily }: { report: ClaudeUsageReport; yearDaily: ClaudeUsageDailyPoint[] }) {
  const [othersOpen, setOthersOpen] = useState(false);
  const estimated = report.costMode === 'estimated' || report.costMode === 'partial';
  const costKnown = report.costMode !== 'unavailable';
  const unpriced = new Set(report.costCoverage?.unpricedModels ?? []);
  const models = [...report.models]
    .filter((model) => model.totalTokens > 0 || model.totalCostUsd > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  // Shares and the total row add up the rows themselves, so they always reach 100%.
  const totalTokens = ledgerTotalTokens(report);
  const rowOf = (model: ClaudeUsageReport['models'][number]): LedgerRow => ({
    key: model.model,
    label: model.model,
    tokens: model.totalTokens,
    cost: costKnown && !(unpriced.has(model.model) && model.totalCostUsd <= 0) ? model.totalCostUsd : null,
    sessions: model.sessionCount,
    cacheHit: model.inputTokens + model.cacheReadTokens > 0 ? model.cacheReadTokens / (model.inputTokens + model.cacheReadTokens) : null,
    models: [model.model],
  });
  const visible = models.length > LEDGER_VISIBLE_MODELS + 1 ? models.slice(0, LEDGER_VISIBLE_MODELS) : models;
  const rest = models.slice(visible.length);
  const restRow: LedgerRow | null = rest.length
    ? {
        key: 'others',
        label: `${rest.length} other models`,
        tokens: rest.reduce((sum, model) => sum + model.totalTokens, 0),
        cost: costKnown ? rest.reduce((sum, model) => sum + model.totalCostUsd, 0) : null,
        sessions: null,
        cacheHit: (() => {
          const input = rest.reduce((sum, model) => sum + model.inputTokens + model.cacheReadTokens, 0);
          return input > 0 ? rest.reduce((sum, model) => sum + model.cacheReadTokens, 0) / input : null;
        })(),
        models: rest.map((model) => model.model),
      }
    : null;
  const trendLabel = report.rangeDays <= 30 ? `Last ${report.rangeDays} days` : 'Last 13 weeks';
  const used = (row: LedgerRow) => (point: ClaudeUsageDailyPoint) => row.models.some((model) => (point.byModel[model] ?? 0) > 0);
  const tokensOf = (row: LedgerRow) => (point: ClaudeUsageDailyPoint) => row.models.reduce((sum, model) => sum + (point.byModel[model] ?? 0), 0);
  const header = 'px-3 pb-2 pt-3 align-bottom text-[11.5px] font-normal leading-[15px] text-[var(--text-muted)]';
  const cell = 'px-3 py-2.5 whitespace-nowrap tabular-nums';

  const renderRow = (row: LedgerRow, kind: 'model' | 'others' | 'nested') => (
    <tr key={row.key} className="border-t border-[var(--border)]" data-usage-model-row={kind === 'others' ? 'others' : row.label}>
      <td className={`${cell} overflow-hidden`}>
        {kind === 'others' ? (
          <button
            type="button"
            onClick={() => setOthersOpen(!othersOpen)}
            aria-expanded={othersOpen}
            className="inline-flex items-center gap-1 pl-[26px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {row.label}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${othersOpen ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <div className={`flex min-w-0 items-center gap-2.5 ${kind === 'nested' ? 'pl-[26px]' : ''}`}>
            {kind === 'model' ? <ModelProviderLogo model={row.label} color="var(--text-muted)" /> : null}
            <span className="min-w-0 truncate font-medium text-[var(--text-primary)]" title={row.label}>{row.label}</span>
          </div>
        )}
      </td>
      <td className={`${cell} text-right`}>
        <div className="flex items-center justify-end gap-2">
          <span className="h-[3px] w-10 flex-shrink-0 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" aria-hidden="true">
            <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${totalTokens > 0 ? Math.max(2, (row.tokens / totalTokens) * 100) : 0}%` }} />
          </span>
          <span className="min-w-[48px] text-[var(--text-primary)]">{formatCompactNumber(row.tokens)}</span>
        </div>
      </td>
      <td className={`${cell} text-right text-[var(--text-secondary)]`}>{totalTokens > 0 ? `${Math.round((row.tokens / totalTokens) * 100)}%` : '—'}</td>
      <td className={`${cell} text-right text-[var(--text-primary)]`}>{row.cost === null ? '—' : formatCurrency(row.cost, estimated)}</td>
      <td className={`${cell} text-right text-[var(--text-secondary)]`}>{row.cost && row.tokens > 0 ? formatPerMillion((row.cost / row.tokens) * 1_000_000) : '—'}</td>
      <td className={`${cell} text-right text-[var(--text-secondary)]`}>{row.sessions === null ? '—' : row.sessions.toLocaleString('en-US')}</td>
      <td className={`${cell} text-right text-[var(--text-secondary)]`}>{row.cacheHit === null ? '—' : formatPercent(row.cacheHit)}</td>
      <td className={cell}>{kind === 'others' ? null : <Sparkline values={trendSeries(yearDaily, report.rangeDays, tokensOf(row))} />}</td>
      <td className={`${cell} text-right text-[var(--text-secondary)]`}>{lastUsedLabel(yearDaily, used(row))}</td>
    </tr>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)]" data-usage-ledger>
      <div className="px-5 pt-4 text-[13.5px] font-semibold text-[var(--text-primary)]">By model</div>
      {models.length === 0 ? (
        <div className="px-5 py-5 text-[13px] text-[var(--text-muted)]">No model activity in this range.</div>
      ) : (
        <div className="overflow-x-auto px-2 pb-1">
          <table className="w-full min-w-[912px] table-fixed border-collapse text-[13px]">
            {/* Fixed numeric columns; the model column takes the rest, one line, cut with an ellipsis. */}
            <colgroup>
              <col />
              <col className="w-[124px]" />
              <col className="w-[60px]" />
              <col className="w-[136px]" />
              <col className="w-[68px]" />
              <col className="w-[72px]" />
              <col className="w-[76px]" />
              <col className="w-[104px]" />
              <col className="w-[80px]" />
            </colgroup>
            <thead>
              <tr>
                <th className={`${header} text-left`}>Model</th>
                <th className={`${header} text-right`}>Tokens</th>
                <th className={`${header} text-right`}>Share</th>
                <th className={`${header} whitespace-nowrap text-right`} data-usage-cost-label title={report.note}>{costColumnLabel(report)}</th>
                <th className={`${header} text-right`}>Per 1M</th>
                <th className={`${header} text-right`}>Sessions</th>
                <th className={`${header} text-right`}>Cache hit</th>
                <th className={`${header} text-left`}>{trendLabel}</th>
                <th className={`${header} text-right`}>Last used</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((model) => renderRow(rowOf(model), 'model'))}
              {restRow ? renderRow(restRow, 'others') : null}
              {restRow && othersOpen ? rest.map((model) => renderRow(rowOf(model), 'nested')) : null}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--text-primary)]/60 font-semibold text-[var(--text-primary)]" data-usage-model-row="total">
                <td className={cell}>Total</td>
                <td className={`${cell} text-right`}>{formatCompactNumber(totalTokens)}</td>
                <td className={`${cell} text-right`}>100%</td>
                <td className={`${cell} text-right`}>{costKnown ? formatCurrency(report.totals.totalCostUsd, estimated) : 'Unavailable'}</td>
                <td className={`${cell} text-right`}>{costKnown && report.totals.totalCostUsd > 0 && totalTokens > 0 ? formatPerMillion((report.totals.totalCostUsd / totalTokens) * 1_000_000) : '—'}</td>
                <td className={`${cell} text-right`}>{report.totals.sessionCount.toLocaleString('en-US')}</td>
                <td className={`${cell} text-right`}>{formatPercent(report.totals.cacheHitRate)}</td>
                <td className={cell} />
                <td className={`${cell} text-right`}>{lastUsedLabel(yearDaily, (point) => point.totalTokens > 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function quantileThresholds(values: number[]): number[] {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return [0, 0, 0, 0];
  }
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [pick(0.2), pick(0.4), pick(0.6), pick(0.8)];
}

function heatLevel(value: number, thresholds: number[]): number {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  if (value <= thresholds[3]) return 4;
  return 5;
}

function heatFill(level: number): string {
  return level === 0 ? 'var(--bg-tertiary)' : HEATMAP_LEVEL_COLORS[level - 1];
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface HeatmapTip {
  /** Cell anchor position as percentages of the svg box. */
  xPct: number;
  yPct: number;
  title: string;
  detail: string;
}

function HeatmapHoverTip({ tip }: { tip: HeatmapTip | null }) {
  if (!tip) return null;
  const transform =
    tip.xPct < 12
      ? 'translate(0, -100%)'
      : tip.xPct > 88
        ? 'translate(-100%, -100%)'
        : 'translate(-50%, -100%)';

  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg bg-[var(--tooltip-bg)] px-2.5 py-1.5 text-[11px] leading-4 shadow-[0_10px_28px_rgba(15,23,42,0.18)]"
      style={{ left: `${tip.xPct}%`, top: `${tip.yPct}%`, transform, marginTop: '-7px' }}
    >
      <div className="font-medium text-[var(--tooltip-fg)]">{tip.title}</div>
      <div className="text-[var(--tooltip-fg-muted)]">{tip.detail}</div>
    </div>
  );
}

// Same compact form as the stat tiles and the Top models list, so a day
// reads "217.4K tokens" rather than a six-digit count.
function formatTokenDetail(tokens: number): string {
  return tokens > 0 ? `${formatCompactNumber(tokens)} tokens` : 'No tokens';
}

function ActivityHeatmap({ daily, mode }: { daily: ClaudeUsageDailyPoint[]; mode: ActivityViewMode }) {
  const cell = 10;
  const gap = 3;
  const pitch = cell + gap;
  const labelBand = 20;

  const { weeks, monthLabels, weekSums, weekStartDates, cumulativeByDate } = useMemo(() => {
    const firstWeekday = daily.length > 0 ? parseDateKey(daily[0].date).getDay() : 0;
    const weekCount = Math.ceil((firstWeekday + daily.length) / 7);
    const grid: Array<Array<ClaudeUsageDailyPoint | null>> = Array.from({ length: weekCount }, () =>
      Array.from({ length: 7 }, () => null)
    );
    const weekSums: number[] = Array.from({ length: weekCount }, () => 0);
    const weekStartDates: Array<string | null> = Array.from({ length: weekCount }, () => null);
    const cumulativeByDate = new Map<string, number>();
    let running = 0;
    daily.forEach((point, index) => {
      const slot = firstWeekday + index;
      const weekIndex = Math.floor(slot / 7);
      grid[weekIndex][slot % 7] = point;
      weekSums[weekIndex] += point.totalTokens;
      if (!weekStartDates[weekIndex]) {
        weekStartDates[weekIndex] = point.date;
      }
      running += point.totalTokens;
      cumulativeByDate.set(point.date, running);
    });

    const labels: Array<{ week: number; label: string }> = [];
    let lastMonth = -1;
    grid.forEach((week, weekIndex) => {
      const firstPoint = week.find((point) => point !== null);
      if (!firstPoint) return;
      const month = parseDateKey(firstPoint.date).getMonth();
      if (month !== lastMonth) {
        const lastLabel = labels[labels.length - 1];
        if (!lastLabel || weekIndex - lastLabel.week >= 3) {
          labels.push({ week: weekIndex, label: MONTH_LABELS[month] });
        }
        lastMonth = month;
      }
    });

    return { weeks: grid, monthLabels: labels, weekSums, weekStartDates, cumulativeByDate };
  }, [daily]);

  // Same calendar grid in every mode; only the value a cell encodes changes:
  // its day, its whole week, or the running total up to that day.
  const cellValue = (point: ClaudeUsageDailyPoint, weekIndex: number): number => {
    if (mode === 'weekly') return weekSums[weekIndex];
    if (mode === 'cumulative') return cumulativeByDate.get(point.date) || 0;
    return point.totalTokens;
  };

  const thresholds = useMemo(() => {
    if (mode === 'weekly') return quantileThresholds(weekSums);
    if (mode === 'cumulative') return quantileThresholds(Array.from(cumulativeByDate.values()));
    return quantileThresholds(daily.map((point) => point.totalTokens));
  }, [cumulativeByDate, daily, mode, weekSums]);

  const cellTip = (
    point: ClaudeUsageDailyPoint,
    weekIndex: number,
    dayIndex: number,
    width: number,
    height: number
  ): HeatmapTip => {
    const anchor = {
      xPct: ((weekIndex * pitch + cell / 2) / width) * 100,
      yPct: ((dayIndex * pitch) / height) * 100,
    };
    if (mode === 'weekly') {
      const start = weekStartDates[weekIndex];
      return {
        ...anchor,
        title: start ? `Week of ${formatLongDate(start)}` : 'Week',
        detail: formatTokenDetail(weekSums[weekIndex]),
      };
    }
    if (mode === 'cumulative') {
      const cumulative = cumulativeByDate.get(point.date) || 0;
      return {
        ...anchor,
        title: formatLongDate(point.date),
        detail: cumulative > 0 ? `${formatCompactNumber(cumulative)} tokens to date` : 'No tokens yet',
      };
    }
    return {
      ...anchor,
      title: formatLongDate(point.date),
      detail: formatTokenDetail(point.totalTokens),
    };
  };

  const [tip, setTip] = useState<HeatmapTip | null>(null);
  useEffect(() => {
    setTip(null);
  }, [mode]);
  const width = weeks.length * pitch - gap;
  const height = 7 * pitch - gap + labelBand;

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <HeatmapHoverTip tip={tip} />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto max-h-[160px] w-full"
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={`${mode} token activity heatmap`}
      >
        {weeks.map((week, weekIndex) =>
          week.map((point, dayIndex) => {
            if (!point) return null;
            const level = heatLevel(cellValue(point, weekIndex), thresholds);
            return (
              <rect
                key={point.date}
                x={weekIndex * pitch}
                y={dayIndex * pitch}
                width={cell}
                height={cell}
                rx={2.5}
                style={{ fill: heatFill(level) }}
                onMouseEnter={() => setTip(cellTip(point, weekIndex, dayIndex, width, height))}
              />
            );
          })
        )}
        {monthLabels.map((entry) => (
          <text
            key={`${entry.week}-${entry.label}`}
            x={entry.week * pitch}
            y={height - 4}
            fontSize="10"
            fill="var(--text-muted)"
          >
            {entry.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

/**
 * Replace raw model ids with display labels across a usage report (model
 * summaries + daily byModel buckets). Same-label ids merge additively.
 */
function relabelUsageReportModels(
  report: ClaudeUsageReport,
  labels: Record<string, string>
): ClaudeUsageReport {
  if (Object.keys(labels).length === 0) return report;
  const labelOf = (model: string) => labels[model] || model;

  const mergedModels = new Map<string, ClaudeUsageReport['models'][number]>();
  for (const summary of report.models) {
    const label = labelOf(summary.model);
    const existing = mergedModels.get(label);
    if (!existing) {
      mergedModels.set(label, { ...summary, model: label });
      continue;
    }
    existing.inputTokens += summary.inputTokens;
    existing.outputTokens += summary.outputTokens;
    existing.totalTokens += summary.totalTokens;
    existing.totalCostUsd += summary.totalCostUsd;
    existing.cacheReadTokens += summary.cacheReadTokens;
    existing.sessionCount += summary.sessionCount;
  }

  return {
    ...report,
    models: Array.from(mergedModels.values()),
    daily: report.daily.map((day) => {
      const byModel: Record<string, number> = {};
      const byModelCostUsd: Record<string, number> = {};
      for (const [model, tokens] of Object.entries(day.byModel)) {
        const label = labelOf(model);
        byModel[label] = (byModel[label] || 0) + tokens;
      }
      for (const [model, cost] of Object.entries(day.byModelCostUsd || {})) {
        const label = labelOf(model);
        byModelCostUsd[label] = (byModelCostUsd[label] || 0) + cost;
      }
      return { ...day, byModel, byModelCostUsd };
    }),
  };
}

/* ---------- Plan limits ---------- */

/** One limit: a window with a share left and a reset, or a plain value (credits, extra usage). */
type PlanLimitChip = {
  key: string;
  label: string;
  window?: CodexRateLimitWindow | null;
  value?: string;
  detail?: string;
  alert?: boolean;
};

/** An agent's plan limits, ready for the strip under the toolbar. */
type PlanLimits = {
  /** The old panel title, kept as the strip's label (tests and screen readers find it by this). */
  title: string;
  plan: string | null;
  chips: PlanLimitChip[];
  loading: boolean;
  error: string | null;
  /** Shown instead of chips when there is nothing to show. */
  empty: string | null;
};

function planLimitsBase(title: string, loading: boolean, error: string | null, hasReport: boolean, noun: string): Pick<PlanLimits, 'title' | 'loading' | 'error' | 'empty'> | null {
  if (hasReport) return null;
  return {
    title,
    loading,
    error,
    empty: loading ? `Loading ${noun}…` : error ? `Couldn't load ${noun}.` : `No ${noun} data available.`,
  };
}

function claudePlanLimits(report: ClaudePlanUsageReport | null, loading: boolean, error: string | null): PlanLimits {
  const title = 'Claude plan limits';
  const base = planLimitsBase(title, loading, error, Boolean(report), 'Claude plan usage');
  if (base) return { ...base, plan: null, chips: [] };
  const r = report!;
  if (!r.rateLimitsAvailable) {
    return { title, plan: null, chips: [], loading, error, empty: 'Plan limits do not apply to this account (API key or third-party provider session).' };
  }
  const chips: PlanLimitChip[] = [
    { key: 'five-hour', label: '5-hour', window: claudePlanWindowToTile(r.fiveHour, 300) },
    { key: 'weekly', label: 'Weekly', window: claudePlanWindowToTile(r.sevenDay, 10_080) },
  ];
  if (r.sevenDayOpus) chips.push({ key: 'opus', label: 'Opus weekly', window: claudePlanWindowToTile(r.sevenDayOpus, 10_080) });
  if (r.sevenDaySonnet) chips.push({ key: 'sonnet', label: 'Sonnet weekly', window: claudePlanWindowToTile(r.sevenDaySonnet, 10_080) });
  for (const entry of r.modelScoped) {
    chips.push({ key: `model-${entry.displayName}`, label: `${entry.displayName} weekly`, window: claudePlanWindowToTile(entry, 10_080) });
  }
  if (r.extraUsage?.isEnabled) {
    chips.push({
      key: 'extra',
      label: 'Extra usage',
      value: r.extraUsage.utilization === null ? '—' : `${Math.round(r.extraUsage.utilization)}%`,
      detail: formatClaudeExtraUsage(r.extraUsage),
    });
  }
  return { title, plan: r.subscriptionType ? `Claude ${formatPlanName(r.subscriptionType)}` : null, chips: chips.filter((chip) => chip.window !== null || chip.value), loading, error, empty: null };
}

function codexPlanLimits(report: CodexRateLimitReport | null, loading: boolean, error: string | null): PlanLimits {
  const title = 'Codex limits';
  const entries = getCodexRateLimitEntries(report);
  const base = planLimitsBase(title, loading, error, entries.length > 0, 'Codex limit');
  if (base) return { ...base, plan: null, chips: [] };
  const main = entries.find((entry) => entry.id === 'codex') || entries[0];
  const snapshot = main.snapshot;
  const chips: PlanLimitChip[] = [];
  if (snapshot.primary) chips.push({ key: 'primary', label: formatRateLimitWindowName(snapshot.primary, 'Primary'), window: snapshot.primary });
  if (snapshot.secondary) chips.push({ key: 'secondary', label: formatRateLimitWindowName(snapshot.secondary, 'Secondary'), window: snapshot.secondary });
  if (snapshot.credits) {
    chips.push({
      key: 'credits',
      label: 'Credits',
      value: snapshot.credits.unlimited ? 'Unlimited' : snapshot.credits.balance || '0',
      detail: snapshot.credits.unlimited ? 'Unlimited credits' : snapshot.credits.hasCredits ? 'Credits available' : 'No credits balance',
    });
  }
  if (snapshot.rateLimitReachedType) {
    chips.push({ key: 'status', label: 'Status', value: 'Limited', detail: formatRateLimitReachedType(snapshot.rateLimitReachedType), alert: true });
  }
  for (const entry of entries) {
    if (entry.id === main.id) continue;
    const window = entry.snapshot.primary || entry.snapshot.secondary;
    if (window) chips.push({ key: `bucket-${entry.id}`, label: getCodexRateLimitName(entry.id, entry.snapshot), window });
  }
  return { title, plan: snapshot.planType ? formatPlanName(snapshot.planType) : null, chips, loading, error, empty: chips.length ? null : 'No Codex limit data available.' };
}

function grokPlanLimits(report: GrokPlanUsageReport | null, loading: boolean, error: string | null): PlanLimits {
  const title = 'Grok plan limits';
  const base = planLimitsBase(title, loading, error, Boolean(report), 'Grok plan usage');
  if (base) return { ...base, plan: null, chips: [] };
  const r = report!;
  const chips: PlanLimitChip[] = [];
  const window = grokPlanWindowToTile(r);
  if (window) chips.push({ key: 'period', label: grokPeriodLabel(r.currentPeriod), window });
  if (r.onDemandCap && r.onDemandCap > 0) {
    chips.push({ key: 'on-demand', label: 'On-demand', value: `${formatCurrency(r.onDemandUsed ?? 0)} of ${formatCurrency(r.onDemandCap)}` });
  }
  if (r.prepaidBalance !== null) chips.push({ key: 'prepaid', label: 'Prepaid', value: formatCurrency(r.prepaidBalance), detail: 'Prepaid credits balance' });
  return { title, plan: r.subscriptionTier, chips, loading, error, empty: chips.length ? null : 'No Grok plan usage data available.' };
}

function qoderPlanLimits(report: QoderPlanUsageReport | null, loading: boolean, error: string | null): PlanLimits {
  const title = 'Qoder plan limits';
  const base = planLimitsBase(title, loading, error, Boolean(report), 'Qoder plan usage');
  if (base) return { ...base, plan: null, chips: [], empty: base.empty === 'No Qoder plan usage data available.' ? 'No Qoder plan usage data available. Sign in to qodercli first.' : base.empty };
  const r = report!;
  const chips: PlanLimitChip[] = [];
  const window = qoderPlanWindowToTile(r);
  if (window) chips.push({ key: 'plan', label: 'Plan quota', window, detail: r.userQuota ? formatQoderQuotaSubtitle(r.userQuota) : undefined });
  if (r.addOnQuota) chips.push({ key: 'add-on', label: 'Add-on pack', value: formatQoderQuotaValue(r.addOnQuota), detail: formatQoderQuotaSubtitle(r.addOnQuota) });
  if (r.orgResourcePackage) chips.push({ key: 'org', label: 'Org package', value: formatQoderQuotaValue(r.orgResourcePackage), detail: formatQoderQuotaSubtitle(r.orgResourcePackage) });
  return { title, plan: null, chips, loading, error, empty: chips.length ? null : 'No Qoder plan usage data available.' };
}

/** Low is yellow below 20% left, red below 5%; otherwise the theme accent. */
function limitTone(remaining: number): string {
  return remaining < 5 ? 'var(--error)' : remaining < 20 ? 'var(--warning)' : 'var(--accent)';
}

/** "2h 25m", "2d 6h", "35m": time until a window resets. */
function formatResetIn(resetsAt: number | null | undefined, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = normalizeTimestampMs(resetsAt) - now;
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How far through its window the clock is (0–1), when the window says how long it is. */
function windowElapsed(window: CodexRateLimitWindow, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowDurationMins) return null;
  const left = normalizeTimestampMs(window.resetsAt) - now;
  return Math.max(0, Math.min(1, 1 - left / (window.windowDurationMins * 60_000)));
}

function LimitRing({ remaining }: { remaining: number }) {
  const r = 5.25;
  const length = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="flex-shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" style={{ stroke: 'var(--bg-tertiary)' }} />
      <circle
        cx="7" cy="7" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${(Math.max(0, Math.min(100, remaining)) / 100) * length} ${length}`}
        style={{ stroke: limitTone(remaining) }}
      />
    </svg>
  );
}

/** The detail behind a chip: the bar with a pace tick, used vs time gone, and when it resets. */
function PlanLimitDetail({ chip }: { chip: PlanLimitChip }) {
  const window = chip.window;
  if (!window) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4 text-[13px] font-semibold text-[var(--text-primary)]">
          <span>{chip.label}</span>
          <span className="tabular-nums">{chip.value}</span>
        </div>
        {chip.detail ? <div className="text-[12.5px] leading-[18px] text-[var(--text-secondary)]">{chip.detail}</div> : null}
      </div>
    );
  }
  const remaining = Math.round(window.remainingPercent);
  const used = Math.round(window.usedPercent);
  const elapsed = windowElapsed(window);
  const resetsAt = window.resetsAt ? new Date(normalizeTimestampMs(window.resetsAt)) : null;
  let pace: string | null = null;
  if (elapsed !== null && elapsed > 0.05 && window.usedPercent > 0) {
    const projected = window.usedPercent / elapsed;
    if (projected <= 100) pace = `At this pace you'll have about ${Math.max(0, Math.round(100 - projected))}% left.`;
    else {
      // The rest of the window's share goes at the same rate: (left ÷ used) × time so far.
      const hitAt = Date.now() + ((100 - window.usedPercent) / window.usedPercent) * elapsed * window.windowDurationMins! * 60_000;
      pace = `At this pace you'll reach the limit ${new Date(hitAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`;
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-[13px] font-semibold text-[var(--text-primary)]">
        <span>{chip.label}</span>
        <span className="tabular-nums">{remaining}% left</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-[var(--bg-tertiary)]">
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, remaining))}%`, backgroundColor: limitTone(remaining) }} />
        {elapsed !== null ? (
          // The share of the window still to run: a fill past it is on pace.
          <span className="absolute -top-[3px] h-3 w-px bg-[var(--text-secondary)]" style={{ left: `${(1 - elapsed) * 100}%` }} aria-hidden="true" />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-4 text-[12px] text-[var(--text-muted)]">
        <span>{used}% used</span>
        {elapsed !== null ? <span>{Math.round(elapsed * 100)}% of the window gone</span> : null}
      </div>
      <div className="text-[12.5px] leading-[18px] text-[var(--text-secondary)]">
        {resetsAt
          ? `Resets ${resetsAt.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
          : 'No reset time reported.'}
        {pace ? ` ${pace}` : ''}
        {chip.detail ? ` ${chip.detail}` : ''}
      </div>
    </div>
  );
}

function PlanLimitChipView({ chip }: { chip: PlanLimitChip }) {
  const [open, setOpen] = useState(false);
  const remaining = chip.window ? Math.round(chip.window.remainingPercent) : null;
  const resetIn = chip.window ? formatResetIn(chip.window.resetsAt) : null;
  return (
    <span
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        data-plan-limit={chip.key}
        aria-expanded={open}
        // The app's usual hover: a gray fill, not a darker outline.
        className={`inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 ${
          open ? 'border-transparent bg-[var(--sidebar-item-hover)]' : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-transparent hover:bg-[var(--sidebar-item-hover)]'
        }`}
      >
        {remaining !== null ? <LimitRing remaining={remaining} /> : null}
        <span className="text-[var(--text-secondary)]">{chip.label}</span>
        <span className="font-semibold tabular-nums" style={chip.alert ? { color: 'var(--error)' } : remaining !== null && remaining < 20 ? { color: limitTone(remaining) } : { color: 'var(--text-primary)' }}>
          {remaining !== null ? `${remaining}%` : chip.value}
        </span>
        {resetIn ? <span className="text-[var(--text-muted)]">· {resetIn}</span> : null}
      </button>
      {open ? (
        <div role="tooltip" className="absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--border)] bg-[var(--popover-bg,var(--bg-primary))] p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]">
          <PlanLimitDetail chip={chip} />
        </div>
      ) : null}
    </span>
  );
}

/**
 * The agent's plan limits on one slim line under the toolbar: the plan, then a
 * chip per limit (share left and time to reset). Hovering a chip shows its
 * detail; refresh and failure notes sit at the start of the line.
 */
function PlanLimitStrip({ limits }: { limits: PlanLimits }) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2"
      role="group"
      aria-label={limits.title}
      data-settings-label={limits.title}
      data-plan-limits
    >
      {limits.chips.length && (limits.loading || limits.error) ? (
        // Saved limits stay on screen while they refresh or after a failed update.
        <span role="status" title={limits.error || undefined} className="mr-1 text-[12px] text-[var(--text-muted)]">
          {limits.loading ? 'Refreshing…' : 'Update failed; showing saved data'}
        </span>
      ) : null}
      {limits.plan ? <span className="mr-1 text-[12.5px] text-[var(--text-secondary)]">{limits.plan}</span> : null}
      {limits.chips.length ? (
        limits.chips.map((chip) => <PlanLimitChipView key={chip.key} chip={chip} />)
      ) : limits.empty ? (
        <span role="status" title={limits.error || undefined} className="text-[12.5px] text-[var(--text-muted)]">{limits.empty}</span>
      ) : null}
    </div>
  );
}

/* ---------- States ---------- */

function renderUsageState(provider: UsageProviderCard) {
  if (provider.loading && !provider.report) {
    return <InlineEmpty label="Loading usage…" />;
  }

  if (provider.error && !provider.loading && !provider.report) {
    return (
      <div className="px-4 py-4 text-center text-[12px] text-[var(--error)]">
        <span className="font-medium">Unable to load usage.</span> {normalizeUsageLoadError(new Error(provider.error), 'get-agent-usage-report')}
      </div>
    );
  }

  if (!provider.report && !provider.loading && !provider.error) {
    return (
      <InlineEmpty
        label={
          provider.id === 'opencode'
            ? 'OpenCode usage pipeline is not wired up yet.'
            : 'No usage recorded yet.'
        }
      />
    );
  }

  if (provider.report && provider.report.totals.totalTokens <= 0) {
    return <InlineEmpty label="No usage recorded in the last year." />;
  }

  return null;
}

function InlineEmpty({ label }: { label: string }) {
  return (
    <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">{label}</div>
  );
}

function normalizeUsageLoadError(error: unknown, channel: string): string {
  const rawMessage = error instanceof Error ? error.message : 'Failed to load usage.';
  return rawMessage.includes(`No handler registered for '${channel}'`)
    ? 'Usage needs an Electron restart to load the new main-process handler.'
    : rawMessage;
}

/* ---------- Codex limits ---------- */

function claudePlanWindowToTile(
  window: ClaudePlanUsageWindow | null,
  windowDurationMins: number
): CodexRateLimitWindow | null {
  if (!window || window.utilization === null) {
    return null;
  }
  return {
    usedPercent: window.utilization,
    remainingPercent: 100 - window.utilization,
    windowDurationMins,
    resetsAt: window.resetsAt,
  };
}

function formatClaudeExtraUsage(extra: NonNullable<ClaudePlanUsageReport['extraUsage']>): string {
  const currency = extra.currency || 'USD';
  if (extra.usedCredits !== null && extra.monthlyLimit !== null) {
    return `${formatClaudeCredits(extra.usedCredits, currency)} of ${formatClaudeCredits(extra.monthlyLimit, currency)} used`;
  }
  if (extra.monthlyLimit !== null) {
    return `Monthly limit ${formatClaudeCredits(extra.monthlyLimit, currency)}`;
  }
  return 'Extra usage enabled';
}

function formatClaudeCredits(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function grokPeriodLabel(period: GrokPlanUsageReport['currentPeriod']): string {
  if (period?.type === 'USAGE_PERIOD_TYPE_WEEKLY') return 'Weekly';
  if (period?.type === 'USAGE_PERIOD_TYPE_MONTHLY') return 'Monthly';
  if (period?.startsAt && period.endsAt) {
    const days = Math.round((period.endsAt - period.startsAt) / 86_400_000);
    if (days === 7) return 'Weekly';
    if (days >= 28 && days <= 31) return 'Monthly';
    if (days > 0) return `${days}-day`;
  }
  return 'Period';
}

function grokPlanWindowToTile(report: GrokPlanUsageReport): CodexRateLimitWindow | null {
  if (report.creditUsagePercent === null) {
    return null;
  }
  const period = report.currentPeriod;
  const windowDurationMins =
    period?.startsAt && period.endsAt && period.endsAt > period.startsAt
      ? Math.round((period.endsAt - period.startsAt) / 60_000)
      : null;
  return {
    usedPercent: report.creditUsagePercent,
    remainingPercent: 100 - report.creditUsagePercent,
    windowDurationMins,
    resetsAt: period?.endsAt ?? null,
  };
}

function qoderPlanWindowToTile(report: QoderPlanUsageReport): CodexRateLimitWindow | null {
  const usedPercent = report.totalUsagePercentage ?? report.userQuota?.percentage ?? null;
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: null,
    resetsAt: report.expiresAt,
  };
}

function formatQoderQuotaValue(bucket: NonNullable<QoderPlanUsageReport['userQuota']>): string {
  if (bucket.used !== null) {
    return bucket.used.toLocaleString();
  }
  if (bucket.percentage !== null) {
    return `${Math.round(bucket.percentage)}%`;
  }
  return '—';
}

function formatQoderQuotaSubtitle(bucket: NonNullable<QoderPlanUsageReport['userQuota']>): string {
  const unit = bucket.unit ? ` ${bucket.unit}` : '';
  if (bucket.total !== null) {
    return `of ${bucket.total.toLocaleString()}${unit} used`;
  }
  if (bucket.remaining !== null) {
    return `${bucket.remaining.toLocaleString()}${unit} remaining`;
  }
  return 'Used';
}

function getCodexRateLimitEntries(report: CodexRateLimitReport | null): Array<{
  id: string;
  snapshot: CodexRateLimitSnapshot;
}> {
  if (!report) {
    return [];
  }

  const entries = Object.entries(report.rateLimitsByLimitId).map(([id, snapshot]) => ({
    id,
    snapshot,
  }));

  if (report.rateLimits) {
    const id = report.rateLimits.limitId || 'codex';
    const existing = entries.some((entry) => entry.id === id);
    if (!existing) {
      entries.unshift({ id, snapshot: report.rateLimits });
    }
  }

  return entries.sort((left, right) => {
    if (left.id === 'codex') return -1;
    if (right.id === 'codex') return 1;
    return getCodexRateLimitName(left.id, left.snapshot).localeCompare(
      getCodexRateLimitName(right.id, right.snapshot)
    );
  });
}

function getCodexRateLimitName(id: string, snapshot: CodexRateLimitSnapshot): string {
  return snapshot.limitName || snapshot.limitId || id || 'Codex';
}

function formatRateLimitWindowName(window: CodexRateLimitWindow | null | undefined, fallback: string): string {
  const minutes = window?.windowDurationMins;
  if (!minutes) return fallback;
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatLocalTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeTimestampMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatPlanName(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatRateLimitReachedType(value: string): string {
  return formatPlanName(value.replace(/_/g, ' '));
}

/* ---------- Shared formatting ---------- */

function ModelProviderLogo({
  model,
  color,
  className = 'h-4 w-4',
}: {
  model: string;
  color: string;
  className?: string;
}) {
  const logo = getProviderLogoForModel(model);

  if (!logo) {
    return (
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
    );
  }

  // One-color marks follow the theme, like the agent picker's logos.
  const monochrome = [claudeLogo, openaiLogo, grokLogo, moonshotLogo, mimoLogo].includes(logo);
  return <img src={logo} alt="" className={`${className} flex-shrink-0 ${monochrome ? 'settings-monochrome-logo' : ''}`} aria-hidden="true" />;
}

function getProviderLogoForModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    // Devin rows use catalog names ("GPT-6.1 Sol", "GPT 5.5").
    /^gpt[\s-]/.test(normalized) ||
    normalized.startsWith('codex') ||
    normalized === 'chatgpt' ||
    /^o[134]/.test(normalized)
  ) {
    return openaiLogo;
  }

  if (
    normalized.startsWith('claude-') ||
    // Devin rows use catalog names ("Claude Opus 5.5 · High", "Sonnet 4.5").
    normalized.startsWith('claude ') ||
    /^(opus|sonnet|haiku)\b/.test(normalized)
  ) {
    return claudeLogo;
  }

  // Bubble usage keeps provider-qualified model IDs, including Coding Plan aliases.
  const providerId = normalized.split(/[:/]/, 1)[0];
  if (
    normalized.startsWith('glm') ||
    ['zhipu', 'zhipuai', 'zhipuai-coding-plan', 'zai', 'zai-coding-plan'].includes(providerId)
  ) {
    return zhipuLogo;
  }

  if (normalized.startsWith('grok')) {
    return grokLogo;
  }

  if (normalized === 'pi' || normalized.startsWith('pi-') || normalized.startsWith('inflection')) {
    return piLogo;
  }

  if (normalized === 'bubble' || normalized.startsWith('bubble')) {
    return bubbleLogo;
  }

  // "K3" / "K2.7 Coding" are Kimi display labels (see relabelUsageReportModels).
  if (normalized.startsWith('kimi') || /^k[0-9]/.test(normalized)) {
    return moonshotLogo;
  }

  if (normalized.startsWith('deepseek')) {
    return deepseekLogo;
  }

  // Cognition's own SWE model family, served through Devin.
  if (normalized.startsWith('swe-') || normalized === 'devin') {
    return devinLogo;
  }

  // MiniMax Code stores its select value, `m:<provider>:<model>:v:<variant>`.
  if (normalized.startsWith('minimax') || normalized.startsWith('m:minimax:')) {
    return minimaxLogo;
  }

  if (normalized.startsWith('mimo') || providerId === 'xiaomi') {
    return mimoLogo;
  }

  return null;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${trimTrailingZero((value / 1_000_000_000).toFixed(1))}B`;
  }
  if (value >= 1_000_000) {
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}K`;
  }
  return value.toLocaleString('en-US');
}

function formatCurrency(value: number, estimated = false): string {
  if (value === 0) {
    return '$0.00';
  }

  if (value > 0 && value < 0.0001) return '<$0.0001';
  if (value < 0.01) {
    return `${estimated ? '≈' : ''}$${value.toFixed(4)}`;
  }

  return `${estimated ? '≈' : ''}${value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatShortDate(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatLongDate(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

import type {
  AgentProvider,
  ClaudeUsageDailyPoint,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  UsageCostByType,
} from '../types';

/** One agent's reports, as the overview adds them up. */
export interface OverviewAgentInput {
  provider: AgentProvider;
  title: string;
  /** The picked range's report. */
  range: ClaudeUsageReport | null;
  /** The year's report: the activity grid, trends and "last used" read it. */
  year: ClaudeUsageReport | null;
}

export interface OverviewAgentRow {
  provider: AgentProvider;
  title: string;
  /** Dollars spent in the range; null for an agent counted in its own unit. */
  costUsd: number | null;
  /** The dollars include API-price estimates. */
  estimated: boolean;
  /** Share of the total cost, 0-1. */
  share: number | null;
  /** What an agent without dollars is counted in; it stays out of the total. */
  own: { messages: number; credits: number; tokens: number; sessions: number } | null;
  /** 0-3 for the four agents that cost most; null for the rest. */
  series: number | null;
}

/** One point of the cost chart: a day of the range. */
export interface OverviewDay {
  /** The day's date key. */
  date: string;
  totalCostUsd: number;
  /** The agents that spent on it, in the list's order. */
  agents: Array<{ provider: AgentProvider; costUsd: number }>;
}

export interface UsageOverview {
  totalCostUsd: number;
  /** The total includes API-price estimates. */
  estimated: boolean;
  totalTokens: number;
  sessionCount: number;
  agents: OverviewAgentRow[];
  /** Every day of the range, oldest first. */
  days: OverviewDay[];
  /** Null when no agent's report carries the split. */
  costByType: UsageCostByType | null;
  /** Every agent's models in one report, for the model table. */
  report: ClaudeUsageReport;
  /** Every agent's year, day by day. */
  yearDaily: ClaudeUsageDailyPoint[];
}

/** The range's tokens as the model table adds them up, so a headline and its Total row agree. */
export function ledgerTotalTokens(report: ClaudeUsageReport): number {
  const sum = report.models.reduce((total, model) => total + model.totalTokens, 0);
  return sum > 0 ? sum : report.totals.totalTokens;
}

function hasUsage(report: ClaudeUsageReport): boolean {
  return ledgerTotalTokens(report) > 0
    || report.totals.totalCostUsd > 0
    || report.totals.sessionCount > 0
    || (report.billing?.agentMessages ?? 0) > 0
    || (report.billing?.credits ?? 0) > 0;
}

/**
 * An agent whose usage adds up in dollars: anything with a cost, returned or
 * estimated at API prices. That includes Devin, which bills in messages but
 * whose Claude and GPT tokens have API prices. An agent with no priced usage
 * (Qoder's credits, a model without listed rates) shows its own unit instead.
 */
function countsInDollars(report: ClaudeUsageReport): boolean {
  return report.totals.totalCostUsd > 0;
}

function dayCostUsd(point: ClaudeUsageDailyPoint): number {
  return Object.values(point.byModelCostUsd ?? {}).reduce((sum, usd) => sum + usd, 0);
}

function addInto(target: Record<string, number>, source: Record<string, number> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) target[key] = (target[key] || 0) + value;
}

/** Several agents' days as one series; dollars only from the agents that count in them. */
function mergeDaily(reports: Array<{ report: ClaudeUsageReport; dollars: boolean }>): ClaudeUsageDailyPoint[] {
  const days = new Map<string, ClaudeUsageDailyPoint>();
  for (const { report, dollars } of reports) {
    for (const point of report.daily) {
      let day = days.get(point.date);
      if (!day) {
        day = { date: point.date, totalTokens: 0, byModel: {}, byModelCostUsd: {} };
        days.set(point.date, day);
      }
      day.totalTokens += point.totalTokens;
      addInto(day.byModel, point.byModel);
      if (dollars) addInto(day.byModelCostUsd!, point.byModelCostUsd);
    }
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const COST_BY_TYPE_KEYS: Array<keyof UsageCostByType> = [
  'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
  'inputCostUsd', 'cacheReadCostUsd', 'cacheWriteCostUsd', 'outputCostUsd', 'unsplitCostUsd',
];

/**
 * Every agent's usage in one view: the cost total, agents ranked by cost, cost
 * per day by agent, cost by type, and one model report.
 */
export function buildUsageOverview(inputs: OverviewAgentInput[], rangeDays: ClaudeUsageRangeDays): UsageOverview {
  const used = inputs.flatMap((input) => (input.range && hasUsage(input.range) ? [{ ...input, range: input.range }] : []));
  const dollarAgents = used.filter((input) => countsInDollars(input.range))
    .sort((left, right) => right.range.totals.totalCostUsd - left.range.totals.totalCostUsd);
  const ownUnitAgents = used.filter((input) => !countsInDollars(input.range));
  const totalCostUsd = dollarAgents.reduce((sum, input) => sum + input.range.totals.totalCostUsd, 0);
  const isEstimated = (report: ClaudeUsageReport) => report.costMode === 'estimated' || report.costMode === 'partial';
  const estimated = dollarAgents.some((input) => isEstimated(input.range));

  const agents: OverviewAgentRow[] = [
    ...dollarAgents.map((input, index): OverviewAgentRow => ({
      provider: input.provider,
      title: input.title,
      costUsd: input.range.totals.totalCostUsd,
      estimated: isEstimated(input.range),
      share: totalCostUsd > 0 ? input.range.totals.totalCostUsd / totalCostUsd : null,
      own: null,
      series: index < 4 ? index : null,
    })),
    ...ownUnitAgents.map((input): OverviewAgentRow => ({
      provider: input.provider,
      title: input.title,
      costUsd: null,
      estimated: false,
      share: null,
      own: {
        messages: input.range.billing?.agentMessages ?? 0,
        credits: input.range.billing?.credits ?? 0,
        tokens: ledgerTotalTokens(input.range),
        sessions: input.range.totals.sessionCount,
      },
      series: null,
    })),
  ];

  // Cost per day by agent, for every day of the range.
  const costOn = new Map<string, Map<AgentProvider, number>>();
  for (const input of dollarAgents) {
    for (const point of input.range.daily) {
      const usd = dayCostUsd(point);
      const day = costOn.get(point.date) ?? new Map<AgentProvider, number>();
      if (usd > 0) day.set(input.provider, usd);
      costOn.set(point.date, day);
    }
  }
  const days: OverviewDay[] = [...costOn.keys()].sort().map((date) => {
    const spent = costOn.get(date)!;
    const dayAgents = dollarAgents.flatMap((input) => {
      const costUsd = spent.get(input.provider);
      return costUsd ? [{ provider: input.provider, costUsd }] : [];
    });
    return { date, totalCostUsd: dayAgents.reduce((sum, entry) => sum + entry.costUsd, 0), agents: dayAgents };
  });

  const typed = dollarAgents.flatMap((input) => (input.range.costByType ? [input.range.costByType] : []));
  const costByType = typed.length
    ? typed.reduce<UsageCostByType>((sum, part) => {
        for (const key of COST_BY_TYPE_KEYS) sum[key] += part[key];
        return sum;
      }, {
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        inputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: 0, unsplitCostUsd: 0,
      })
    : null;

  // One model table: rows that share a name add up. A row is unpriced when
  // nothing that went into it has a dollar amount.
  const models = new Map<string, ClaudeUsageModelSummary>();
  const priced = new Set<string>();
  const unpriced = new Set<string>();
  let cacheReads = 0;
  let cacheInput = 0;
  for (const input of used) {
    const report = input.range;
    const dollars = countsInDollars(report);
    const fullyPriced = dollars && (report.costMode === 'actual' || report.costMode === 'estimated' || !report.costMode);
    const agentUnpriced = new Set(report.costCoverage?.unpricedModels ?? []);
    for (const model of report.models) {
      const cost = dollars ? model.totalCostUsd : 0;
      const row = models.get(model.model) ?? {
        model: model.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0, sessionCount: 0, cacheReadTokens: 0,
      };
      row.inputTokens += model.inputTokens;
      row.outputTokens += model.outputTokens;
      row.totalTokens += model.totalTokens;
      row.totalCostUsd += cost;
      row.sessionCount += model.sessionCount;
      row.cacheReadTokens += model.cacheReadTokens;
      models.set(model.model, row);
      if (cost > 0 || (fullyPriced && !agentUnpriced.has(model.model))) priced.add(model.model);
      else unpriced.add(model.model);
    }
    // Cache hit over everything that could have been read from the cache.
    const split = report.costByType;
    if (split) {
      cacheReads += split.cacheReadTokens;
      cacheInput += split.inputTokens + split.cacheReadTokens + split.cacheWriteTokens;
    } else {
      cacheReads += report.totals.cacheReadTokens;
      cacheInput += report.totals.cacheHitRate > 0
        ? report.totals.cacheReadTokens / report.totals.cacheHitRate
        : report.totals.inputTokens;
    }
  }
  const totalTokens = used.reduce((sum, input) => sum + ledgerTotalTokens(input.range), 0);
  const sessionCount = used.reduce((sum, input) => sum + input.range.totals.sessionCount, 0);
  const report: ClaudeUsageReport = {
    rangeDays,
    costMode: estimated ? 'estimated' : 'actual',
    costCoverage: {
      pricedTokens: 0,
      unpricedTokens: 0,
      unpricedModels: [...unpriced].filter((model) => !priced.has(model)),
    },
    note: 'Amounts the agents returned, and official API prices for the rest. API equivalents are estimates, not subscription bills.',
    totals: {
      inputTokens: used.reduce((sum, input) => sum + input.range.totals.inputTokens, 0),
      outputTokens: used.reduce((sum, input) => sum + input.range.totals.outputTokens, 0),
      totalTokens,
      totalCostUsd,
      sessionCount,
      cacheReadTokens: cacheReads,
      cacheHitRate: cacheInput > 0 ? cacheReads / cacheInput : 0,
    },
    ...(costByType ? { costByType } : {}),
    models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens || right.totalCostUsd - left.totalCostUsd),
    daily: mergeDaily(used.map((input) => ({ report: input.range, dollars: countsInDollars(input.range) }))),
  };

  // The year's days from every agent that has any, in or out of the range.
  const yearDaily = mergeDaily(inputs.flatMap((input) =>
    (input.year ? [{ report: input.year, dollars: countsInDollars(input.year) }] : [])));

  return { totalCostUsd, estimated, totalTokens, sessionCount, agents, days, costByType, report, yearDaily };
}

/** "Nice" dollar ticks for the cost chart: at most four above zero, and the scale's top. */
export function costAxis(maxUsd: number): { ticks: number[]; top: number } {
  if (!(maxUsd > 0)) return { ticks: [], top: 1 };
  const magnitude = 10 ** Math.floor(Math.log10(maxUsd / 4));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => maxUsd / candidate <= 4) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let tick = step; tick <= maxUsd * 1.0001; tick += step) ticks.push(tick);
  // Headroom, so the highest point does not touch the card's edge.
  return { ticks, top: maxUsd * 1.08 };
}

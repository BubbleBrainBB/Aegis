import type {
  ClaudePlanUsageReport, ClaudePlanUsageWindow, ClaudeUsageReport, CodexRateLimitReport,
  CodexRateLimitWindow, GrokPlanUsageReport, QoderPlanUsageReport,
} from '../types';

/** One plan limit window: how much is left and when it resets. */
export interface UsageWindow {
  label: string;
  /** Percent left, 0-100. */
  remaining: number;
  /** Epoch ms, or null when the provider does not say. */
  resetsAt: number | null;
}

/** A provider's plan as the usage menu shows it. */
export interface UsagePlan {
  tier: string | null;
  windows: UsageWindow[];
}

export type UsageTone = 'ok' | 'watch' | 'low';

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function timestampMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/** "pro" → "Pro", "claude_max" → "Claude Max"; tiers that are already names pass through. */
export function formatTier(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/[A-Z]/.test(raw)) return raw;
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function plan(tier: string | null | undefined, windows: Array<UsageWindow | null>): UsagePlan | null {
  const present = windows.filter((window): window is UsageWindow => window !== null);
  return present.length ? { tier: formatTier(tier), windows: present } : null;
}

function claudeWindow(label: string, window: ClaudePlanUsageWindow | null): UsageWindow | null {
  if (!window || typeof window.utilization !== 'number') return null;
  return { label, remaining: clampPercent(100 - window.utilization), resetsAt: timestampMs(window.resetsAt) };
}

export function claudePlan(report: ClaudePlanUsageReport | null): UsagePlan | null {
  if (!report?.rateLimitsAvailable) return null;
  return plan(report.subscriptionType, [
    claudeWindow('5-hour', report.fiveHour),
    claudeWindow('Weekly', report.sevenDay),
  ]);
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes === 10_080) return 'Weekly';
  if (minutes === 1440) return 'Daily';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}

function codexWindow(window: CodexRateLimitWindow | null, fallback: string): UsageWindow | null {
  if (!window || typeof window.usedPercent !== 'number') return null;
  return {
    label: windowLabel(window.windowDurationMins, fallback),
    remaining: clampPercent(100 - window.usedPercent),
    resetsAt: timestampMs(window.resetsAt),
  };
}

export function codexPlan(report: CodexRateLimitReport | null): UsagePlan | null {
  if (!report) return null;
  // The main Codex bucket, as on the detail page.
  const buckets = { ...report.rateLimitsByLimitId };
  if (report.rateLimits) buckets[report.rateLimits.limitId || 'codex'] ??= report.rateLimits;
  const main = buckets.codex || Object.entries(buckets)
    .sort(([a, left], [b, right]) => (left.limitName || left.limitId || a).localeCompare(right.limitName || right.limitId || b))[0]?.[1];
  if (!main) return null;
  return plan(main.planType, [codexWindow(main.primary, 'Primary'), codexWindow(main.secondary, 'Secondary')]);
}

function grokPeriodLabel(period: GrokPlanUsageReport['currentPeriod']): string {
  const type = period?.type?.toUpperCase() || '';
  if (type.includes('WEEK')) return 'Weekly';
  if (type.includes('MONTH')) return 'Monthly';
  if (type.includes('DAILY')) return 'Daily';
  if (period?.startsAt && period.endsAt && period.endsAt > period.startsAt) {
    return windowLabel(Math.round((period.endsAt - period.startsAt) / 60_000 / 1440) * 1440, 'Period');
  }
  return 'Period';
}

export function grokPlan(report: GrokPlanUsageReport | null): UsagePlan | null {
  if (!report || typeof report.creditUsagePercent !== 'number') return null;
  return plan(report.subscriptionTier, [{
    label: grokPeriodLabel(report.currentPeriod),
    remaining: clampPercent(100 - report.creditUsagePercent),
    resetsAt: timestampMs(report.currentPeriod?.endsAt),
  }]);
}

export function qoderPlan(report: QoderPlanUsageReport | null): UsagePlan | null {
  const used = report?.totalUsagePercentage ?? report?.userQuota?.percentage;
  if (!report || typeof used !== 'number') return null;
  return plan(report.userType, [{ label: 'Quota', remaining: clampPercent(100 - used), resetsAt: timestampMs(report.expiresAt) }]);
}

/** 60% or more left is fine, 25-60% is worth watching, under 25% is close to the limit. */
export function usageTone(remaining: number): UsageTone {
  return remaining >= 60 ? 'ok' : remaining >= 25 ? 'watch' : 'low';
}

/** "in 2h 14m" within a day, "Thu 09:00" within a week, else "Nov 1". */
export function formatReset(resetsAt: number | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt - now;
  if (ms <= 60_000) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const date = new Date(resetsAt);
  if (ms < 7 * 86_400_000) {
    const weekday = date.toLocaleDateString('en', { weekday: 'short' });
    const time = date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return `${weekday} ${time}`;
  }
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/** Tokens over the report's daily series, the detail page's basis. */
export function reportTokens(report: ClaudeUsageReport | null): { tokens: number; sessions: number } {
  if (!report) return { tokens: 0, sessions: 0 };
  return {
    tokens: report.daily.reduce((sum, day) => sum + day.totalTokens, 0),
    sessions: report.totals.sessionCount,
  };
}

export function formatTokens(tokens: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
}

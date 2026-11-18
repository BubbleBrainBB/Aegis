import type { ClaudeUsageReport } from '../types';

/**
 * Bubble records a model as `<provider>:<id>`. The id alone, when what is in
 * front of the first colon is one of Bubble's providers: an id can have a
 * colon of its own, and an unknown provider stays in the name.
 */
export function bubbleModelName(model: string, providerIds: ReadonlySet<string>): string {
  const colon = model.indexOf(':');
  if (colon <= 0) return model;
  const name = model.slice(colon + 1).trim();
  return name && providerIds.has(model.slice(0, colon).trim().toLowerCase()) ? name : model;
}

/**
 * Rename a usage report's models (model summaries and the daily buckets).
 * Ids that get the same name add up into one row; with `keepSources` such a
 * row, and any renamed one, keeps the ids it was recorded under.
 */
export function relabelUsageReportModels(
  report: ClaudeUsageReport,
  labelOf: (model: string) => string,
  options: { keepSources?: boolean } = {},
): ClaudeUsageReport {
  const renamed = (models: Iterable<string>) => {
    for (const model of models) if (labelOf(model) !== model) return true;
    return false;
  };
  if (!renamed(report.models.map((summary) => summary.model))
    && !report.daily.some((day) => renamed(Object.keys(day.byModel)) || renamed(Object.keys(day.byModelCostUsd ?? {})))) {
    return report;
  }

  const mergedModels = new Map<string, ClaudeUsageReport['models'][number]>();
  const sources = new Map<string, string[]>();
  for (const summary of report.models) {
    const label = labelOf(summary.model);
    sources.set(label, [...(sources.get(label) ?? []), summary.model]);
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
  if (options.keepSources) {
    for (const [label, ids] of sources) {
      if (ids.some((id) => id !== label)) mergedModels.get(label)!.sourceModels = ids;
    }
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

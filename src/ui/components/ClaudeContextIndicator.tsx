import type { ClaudeContextSnapshot } from '../utils/context-usage';
import { ContextUsagePopover } from './ContextUsagePopover';

export function ClaudeContextIndicator({
  snapshot,
  modelLabel,
}: {
  snapshot: ClaudeContextSnapshot | null;
  modelLabel?: string | null;
}) {
  return (
    <ContextUsagePopover
      modelLabel={modelLabel || snapshot?.model || 'Claude'}
      usage={snapshot ? { used: snapshot.used, total: snapshot.total, percent: snapshot.percent } : null}
      breakdown={snapshot?.categories ? { categories: snapshot.categories, counts: snapshot.counts } : undefined}
    />
  );
}

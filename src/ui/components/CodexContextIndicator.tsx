import type { CodexContextSnapshot } from '../utils/context-usage';
import { ContextUsagePopover } from './ContextUsagePopover';

export function CodexContextIndicator({
  snapshot,
  modelLabel,
}: {
  snapshot: CodexContextSnapshot;
  modelLabel?: string | null;
}) {
  return (
    <ContextUsagePopover
      modelLabel={modelLabel || 'Context window'}
      usage={{ used: snapshot.used, total: snapshot.total, percent: snapshot.percent }}
    />
  );
}

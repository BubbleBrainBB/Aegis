import type { OpenCodeContextSnapshot } from '../utils/context-usage';
import { ContextUsagePopover } from './ContextUsagePopover';

export function OpenCodeContextIndicator({
  snapshot,
  modelLabel,
  providerLabel = 'OpenCode',
}: {
  snapshot: OpenCodeContextSnapshot | null;
  modelLabel?: string | null;
  providerLabel?: string;
}) {
  return (
    <ContextUsagePopover
      modelLabel={modelLabel || snapshot?.model || providerLabel}
      usage={
        snapshot
          ? { used: snapshot.used, total: snapshot.total, percent: snapshot.percent, estimated: snapshot.estimated }
          : null
      }
      waitingLabel={`Waiting for ${providerLabel} usage from this model.`}
    />
  );
}

import { ExternalLink, PanelRight, Square, X } from './icons';
import { useEnvironmentPanelStore } from '../store/useEnvironmentPanelStore';
import { ComputerUseWindowPreview } from './ComputerUseWindowPreview';
import { sendEvent } from '../hooks/useIPC';
import type { ComputerUseGrantView, ComputerUseLiveFrame } from '../../shared/computer-use';

export function ComputerUseGrantBadge({
  sessionId,
  grants,
}: {
  sessionId: string;
  grants: ComputerUseGrantView[];
}) {
  if (grants.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
      <span className="font-medium">Computer Use allowed until revoked</span>
      {grants.map((grant) => (
        <span key={grant.key} className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]">
          {grant.tool} · {grant.app}
        </span>
      ))}
      <button
        type="button"
        onClick={() => sendEvent({ type: 'computerUse.revoke', payload: { sessionId } })}
        className="ml-auto text-[11px] font-medium uppercase tracking-[0.08em] text-amber-800 hover:underline"
      >
        Revoke
      </button>
    </div>
  );
}

export function ComputerUseLiveHud({
  sessionId, frame, isForeground, detached, inSidebar = false,
}: {
  sessionId: string;
  frame: ComputerUseLiveFrame | null;
  isForeground: boolean;
  detached: boolean;
  inSidebar?: boolean;
}) {
  const placement = useEnvironmentPanelStore(s => s.computerUsePlacement[sessionId] ?? 'floating');
  const place = useEnvironmentPanelStore(s => s.placeComputerUse);
  if (!isForeground || detached || !frame?.media || placement === 'hidden' || (placement === 'sidebar') !== inSidebar) return null;
  const open = () => void window.electron.openComputerUsePreview({ sessionId });
  return (
    <div className="computer-use-pip" data-placement={placement}>
      <button type="button" className="computer-use-pip-image" aria-label="Open Computer Use preview" onClick={open}>
        <ComputerUseWindowPreview frame={frame} />
      </button>
      <div className="computer-use-pip-controls">
        <button type="button" title="Move to floating window" aria-label="Move to floating window" onClick={open}><ExternalLink /></button>
        <button type="button" title={inSidebar ? 'Move to chat' : 'Move to sidebar'} aria-label={inSidebar ? 'Move to chat' : 'Move to sidebar'} onClick={() => place(sessionId, inSidebar ? 'floating' : 'sidebar')}><PanelRight /></button>
        <button type="button" title="Stop Computer Use" aria-label="Stop Computer Use" onClick={() => void window.electron.stopComputerUse(sessionId)}><Square /></button>
        <button type="button" title="Hide picture in picture" aria-label="Hide picture in picture" onClick={() => place(sessionId, 'hidden')}><X /></button>
      </div>
    </div>
  );
}

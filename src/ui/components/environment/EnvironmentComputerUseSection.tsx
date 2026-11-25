import { Monitor } from '../icons';
import { ComputerUseLiveHud } from '../ComputerUseLiveHud';
import { useEnvironmentPanelStore } from '../../store/useEnvironmentPanelStore';
import { environmentHasComputerUseSection } from '../../../shared/computer-use';
import type { SessionView } from '../../types';

export { environmentHasComputerUseSection };

export function EnvironmentComputerUseSection({ session, sessionId, previewOpen }: {
  session: SessionView | null;
  sessionId: string | null;
  previewOpen: boolean;
}) {
  const placement = useEnvironmentPanelStore(s => sessionId ? s.computerUsePlacement[sessionId] : undefined);
  const place = useEnvironmentPanelStore(s => s.placeComputerUse);
  if (!sessionId || !environmentHasComputerUseSection(session)) return null;
  const hidden = placement === 'hidden';
  const toggle = () => {
    place(sessionId, hidden ? 'floating' : 'hidden');
    if (previewOpen) void window.electron.closeComputerUsePreview();
  };
  return (
    <section className="environment-summary-section" aria-label="Computer Use">
      <div className="environment-summary-row">
        <Monitor className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span>Picture in Picture</span>
        <button type="button" className="ml-auto text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          aria-label={hidden ? 'Show picture in picture' : 'Hide picture in picture'} onClick={toggle}>
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
      <ComputerUseLiveHud sessionId={sessionId} frame={session?.computerUseLive ?? null}
        detached={previewOpen} isForeground inSidebar />
    </section>
  );
}

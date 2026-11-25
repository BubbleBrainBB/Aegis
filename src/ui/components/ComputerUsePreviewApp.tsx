import { useEffect, useState } from 'react';
import { PanelRight, Square } from './icons';
import { ComputerUseWindowPreview } from './ComputerUseWindowPreview';
import { DEFAULT_APPEARANCE, DEFAULT_UI_FONT_FAMILY, renderAppearance } from '../theme/themes';
import type { ComputerUsePreviewSnapshot } from '../../shared/computer-use';

export function ComputerUsePreviewApp() {
  const [snapshot, setSnapshot] = useState<ComputerUsePreviewSnapshot | null>(null);

  useEffect(() => {
    renderAppearance({ mode: 'system', state: DEFAULT_APPEARANCE, uiFontFamily: DEFAULT_UI_FONT_FAMILY });
    let cancelled = false;
    let receivedUpdate = false;
    void window.electron.getComputerUsePreviewState().then((state) => {
      if (!cancelled && !receivedUpdate) setSnapshot(state);
    });
    const unsubscribe = window.electron.onComputerUsePreviewState((state) => {
      receivedUpdate = true;
      setSnapshot(state);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!snapshot?.live) return null;
  return (
    <div className="computer-use-pip computer-use-native-pip drag-region">
      {snapshot.live.media && <ComputerUseWindowPreview frame={snapshot.live} onDimensions={window.electron.fitComputerUsePreview} />}
      <div className="computer-use-pip-controls no-drag">
        <button type="button" title="Dock" aria-label="Dock" onClick={() => void window.electron.closeComputerUsePreview()}><PanelRight /></button>
        <button type="button" title="Stop Computer Use" aria-label="Stop Computer Use" onClick={() => void window.electron.stopComputerUse(snapshot.sessionId)}><Square /></button>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { AlertTriangle, Download, RefreshCw } from '../icons';

const BUTTON_CLASS =
  'no-drag relative inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] outline-none transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * Sits above the profile avatar at the foot of the icon rail once a new
 * version is out: click to download it, then click again to restart into it.
 */
export function SidebarUpdateButton() {
  const status = useAppStore((state) => state.updateStatus);

  // The first status broadcast can land before the renderer listens.
  useEffect(() => {
    let alive = true;
    const before = useAppStore.getState().updateStatus;
    void window.electron.getUpdateStatus?.().then((current) => {
      // A broadcast that arrived meanwhile is newer than this reply.
      if (alive && current && useAppStore.getState().updateStatus === before) {
        useAppStore.setState({ updateStatus: current });
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const version = status.version ? ` ${status.version}` : '';

  if (status.phase === 'downloading') {
    const progress = status.progress ?? 0;
    const label = progress >= 100 ? `Preparing Aegis${version}` : `Downloading Aegis${version} · ${progress}%`;
    return (
      <span role="progressbar" aria-label={label} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} title={label} className={`${BUTTON_CLASS} text-[var(--accent)]`}>
        <svg viewBox="0 0 30 30" className="absolute inset-0 h-[30px] w-[30px] -rotate-90" aria-hidden="true">
          <circle cx="15" cy="15" r={RING_RADIUS} fill="none" stroke="var(--panel-soft-divider)" strokeWidth="2" />
          <circle
            cx="15"
            cy="15"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - progress / 100)}
            className="transition-[stroke-dashoffset] duration-300"
          />
        </svg>
        <Download className="h-[13px] w-[13px]" strokeWidth={1.8} />
      </span>
    );
  }

  const action =
    status.phase === 'available'
      ? { label: `Download and install Aegis${version}`, icon: <Download className="h-[17px] w-[17px]" strokeWidth={1.6} />, run: () => window.electron.downloadUpdate() }
      : status.phase === 'downloaded'
        ? { label: `Restart to update to Aegis${version}`, icon: <RefreshCw className="h-[17px] w-[17px]" strokeWidth={1.6} />, run: () => window.electron.installUpdate() }
        : status.phase === 'error'
          ? { label: `Update failed${status.error ? `: ${status.error}` : ''}. Click to retry.`, icon: <AlertTriangle className="h-[17px] w-[17px]" strokeWidth={1.6} />, run: () => window.electron.downloadUpdate() }
          : null;
  if (!action) return null;

  const tone = status.phase === 'error'
    ? 'text-[var(--warning)] hover:bg-[var(--sidebar-item-hover)]'
    : 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]';

  return (
    <button
      type="button"
      aria-label={action.label}
      title={action.label}
      onClick={(event) => {
        event.currentTarget.blur();
        void action.run();
      }}
      className={`${BUTTON_CLASS} ${tone}`}
    >
      {action.icon}
    </button>
  );
}

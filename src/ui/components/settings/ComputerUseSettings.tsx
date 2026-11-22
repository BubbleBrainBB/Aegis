import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cuaDriverReleaseUrl, type ComputerUseSettingsView } from '../../../shared/computer-use';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

/**
 * Computer use: the switch as it is in effect (off until the user turns it on), the
 * driver binary Aegis would run, and the two macOS grants it needs. Off, no
 * agent is offered the tools and no driver process runs.
 */
export function ComputerUseSettings() {
  const [view, setView] = useState<ComputerUseSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pathDraft, setPathDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    window.electron
      .getComputerUseSettings()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setPathDraft(next.driverPath);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retry]);

  const apply = useCallback(async (change: () => Promise<ComputerUseSettingsView>, failure: string) => {
    setBusy(true);
    try {
      const next = await change();
      setView(next);
      setPathDraft(next.driverPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure);
    } finally {
      setBusy(false);
    }
  }, []);

  if (loadError) {
    return (
      <SettingsGroup title="Computer use">
        <div role="alert" className="px-4 py-3 text-[13px]">
          Could not load Computer use settings.{' '}
          <button className="settings-button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      </SettingsGroup>
    );
  }
  if (!view) {
    return (
      <SettingsGroup title="Computer use">
        <div className="px-4 py-2.5 text-[13px] text-[var(--text-muted)]">Loading…</div>
      </SettingsGroup>
    );
  }

  const unsupported = view.driver.state === 'unsupported-platform';
  const driverReady = view.driver.state === 'ready';
  const pathChanged = pathDraft.trim() !== view.driverPath;

  return (
    <SettingsGroup
      title="Computer use"
      description="Lets agents look at and operate apps on this Mac: Bubble, Claude, DeepSeek Harness, Qoder, Devin, MiniMax Code, MiMo Code, Grok Build, Pi and OpenCode. They can read any window except Aegis's own; every click, key press or typed text asks you first unless the conversation runs in Full Access. Codex has its own Computer use, which this switch does not change."
    >
      <SettingsRow
        variant="card"
        label="Enable Computer use"
        description={
          unsupported
            ? view.driver.message ?? undefined
            : view.enabledByEnvironment
              ? 'On for this run: AEGIS_COMPUTER_USE_ENABLED=1 is set. Restart Aegis without it to use this switch.'
              : 'Off by default. While off, nothing is started.'
        }
      >
        <SettingsToggle
          checked={view.enabled}
          onChange={(value) =>
            void apply(() => window.electron.setComputerUseEnabled(value), 'Failed to toggle Computer use.')
          }
          disabled={busy || unsupported || view.enabledByEnvironment}
          ariaLabel="Toggle Computer use"
        />
      </SettingsRow>
      {unsupported ? null : (
        <>
          <SettingsRow
            variant="card"
            align="start"
            label="Driver"
            description={
              driverReady
                ? `cua-driver ${view.driver.version} · ${view.driver.path}`
                : view.driver.message ?? undefined
            }
          >
            <span
              data-computer-use-driver={view.driver.state}
              className={`text-[12px] ${driverReady ? 'text-[var(--text-muted)]' : 'text-[var(--warning)]'}`}
            >
              {driverReady ? 'Ready' : view.driver.state === 'missing' ? 'Not found' : 'Wrong version'}
            </span>
          </SettingsRow>
          <div className="settings-row flex items-center gap-2 px-4 py-3" data-settings-label="Driver path">
            <input
              className="settings-control min-w-0 flex-1"
              aria-label="cua-driver path"
              placeholder={`Path to cua-driver ${view.driver.pinnedVersion} (optional)`}
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              disabled={busy}
              spellCheck={false}
            />
            {driverReady ? null : (
              <button
                type="button"
                className="settings-button"
                data-computer-use-driver-download
                onClick={() => void window.electron.openExternalUrl(cuaDriverReleaseUrl(view.driver.pinnedVersion))}
              >
                Download page
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              disabled={busy || !pathChanged}
              onClick={() =>
                void apply(() => window.electron.setComputerUseDriverPath(pathDraft), 'Failed to save the driver path.')
              }
            >
              Save
            </button>
          </div>
          {view.permissions ? (
            <>
              <PermissionRow
                label="Accessibility"
                description="Lets Computer use read an app's controls and click or type in it."
                granted={view.permissions.accessibility}
                pane="accessibility"
              />
              <PermissionRow
                label="Screen Recording"
                description="Lets Computer use take a picture of the window it works in."
                granted={view.permissions.screenRecording}
                pane="screen-recording"
              />
            </>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}

function PermissionRow({
  label,
  description,
  granted,
  pane,
}: {
  label: string;
  description: string;
  granted: boolean;
  pane: 'accessibility' | 'screen-recording';
}) {
  return (
    <SettingsRow variant="card" label={label} description={description}>
      {granted ? (
        <span data-computer-use-permission="granted" className="text-[12px] text-[var(--text-muted)]">
          Allowed
        </span>
      ) : (
        <button
          type="button"
          className="settings-button"
          data-computer-use-permission="missing"
          onClick={() => void window.electron.openComputerUsePermissionSettings(pane)}
        >
          Open System Settings
        </button>
      )}
    </SettingsRow>
  );
}

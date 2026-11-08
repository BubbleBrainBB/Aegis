import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  IosSimulatorDevice,
  IosSimulatorInput,
  IosSimulatorOrientation,
  IosSimulatorSetupStep,
  IosSimulatorView,
} from '../../shared/ios-simulator';
import {
  loadIosSimulatorStatus,
  subscribeIosSimulatorState,
  useIosSimulatorStore,
} from '../store/useIosSimulatorStore';
import {
  Camera,
  Check,
  ChevronDown,
  Home,
  Loader2,
  Lock,
  MoreHorizontal,
  PlugOff,
  Power,
  RotateClockwise,
  Smartphone,
  ZoomFit,
  ZoomIn,
  ZoomOut,
} from './icons';
import {
  h264CodecString,
  edgeNear,
  IOS_EDGE_REACH,
  orientationDegrees,
  shownToPhysical,
  type IosScreenEdge,
  type IosCornerRadii,
  type IosDeviceButton,
  type IosDeviceChrome,
} from '../../shared/ios-simulator';
import { IconButton } from './ui/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const SETUP_STEPS: Record<IosSimulatorSetupStep, { title: string; detail: string; command?: string }> = {
  macos: { title: 'A Mac', detail: "Apple's iOS Simulator runs only on macOS." },
  xcode: {
    title: 'Xcode',
    detail: 'Install Xcode from the App Store, open it once, then select it.',
    command: 'sudo xcode-select -s /Applications/Xcode.app',
  },
  runtime: {
    title: 'An iOS simulator runtime',
    detail: 'Download the iOS platform in Xcode › Settings › Components, or run:',
    command: 'xcodebuild -downloadPlatform iOS',
  },
  helper: {
    title: 'The simulator helper',
    detail: 'This development build has not built aegis-sim-helper yet. From the Aegis checkout, run:',
    command: 'npm run build:ios-sim-helper',
  },
};

const TYPE_FLUSH_MS = 120;
/** A quarter turn clockwise, as Simulator.app's ⌘→. */
const CLOCKWISE: Record<IosSimulatorOrientation, IosSimulatorOrientation> = {
  portrait: 'landscape-right',
  'landscape-right': 'portrait-upside-down',
  'portrait-upside-down': 'landscape-left',
  'landscape-left': 'portrait',
};

interface Ripple {
  id: number;
  x: number;
  y: number;
}

/** Corner radius of the device screen as a share of its width. */
function screenCornerRatio(device: IosSimulatorDevice | undefined): number {
  if (!device) return 0.12;
  if (device.family === 'iPad') return 0.035;
  return /\bSE\b/.test(device.name) ? 0 : 0.13;
}

export function IosSimulatorPanel({
  sessionId,
  udid,
  hidden,
  onSelectDevice,
}: {
  sessionId: string | null;
  /** Null: the pane has no device yet and offers one. */
  udid: string | null;
  hidden: boolean;
  /** Swap this pane to another device. */
  onSelectDevice: (udid: string) => void;
}) {
  const status = useIosSimulatorStore((state) => state.status);
  const view = useIosSimulatorStore((state) => (udid ? state.views[udid] : undefined));
  const [devices, setDevices] = useState<IosSimulatorDevice[] | null>(null);
  const [busy, setBusy] = useState<'boot' | 'shutdown' | 'attach' | null>(null);
  /** CSS pixels per point; null fits the device to the pane. */
  const [zoom, setZoom] = useState<number | null>(null);
  const fitScaleRef = useRef(1);
  const owner = sessionId ?? 'standalone';

  useEffect(() => {
    subscribeIosSimulatorState();
    if (!useIosSimulatorStore.getState().status) void loadIosSimulatorStatus().catch(() => {});
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await window.electron.iosSimulator.devices());
    } catch (error) {
      setDevices([]);
      toast.error(`Could not list simulators: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  useEffect(() => {
    if (!hidden && status?.ready) void refreshDevices();
  }, [hidden, status?.ready, refreshDevices]);

  // Stream while the pane is visible; a hidden pane releases the device.
  // Reconnecting (after the device restarted outside Aegis) attaches again.
  const [connection, setConnection] = useState(0);
  const [attached, setAttached] = useState(false);
  useEffect(() => {
    if (!udid || hidden || !status?.ready) return;
    let cancelled = false;
    setAttached(false);
    void window.electron.iosSimulator
      .attach({ udid, sessionId: owner })
      .then((next) => {
        if (cancelled) return;
        useIosSimulatorStore.getState().setView(next);
        setAttached(true);
      })
      .catch((error) => toast.error(`Could not show the simulator: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
      void window.electron.iosSimulator.detach({ udid, sessionId: owner }).catch(() => {});
    };
  }, [udid, hidden, owner, status?.ready, connection]);

  const boot = useCallback(
    async (target: string) => {
      setBusy('boot');
      try {
        const next = await window.electron.iosSimulator.boot({ udid: target, sessionId: owner });
        useIosSimulatorStore.getState().setView(next);
        void refreshDevices();
      } catch (error) {
        toast.error(`Could not boot the simulator: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [owner, refreshDevices]
  );

  const shutdown = useCallback(async () => {
    if (!udid) return;
    setBusy('shutdown');
    try {
      await window.electron.iosSimulator.shutdown(udid);
      void refreshDevices();
    } catch (error) {
      toast.error(`Could not shut down the simulator: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [udid, refreshDevices]);

  /** Picking a device: a shut-down one boots, then the pane shows it. */
  const pick = useCallback(
    async (device: IosSimulatorDevice) => {
      if (device.state !== 'Booted') await boot(device.udid);
      onSelectDevice(device.udid);
    },
    [boot, onSelectDevice]
  );

  if (hidden) return null;

  if (!status) {
    return (
      <PanelShell>
        <Centered>
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </Centered>
      </PanelShell>
    );
  }

  if (!status.ready) return <SetupSteps missing={status.missing} />;

  const device = view?.device ?? devices?.find((candidate) => candidate.udid === udid);

  return (
    <PanelShell>
      <div className="flex h-12 shrink-0 items-center gap-0.5 px-2">
        <DeviceMenu devices={devices} current={device} onOpen={refreshDevices} onPick={(next) => void pick(next)} />
        <div className="flex-1" />
        {udid && device?.state === 'Booted' ? (
          <>
            <IconButton size="sm" label="Zoom out" onClick={() => setZoom(zoomStep(zoom ?? fitScaleRef.current, -1))}>
              <ZoomOut className="h-4 w-4" />
            </IconButton>
            <IconButton
              size="sm"
              label="Fit to pane"
              aria-pressed={zoom === null}
              className={zoom === null ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : undefined}
              onClick={() => setZoom(null)}
            >
              <ZoomFit className="h-4 w-4" />
            </IconButton>
            <IconButton size="sm" label="Zoom in" onClick={() => setZoom(zoomStep(zoom ?? fitScaleRef.current, 1))}>
              <ZoomIn className="h-4 w-4" />
            </IconButton>
            <DeviceActions busy={busy} onDetach={() => onSelectDevice('pick')} onShutdown={() => void shutdown()} />
          </>
        ) : null}
      </div>
      {!udid ? (
        <AttachPrompt devices={devices} busy={busy !== null} onAttach={(next) => void pick(next)} />
      ) : !device ? (
        <Centered>
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </Centered>
      ) : device.state !== 'Booted' ? (
        <Centered>
          <p className="text-[13px] text-[var(--text-secondary)]">{device.name} is shut down.</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void boot(device.udid)}
            className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {busy === 'boot' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
            {busy === 'boot' ? 'Booting…' : 'Boot'}
          </button>
        </Centered>
      ) : attached && view?.device.udid === udid && view.streaming === false ? (
        <Centered>
          <p className="text-[13px] text-[var(--text-secondary)]">{device.name} restarted outside Aegis.</p>
          <button
            type="button"
            onClick={() => setConnection((value) => value + 1)}
            className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <RotateClockwise className="h-3.5 w-3.5" />
            Reconnect
          </button>
        </Centered>
      ) : (
        <DeviceScreen
          udid={udid}
          device={device}
          view={view}
          zoom={zoom}
          onFitScale={(scale) => {
            fitScaleRef.current = scale;
          }}
        />
      )}
    </PanelShell>
  );
}

/** Zoom presets in CSS pixels per point; 1 is the device's own size. */
const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2];

function zoomStep(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? ZOOM_STEPS[0];
}

/** Detach and shut down, out of the way of the controls used all the time. */
function DeviceActions({
  busy,
  onDetach,
  onShutdown,
}: {
  busy: string | null;
  onDetach: () => void;
  onShutdown: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More"
            className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] data-[popup-open]:bg-[var(--bg-tertiary)]"
          />
        }
      >
        {busy === 'shutdown' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-[200px]">
        <DropdownMenuItem onSelect={onDetach} className="gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]">
          <PlugOff className="h-4 w-4 text-[var(--text-secondary)]" />
          Detach simulator
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShutdown} disabled={busy !== null} className="gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]">
          <Power className="h-4 w-4 text-[var(--text-secondary)]" />
          Shut down
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function rotate(udid: string, current: IosSimulatorOrientation | undefined): void {
  void sendInput(udid, { kind: 'rotate', orientation: CLOCKWISE[current ?? 'portrait'] });
}

function sendInput(udid: string, input: IosSimulatorInput): Promise<void> {
  return window.electron.iosSimulator.input(udid, input).catch((error) => {
    toast.error(error instanceof Error ? error.message : String(error));
  });
}

async function saveScreenshot(udid: string): Promise<void> {
  try {
    const path = await window.electron.iosSimulator.screenshot(udid);
    toast.success('Screenshot saved to the Desktop', { description: path.split('/').pop() });
  } catch (error) {
    toast.error(`Could not save the screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">{children}</div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">{children}</div>;
}

function DeviceMenu({
  devices,
  current,
  onOpen,
  onPick,
}: {
  devices: IosSimulatorDevice[] | null;
  current: IosSimulatorDevice | undefined;
  onOpen: () => void;
  onPick: (device: IosSimulatorDevice) => void;
}) {
  const groups = useMemo(() => {
    const byRuntime = new Map<string, IosSimulatorDevice[]>();
    for (const device of devices ?? []) {
      const list = byRuntime.get(device.runtime) ?? [];
      list.push(device);
      byRuntime.set(device.runtime, list);
    }
    return [...byRuntime.entries()];
  }, [devices]);
  return (
    <DropdownMenu onOpenChange={(open: boolean) => (open ? onOpen() : undefined)}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Choose a simulator"
            className="no-drag inline-flex h-10 min-w-0 max-w-[260px] items-center rounded-md px-2 text-left transition-colors hover:bg-[var(--sidebar-item-hover)] data-[popup-open]:bg-[var(--sidebar-item-hover)]"
          />
        }
      >
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="flex min-w-0 max-w-full items-center gap-1 text-[13px] font-medium text-[var(--text-primary)]">
            <span className="min-w-0 truncate">{current ? current.name : 'Choose a simulator'}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          </span>
          {current ? <span className="text-[11px] font-normal text-[var(--text-muted)]">{current.runtime}</span> : null}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="max-h-[420px] w-[280px] overflow-y-auto">
        {devices === null ? (
          <div className="px-2.5 py-2 text-[12px] text-[var(--text-muted)]">Loading…</div>
        ) : devices.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-[var(--text-muted)]">No simulators installed</div>
        ) : (
          groups.map(([runtime, list], index) => (
            // A group label must sit inside its group (Base UI error #31).
            <DropdownMenuGroup key={runtime}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">{runtime}</DropdownMenuLabel>
              {list.map((device) => (
                <DropdownMenuItem
                  key={device.udid}
                  onSelect={() => onPick(device)}
                  className="gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]"
                >
                  <span className="min-w-0 flex-1 truncate">{device.name}</span>
                  {device.state === 'Booted' ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Booted</span> : null}
                  {device.udid === current?.udid ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachPrompt({
  devices,
  busy,
  onAttach,
}: {
  devices: IosSimulatorDevice[] | null;
  busy: boolean;
  onAttach: (device: IosSimulatorDevice) => void;
}) {
  // A booted device first, else the newest iPhone.
  const suggested = devices?.find((device) => device.state === 'Booted') ?? devices?.find((device) => device.family === 'iPhone') ?? devices?.[0];
  return (
    <Centered>
      <Smartphone className="h-6 w-6 text-[var(--text-muted)]" />
      <p className="mt-3 text-[13px] text-[var(--text-primary)]">No simulator attached</p>
      <p className="mt-1 max-w-[280px] text-[12px] text-[var(--text-muted)]">
        Agents open one here when they run your app. You can also attach one yourself.
      </p>
      <button
        type="button"
        disabled={!suggested || busy}
        onClick={() => suggested && onAttach(suggested)}
        className="mt-4 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {suggested ? `Attach ${suggested.name}` : devices === null ? 'Loading…' : 'No simulators installed'}
      </button>
    </Centered>
  );
}

function SetupSteps({ missing }: { missing: IosSimulatorSetupStep[] }) {
  const [checking, setChecking] = useState(false);
  const order: IosSimulatorSetupStep[] = ['macos', 'xcode', 'runtime', 'helper'];
  return (
    <PanelShell>
      <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center px-6">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">Set up the iOS Simulator</p>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">The simulator pane needs these on this Mac.</p>
        <ol className="mt-4 space-y-3">
          {order.map((step) => {
            const done = !missing.includes(step);
            const info = SETUP_STEPS[step];
            return (
              <li key={step} className="flex gap-2.5">
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    done ? 'border-transparent bg-[var(--text-primary)] text-[var(--bg-primary)]' : 'border-[var(--border)]'
                  }`}
                >
                  {done ? <Check className="h-3 w-3" /> : null}
                </span>
                <div className="min-w-0">
                  <p className={`text-[12px] ${done ? 'text-[var(--text-muted)]' : 'font-medium text-[var(--text-primary)]'}`}>{info.title}</p>
                  {!done ? (
                    <>
                      <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{info.detail}</p>
                      {info.command ? (
                        <code className="mt-1.5 block select-text break-all rounded-md bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)]">
                          {info.command}
                        </code>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void loadIosSimulatorStatus(true).finally(() => setChecking(false));
          }}
          className="mt-5 inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Check again
        </button>
      </div>
    </PanelShell>
  );
}

/** The live screen: H.264 from the helper decoded onto a canvas inside a
 * drawn device, and the pointer, trackpad and keys sent back as a finger
 * and a keyboard. */
function DeviceScreen({
  udid,
  device,
  view,
  zoom,
  onFitScale,
}: {
  udid: string;
  device: IosSimulatorDevice;
  view: IosSimulatorView | undefined;
  zoom: number | null;
  onFitScale: (scale: number) => void;
}) {
  // The canvas and the screen mount once the pane is measured: the decoder
  // and the scroll listener follow the elements themselves.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  screenRef.current = screen;
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const pointerRef = useRef<number | null>(null);
  const typedRef = useRef('');
  const typeTimerRef = useRef<number | null>(null);
  const orientation = view?.orientation ?? 'portrait';
  const degrees = orientationDegrees(orientation);
  const sideways = Math.abs(degrees) === 90;
  const pointWidth = view?.pointSize?.width;
  const pointHeight = view?.pointSize?.height;
  // The screen's shape (physical portrait): frames of another shape belong
  // to a screen the pane has not switched to yet (a foldable mid-fold).
  const aspectRef = useRef<number | null>(null);
  aspectRef.current = pointWidth && pointHeight ? pointWidth / pointHeight : null;

  // The device's real outline, from the Xcode on this Mac.
  const [chrome, setChrome] = useState<IosDeviceChrome | null>(null);
  useEffect(() => {
    if (!pointWidth) return;
    let cancelled = false;
    void window.electron.iosSimulator
      .chrome(udid)
      .then((next) => {
        if (!cancelled) setChrome(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [udid, pointWidth]);

  // The screen changed (a foldable folded or opened): draw it again now
  // that the pane has its shape, as frames of it may have been skipped.
  useEffect(() => {
    if (pointWidth && pointHeight) window.electron.iosSimulator.requestKeyFrame(udid);
  }, [udid, pointWidth, pointHeight]);

  // Decode: configure on the first keyframe (the codec string comes from its
  // SPS), drop frames until then, and start over on a decoder error.
  useEffect(() => {
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context || typeof VideoDecoder === 'undefined') {
      setFailed('This window cannot decode video.');
      return;
    }
    let decoder: VideoDecoder | null = null;
    let configuredFor = '';
    let timestamp = 0;
    const reset = () => {
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = null;
      configuredFor = '';
      window.electron.iosSimulator.requestKeyFrame(udid);
    };
    const dispose = window.electron.iosSimulator.onFrame((event) => {
      if (event.udid !== udid) return;
      if (event.keyFrame) {
        const codec = h264CodecString(event.data);
        const key = `${codec}:${event.width}x${event.height}`;
        if (codec && key !== configuredFor) {
          if (decoder && decoder.state !== 'closed') decoder.close();
          decoder = new VideoDecoder({
            output: (frame) => {
              const aspect = aspectRef.current;
              if (aspect && Math.abs(frame.displayWidth / frame.displayHeight - aspect) > 0.03) {
                frame.close();
                return;
              }
              if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                setFrameSize({ width: frame.displayWidth, height: frame.displayHeight });
              }
              context.drawImage(frame, 0, 0);
              frame.close();
            },
            error: (error) => {
              console.warn('[ios-simulator] decoder error', error);
              reset();
            },
          });
          // No description: chunks are Annex B. Prefer the hardware decoder.
          decoder.configure({ codec, codedWidth: event.width, codedHeight: event.height, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
          configuredFor = key;
        }
      }
      if (!decoder || decoder.state !== 'configured') return;
      // A backlog means frames are late: skip ahead to the next keyframe.
      if (!event.keyFrame && decoder.decodeQueueSize > 4) {
        reset();
        return;
      }
      timestamp += 16_667;
      decoder.decode(new EncodedVideoChunk({ type: event.keyFrame ? 'key' : 'delta', timestamp, data: event.data }));
    });
    window.electron.iosSimulator.requestKeyFrame(udid);
    return () => {
      dispose();
      if (decoder && decoder.state !== 'closed') decoder.close();
    };
  }, [udid, canvas]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => setAreaSize({ width: area.clientWidth, height: area.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  /** Where a point is on the screen as shown: the turned screen's bounding
   * box is exactly the upright screen. */
  const shownAt = (clientX: number, clientY: number) => {
    const rect = screenRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  /** Touches go to the physical (portrait) screen, whatever is shown. */
  const lastTouchRef = useRef({ x: 0.5, y: 0.5 });
  const touchAt = (phase: 'down' | 'move' | 'up', shown: { x: number; y: number }, edge?: IosScreenEdge) => {
    const physical = shownToPhysical(orientation, shown.x, shown.y);
    lastTouchRef.current = physical;
    window.electron.iosSimulator.touch({ udid, phase, ...physical, ...(edge ? { edge } : {}) });
    return physical;
  };

  // A pane that goes away mid-press (tab closed, device switched) lifts its
  // finger: a finger left down turns every later touch into a drag.
  useEffect(() => {
    return () => {
      if (pointerRef.current === null) return;
      pointerRef.current = null;
      window.electron.iosSimulator.touch({ udid, phase: 'up', ...lastTouchRef.current });
    };
  }, [udid]);

  /** The edge a press starts on: near one, inside the screen or on the
   * bezel around it, as Simulator does. */
  const edgeAt = (clientX: number, clientY: number): IosScreenEdge | undefined => {
    const rect = screenRef.current!.getBoundingClientRect();
    return edgeNear(orientation, clientX - rect.left, clientY - rect.top, rect.width, rect.height, IOS_EDGE_REACH * scale);
  };

  const addRipple = (physical: { x: number; y: number }) => {
    const ripple = { id: Date.now() + Math.random(), ...physical };
    setRipples((list) => [...list, ripple]);
    window.setTimeout(() => setRipples((list) => list.filter((item) => item.id !== ripple.id)), 600);
  };

  // Two-finger scrolling on a trackpad (or a mouse wheel) is a finger
  // dragging the content: it lands where the pointer is, follows the scroll
  // deltas, and lifts when the scrolling stops. Native listener: React's
  // wheel handler is passive and cannot keep the pane from scrolling.
  const orientationRef = useRef(orientation);
  orientationRef.current = orientation;
  useEffect(() => {
    if (!screen) return;
    let finger: { x: number; y: number } | null = null;
    let lift: number | null = null;
    const send = (phase: 'down' | 'move' | 'up', shown: { x: number; y: number }) => {
      window.electron.iosSimulator.touch({ udid, phase, ...shownToPhysical(orientationRef.current, shown.x, shown.y) });
    };
    const onWheel = (event: WheelEvent) => {
      // Pinch on a trackpad arrives as ctrl+wheel: leave it to the pane.
      if (event.ctrlKey || pointerRef.current !== null) return;
      event.preventDefault();
      const rect = screen.getBoundingClientRect();
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      if (!finger) {
        finger = shownAt(event.clientX, event.clientY);
        send('down', finger);
      }
      finger = {
        x: Math.min(0.999, Math.max(0.001, finger.x - (event.deltaX * lines) / rect.width)),
        y: Math.min(0.999, Math.max(0.001, finger.y - (event.deltaY * lines) / rect.height)),
      };
      send('move', finger);
      if (lift !== null) window.clearTimeout(lift);
      lift = window.setTimeout(() => {
        if (finger) send('up', finger);
        finger = null;
        lift = null;
      }, 90);
    };
    screen.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      screen.removeEventListener('wheel', onWheel);
      if (lift !== null) window.clearTimeout(lift);
      if (finger) send('up', finger);
    };
    // shownAt reads the ref'd element only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [udid, screen]);

  const flushTyping = useCallback(() => {
    if (typeTimerRef.current !== null) window.clearTimeout(typeTimerRef.current);
    typeTimerRef.current = null;
    const text = typedRef.current;
    typedRef.current = '';
    if (text) void sendInput(udid, { kind: 'type', text });
  }, [udid]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    if (event.metaKey && event.shiftKey && key === 'h') {
      event.preventDefault();
      void sendInput(udid, { kind: 'button', button: 'home' });
      return;
    }
    if (event.metaKey && key === 'l') {
      event.preventDefault();
      void sendInput(udid, { kind: 'button', button: 'lock' });
      return;
    }
    if (event.metaKey && key === 's') {
      event.preventDefault();
      void saveScreenshot(udid);
      return;
    }
    if (event.metaKey && event.key === 'ArrowRight') {
      event.preventDefault();
      rotate(udid, orientation);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const special = ({ Enter: 'return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape' } as const)[event.key as 'Enter'];
    if (special) {
      event.preventDefault();
      flushTyping();
      void sendInput(udid, { kind: 'key', key: special });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      typedRef.current += event.key;
      if (typeTimerRef.current !== null) window.clearTimeout(typeTimerRef.current);
      typeTimerRef.current = window.setTimeout(flushTyping, TYPE_FLUSH_MS);
    }
  };

  // Geometry in points, portrait: the body, the screen in it and the
  // buttons around it (Xcode's own outline, else an estimate), then the
  // device as shown (turned with the device). Fit scales the shown device
  // into the pane, leaving room for the toolbar below it.
  const points = view?.pointSize ?? (frameSize ? { width: 402, height: (402 * frameSize.height) / frameSize.width } : null);
  // The real outline once it is the one for this screen; until then (a
  // foldable just switched screens) an estimate of the right size.
  const fitting = chrome && points && Math.abs(chrome.screen.width - points.width) < 1 && Math.abs(chrome.screen.height - points.height) < 1 ? chrome : null;
  const outline = useMemo(() => (points ? fitting ?? estimatedChrome(device, points) : null), [fitting, device, points?.width, points?.height]);
  const layout = useMemo(() => {
    if (!outline || areaSize.width <= 0 || areaSize.height <= 0) return null;
    // Room around the body for buttons standing out of it.
    const margin = Math.max(0, ...outline.buttons.map((button) => button.protrudeHover)) + 1;
    const canvasWidth = outline.body.width + margin * 2;
    const canvasHeight = outline.body.height + margin * 2;
    const shownWidth = sideways ? canvasHeight : canvasWidth;
    const shownHeight = sideways ? canvasWidth : canvasHeight;
    const fit = Math.max(0.1, Math.min((areaSize.width - 24) / shownWidth, (areaSize.height - 88) / shownHeight));
    return { margin, canvasWidth, canvasHeight, shownWidth, shownHeight, fit };
  }, [outline, areaSize.width, areaSize.height, sideways]);

  useEffect(() => {
    if (layout) onFitScale(layout.fit);
  }, [layout, onFitScale]);

  const scale = layout ? zoom ?? layout.fit : 1;
  const px = (value: number) => Math.round(value * scale * 10) / 10;
  const press = (button: IosDeviceButton) => {
    if (button.hid) void sendInput(udid, { kind: 'hardware', page: button.hid.page, usage: button.hid.usage });
  };

  const touchHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = event.pointerId;
      flushTyping();
      addRipple(touchAt('down', shownAt(event.clientX, event.clientY), edgeAt(event.clientX, event.clientY)));
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      touchAt('move', shownAt(event.clientX, event.clientY));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      pointerRef.current = null;
      touchAt('up', shownAt(event.clientX, event.clientY));
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      pointerRef.current = null;
      touchAt('up', shownAt(event.clientX, event.clientY));
    },
    // Capture lost without an up (the element went away, the window lost
    // the pointer): lift where the finger last was.
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      pointerRef.current = null;
      window.electron.iosSimulator.touch({ udid, phase: 'up', ...lastTouchRef.current });
    },
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label={`${device.name} screen`}>
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-auto">
        {layout && outline ? (
          <div
            className="flex items-center justify-center"
            style={{ minWidth: '100%', minHeight: '100%', width: px(layout.shownWidth) + 24, height: px(layout.shownHeight) + 88, paddingBottom: 60 }}
          >
            <div className="relative shrink-0" style={{ width: px(layout.shownWidth), height: px(layout.shownHeight) }}>
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: px(layout.canvasWidth),
                  height: px(layout.canvasHeight),
                  transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
                }}
              >
                <div className="absolute" style={{ left: px(layout.margin), top: px(layout.margin), width: px(outline.body.width), height: px(outline.body.height) }}>
                  {/* The bezel just around the screen, inside the body under the side
                      buttons, which reach into it: a drag can start there, onto the
                      edge, like the swipe up from the home indicator. */}
                  <div
                    data-sim-edge-reach
                    className="absolute cursor-default touch-none select-none"
                    style={{
                      left: px(Math.max(0, outline.screen.x - IOS_EDGE_REACH)),
                      top: px(Math.max(0, outline.screen.y - IOS_EDGE_REACH)),
                      right: px(Math.max(0, outline.body.width - outline.screen.x - outline.screen.width - IOS_EDGE_REACH)),
                      bottom: px(Math.max(0, outline.body.height - outline.screen.y - outline.screen.height - IOS_EDGE_REACH)),
                    }}
                    {...touchHandlers}
                  />
                  {outline.buttons
                    .filter((button) => button.side !== 'face')
                    .map((button) => (
                      <EdgeButton key={button.name} button={button} scale={scale} onPress={press} />
                    ))}
                  <DeviceBody outline={outline} scale={scale} />
                  <div
                    ref={setScreen}
                    data-orientation={orientation}
                    className="absolute cursor-default touch-none select-none overflow-hidden bg-black"
                    style={{
                      left: px(outline.screen.x),
                      top: px(outline.screen.y),
                      width: px(outline.screen.width),
                      height: px(outline.screen.height),
                      // The screen's exact shape: Xcode's framebuffer mask.
                      ...(outline.maskUrl
                        ? { WebkitMaskImage: `url(${outline.maskUrl})`, WebkitMaskSize: '100% 100%', maskImage: `url(${outline.maskUrl})`, maskSize: '100% 100%' }
                        : { borderRadius: fitting ? 0 : px(outline.screen.width * screenCornerRatio(device)) }),
                    }}
                    {...touchHandlers}
                  >
                    <canvas ref={setCanvas} className={`block h-full w-full ${frameSize ? '' : 'invisible'}`} />
                    {ripples.map((ripple) => (
                      <span
                        key={ripple.id}
                        className="aegis-sim-ripple pointer-events-none absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
                        style={{ left: `${ripple.x * 100}%`, top: `${ripple.y * 100}%` }}
                      />
                    ))}
                    {!frameSize && !failed ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-4 w-4 animate-spin text-white/60" />
                      </div>
                    ) : null}
                  </div>
                  {outline.buttons
                    .filter((button) => button.side === 'face' && button.rect)
                    .map((button) => (
                      <FaceButton key={button.name} button={button} scale={scale} onPress={press} />
                    ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            {failed ? <p className="text-[12px] text-[var(--text-muted)]">{failed}</p> : <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
          </div>
        )}
      </div>
      {view?.agentBusy ? (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
          Agent is using this device
        </div>
      ) : null}
      <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] p-1 shadow-[0_4px_16px_-6px_rgba(0,0,0,0.18)]">
        <IconButton size="sm" className="rounded-full" label="Home" tooltip="Home (⇧⌘H)" onClick={() => void sendInput(udid, { kind: 'button', button: 'home' })}>
          <Home className="h-4 w-4" />
        </IconButton>
        <IconButton size="sm" className="rounded-full" label="Rotate" tooltip="Rotate (⌘→)" onClick={() => rotate(udid, orientation)}>
          <RotateClockwise className="h-4 w-4" />
        </IconButton>
        <IconButton size="sm" className="rounded-full" label="Screenshot" tooltip="Screenshot to the Desktop (⌘S)" onClick={() => void saveScreenshot(udid)}>
          <Camera className="h-4 w-4" />
        </IconButton>
        <IconButton size="sm" className="rounded-full" label="Lock" tooltip="Lock (⌘L)" onClick={() => void sendInput(udid, { kind: 'button', button: 'lock' })}>
          <Lock className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}

/** An outline when Xcode has none for the device: bezel, corners and
 * iPhone side buttons as shares of the screen width. */
function estimatedChrome(device: IosSimulatorDevice, screen: { width: number; height: number }): IosDeviceChrome {
  const ipad = device.family === 'iPad';
  const bezel = screen.width * (ipad ? 0.03 : 0.042);
  const body = { width: screen.width + bezel * 2, height: screen.height + bezel * 2 };
  const radius = screen.width * screenCornerRatio(device) + bezel;
  const side = (name: string, title: string, at: 'left' | 'right', top: number, length: number, hid: IosDeviceButton['hid']): IosDeviceButton => ({
    name,
    title,
    side: at,
    offset: body.height * top,
    length: body.height * length,
    protrude: 2.5,
    protrudeHover: 6,
    hid,
  });
  return {
    body: { ...body, radius },
    screen: { x: bezel, y: bezel, ...screen },
    maskUrl: null,
    buttons: ipad
      ? []
      : [
          side('action', 'Action', 'left', 0.176, 0.037, { page: 11, usage: 45 }),
          side('volume-up', 'Volume Up', 'left', 0.243, 0.07, { page: 12, usage: 233 }),
          side('volume-down', 'Volume Down', 'left', 0.33, 0.07, { page: 12, usage: 234 }),
          side('power', 'Side Button', 'right', 0.289, 0.111, { page: 12, usage: 48 }),
        ],
  };
}

/** Graphite titanium: the metal of the rim and the buttons. */
function MetalGradient({ id, vertical = false }: { id: string; vertical?: boolean }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '1'}>
      <stop offset="0" stopColor="#8e8e93" />
      <stop offset="0.22" stopColor="#4a4a4f" />
      <stop offset="0.5" stopColor="#77777c" />
      <stop offset="0.78" stopColor="#3a3a3e" />
      <stop offset="1" stopColor="#6e6e73" />
    </linearGradient>
  );
}

/** A rounded rectangle with its own radius at each corner, as an SVG path. */
function roundedRectPath(x: number, y: number, width: number, height: number, radii: IosCornerRadii): string {
  const limit = Math.min(width, height) / 2;
  const tl = Math.max(0, Math.min(radii.topLeft, limit));
  const tr = Math.max(0, Math.min(radii.topRight, limit));
  const br = Math.max(0, Math.min(radii.bottomRight, limit));
  const bl = Math.max(0, Math.min(radii.bottomLeft, limit));
  return [
    `M ${x + tl} ${y}`,
    `H ${x + width - tr}`,
    `A ${tr} ${tr} 0 0 1 ${x + width} ${y + tr}`,
    `V ${y + height - br}`,
    `A ${br} ${br} 0 0 1 ${x + width - br} ${y + height}`,
    `H ${x + bl}`,
    `A ${bl} ${bl} 0 0 1 ${x} ${y + height - bl}`,
    `V ${y + tl}`,
    `A ${tl} ${tl} 0 0 1 ${x + tl} ${y}`,
    'Z',
  ].join(' ');
}

/** Corner radii shrunk (or grown) by an inset, for shapes nested in the body. */
function insetRadii(radii: IosCornerRadii, by: number): IosCornerRadii {
  return {
    topLeft: radii.topLeft - by,
    topRight: radii.topRight - by,
    bottomRight: radii.bottomRight - by,
    bottomLeft: radii.bottomLeft - by,
  };
}

/** The body: a metal rim with a highlight, and the black glass in it. Its
 * corners follow the screen's (each on its own: a foldable's hinge side is
 * square), so the bezel is as thick at the corners as along the sides. */
function DeviceBody({ outline, scale }: { outline: IosDeviceChrome; scale: number }) {
  const id = `sim-${useId().replace(/[^\w-]/g, '')}`;
  const { width, height, radius } = outline.body;
  const radii = outline.body.radii ?? { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius };
  // The rim is a few points of metal; the rest of the bezel is glass.
  const rim = Math.max(2, Math.min(4, Math.min(outline.screen.x, outline.screen.y) * 0.24));
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      style={{ filter: 'drop-shadow(0 10px 22px rgba(0, 0, 0, 0.28))' }}
    >
      <defs>
        <MetalGradient id={`${id}-rim`} />
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="0.5" stopColor="rgba(255,255,255,0.08)" />
          <stop offset="1" stopColor="rgba(255,255,255,0.35)" />
        </linearGradient>
      </defs>
      <path d={roundedRectPath(0, 0, width, height, radii)} fill={`url(#${id}-rim)`} />
      <path d={roundedRectPath(0.6, 0.6, width - 1.2, height - 1.2, insetRadii(radii, 0.6))} fill="none" stroke={`url(#${id}-sheen)`} strokeWidth={0.9} />
      <path d={roundedRectPath(rim, rim, width - rim * 2, height - rim * 2, insetRadii(radii, rim))} fill="#0a0a0b" />
      <path
        d={roundedRectPath(rim + 0.5, rim + 0.5, width - rim * 2 - 1, height - rim * 2 - 1, insetRadii(radii, rim + 0.5))}
        fill="none"
        stroke="rgba(255,255,255,0.07)"
        strokeWidth={1}
      />
    </svg>
  );
}

/** A button on the body's edge, behind it; it slides out under the pointer
 * like Simulator.app's, and presses through when the simulator supports it. */
function EdgeButton({ button, scale, onPress }: { button: IosDeviceButton; scale: number; onPress: (button: IosDeviceButton) => void }) {
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const id = `sim-${useId().replace(/[^\w-]/g, '')}`;
  const vertical = button.side === 'left' || button.side === 'right';
  const out = (hover && button.hid ? button.protrudeHover : button.protrude) - (down ? 1 : 0);
  // Tucked a few points under the body so it reads as one piece.
  const depth = out + 4;
  const position: React.CSSProperties = vertical
    ? { top: button.offset * scale, height: button.length * scale, width: depth * scale, [button.side]: -out * scale }
    : { left: button.offset * scale, width: button.length * scale, height: depth * scale, [button.side]: -out * scale };
  return (
    <div
      role={button.hid ? 'button' : undefined}
      aria-label={button.title}
      title={button.hid ? button.title : `${button.title} (not available in the simulator pane)`}
      className={`absolute transition-[left,right,top,bottom] duration-150 ease-out ${button.hid ? 'cursor-pointer' : 'cursor-default'}`}
      style={position}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setDown(false);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !button.hid) return;
        event.stopPropagation();
        setDown(true);
      }}
      onPointerUp={() => {
        if (!down) return;
        setDown(false);
        onPress(button);
      }}
    >
      <svg className="block h-full w-full" preserveAspectRatio="none" viewBox="0 0 10 10">
        <defs>
          <MetalGradient id={id} vertical={!vertical} />
        </defs>
        <rect x={0} y={0} width={10} height={10} rx={2.5} ry={2.5} fill={`url(#${id})`} />
      </svg>
    </div>
  );
}

/** A button on the front (the Home button of older iPhones and iPads). */
function FaceButton({ button, scale, onPress }: { button: IosDeviceButton; scale: number; onPress: (button: IosDeviceButton) => void }) {
  const rect = button.rect!;
  return (
    <button
      type="button"
      aria-label={button.title}
      title={button.title}
      className="absolute rounded-full border border-[#3a3a3e] bg-[#0d0d0f] transition-colors hover:border-[#5a5a5f] active:bg-[#1c1c1f]"
      style={{ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale }}
      onClick={() => onPress(button)}
    >
      <span
        className="absolute rounded-[22%] border border-[#3a3a3e]"
        style={{ inset: `${rect.width * scale * 0.34}px` }}
      />
    </button>
  );
}

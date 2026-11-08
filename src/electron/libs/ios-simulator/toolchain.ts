// What the simulator pane needs from the Mac: Xcode with an iOS runtime
// (`xcrun simctl`), which Aegis cannot ship, and aegis-sim-helper, which it
// does (development checkouts build it). The pane lists what is missing.

import { execFile, type ExecFileOptions } from 'child_process';
import { findHelper } from './helper';
import {
  compareVersions,
  type IosSimulatorDevice,
  type IosSimulatorSetupStep,
  type IosSimulatorStatus,
} from '../../../shared/ios-simulator';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(
  file: string,
  args: string[],
  options: ExecFileOptions & { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RunResult> {
  const { timeoutMs = 60_000, ...rest } = options;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8', ...rest },
      (error, stdout, stderr) => {
        if (error) {
          const detail = cleanStderr(String(stderr || '')) || error.message;
          reject(new Error(detail));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/** CoreSimulator logs a "Malformed bundle" line for every half-installed
 * runtime on every call; it is noise, not the error. */
export function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim() && !/Malformed bundle does not contain an identifier/.test(line))
    .join('\n')
    .trim();
}

let statusCache: { at: number; value: IosSimulatorStatus } | null = null;
const STATUS_TTL_MS = 15_000;

export async function getToolchainStatus(options: { fresh?: boolean } = {}): Promise<IosSimulatorStatus> {
  if (!options.fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const missing: IosSimulatorSetupStep[] = [];
  let xcodePath: string | null = null;
  let helperPath: string | null = null;
  if (process.platform !== 'darwin') {
    missing.push('macos');
  } else {
    xcodePath = await run('xcode-select', ['-p'], { timeoutMs: 10_000 })
      .then((result) => result.stdout.trim() || null)
      .catch(() => null);
    // The Command Line Tools alone have no simctl.
    const hasSimctl = xcodePath && !xcodePath.includes('CommandLineTools')
      ? await run('xcrun', ['simctl', 'help'], { timeoutMs: 15_000 }).then(() => true, () => false)
      : false;
    if (!hasSimctl) {
      missing.push('xcode');
    } else if (!(await hasIosRuntime())) {
      missing.push('runtime');
    }
    helperPath = findHelper();
    if (!helperPath) missing.push('helper');
  }
  const value: IosSimulatorStatus = { ready: missing.length === 0, missing, xcodePath, helperPath };
  statusCache = { at: Date.now(), value };
  return value;
}

/** The last check's verdict without waiting, for code that builds tool lists
 * synchronously; starts a fresh check when the last one is stale. */
export function isToolchainReadyCached(): boolean {
  if (!statusCache || Date.now() - statusCache.at >= STATUS_TTL_MS) void getToolchainStatus().catch(() => {});
  return statusCache?.value.ready ?? false;
}

async function hasIosRuntime(): Promise<boolean> {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'runtimes', '-j'], { timeoutMs: 20_000 });
    const parsed = JSON.parse(stdout) as { runtimes?: Array<{ platform?: string; name?: string; isAvailable?: boolean }> };
    return (parsed.runtimes ?? []).some(
      (runtime) => runtime.isAvailable && (runtime.platform === 'iOS' || runtime.name?.startsWith('iOS'))
    );
  } catch {
    return false;
  }
}

/** Parse `xcrun simctl list devices available -j` into iOS devices. */
export function parseSimctlDevices(json: string): IosSimulatorDevice[] {
  const parsed = JSON.parse(json) as {
    devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string }>>;
  };
  const devices: IosSimulatorDevice[] = [];
  for (const [runtimeId, list] of Object.entries(parsed.devices ?? {})) {
    const match = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtimeId);
    if (!match) continue; // watchOS, tvOS, visionOS
    const runtime = `iOS ${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`;
    for (const device of list) {
      if (device.isAvailable === false) continue;
      const type = device.deviceTypeIdentifier ?? '';
      const family = /iPhone/i.test(type) || /^iPhone/.test(device.name)
        ? 'iPhone'
        : /iPad/i.test(type) || /^iPad/.test(device.name)
          ? 'iPad'
          : 'other';
      devices.push({ udid: device.udid, name: device.name, runtime, state: device.state, family, deviceType: device.deviceTypeIdentifier });
    }
  }
  // Booted first, then newest runtime, then iPhones before iPads, then name.
  return devices.sort((a, b) => {
    if ((a.state === 'Booted') !== (b.state === 'Booted')) return a.state === 'Booted' ? -1 : 1;
    const runtime = compareVersions(b.runtime.slice(4), a.runtime.slice(4));
    if (runtime !== 0) return runtime;
    if (a.family !== b.family) return a.family === 'iPhone' ? -1 : b.family === 'iPhone' ? 1 : 0;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export async function listDevices(): Promise<IosSimulatorDevice[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 30_000 });
  return parseSimctlDevices(stdout);
}

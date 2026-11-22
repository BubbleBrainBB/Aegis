// Where the cua-driver binary is, and whether it is the version Aegis runs.
//
// Cua Driver (trycua/cua, MIT) is a single Rust binary. Upstream ships several
// releases a day and its tool schemas still move, so Aegis runs exactly one
// version: the one below. `npm run fetch:cua-driver` downloads and verifies
// it; bundling and signing it with the app comes in a later phase.

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import type { ComputerUseDriverStatus } from '../../../shared/computer-use';
import { baseCuaDriverEnv } from './driver-env';
import { getComputerUseSettings, isComputerUsePlatformSupported } from './settings';

/** The one cua-driver release Aegis runs. Change it together with scripts/fetch-cua-driver.mjs. */
export const CUA_DRIVER_VERSION = '0.57.0';

const BINARY_NAME = 'cua-driver';

/**
 * Places a binary is looked for, first hit wins: the environment variable,
 * the path set in Settings, the copy bundled with a packaged app, then the
 * copy `npm run fetch:cua-driver` leaves in the repo.
 */
export function cuaDriverCandidates(
  env: NodeJS.ProcessEnv = process.env,
  configuredPath = getComputerUseSettings().driverPath
): string[] {
  const candidates: string[] = [];
  const override = env.AEGIS_CUA_DRIVER_PATH?.trim();
  if (override) candidates.push(override);
  if (configuredPath) candidates.push(configuredPath);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'cua-driver', BINARY_NAME));
  // dist-electron/electron/libs/computer-use → the repo root.
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'native', 'cua-driver', 'dist', BINARY_NAME));
  return candidates;
}

const versionByFile = new Map<string, string | null>();

/**
 * What `<binary> --version` says, cached until the file changes. The probe
 * runs the binary too, so it gets the same built environment as the driver:
 * nothing of Aegis's own environment reaches it.
 */
export function readCuaDriverVersion(binaryPath: string, base: NodeJS.ProcessEnv = process.env): string | null {
  let key: string;
  try {
    const stat = statSync(binaryPath);
    key = `${binaryPath}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return null;
  }
  if (versionByFile.has(key)) return versionByFile.get(key) ?? null;
  let version: string | null = null;
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: baseCuaDriverEnv(base),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    version = /cua-driver\s+(\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? null;
  } catch {
    version = null;
  }
  versionByFile.set(key, version);
  return version;
}

export function resolveCuaDriver(options: {
  env?: NodeJS.ProcessEnv;
  configuredPath?: string;
  platform?: NodeJS.Platform;
  readVersion?: (binaryPath: string) => string | null;
} = {}): ComputerUseDriverStatus {
  const pinnedVersion = CUA_DRIVER_VERSION;
  if (!isComputerUsePlatformSupported(options.platform)) {
    return {
      state: 'unsupported-platform',
      path: null,
      version: null,
      pinnedVersion,
      message: 'Computer use is available on macOS only for now.',
    };
  }
  const binaryPath = cuaDriverCandidates(options.env, options.configuredPath).find((candidate) => existsSync(candidate));
  if (!binaryPath) {
    return {
      state: 'missing',
      path: null,
      version: null,
      pinnedVersion,
      message: `Computer use isn't available in this build: cua-driver ${pinnedVersion} was not found. Run "npm run fetch:cua-driver", or set its path here.`,
    };
  }
  const version = (options.readVersion ?? readCuaDriverVersion)(binaryPath);
  if (version !== pinnedVersion) {
    return {
      state: 'version-mismatch',
      path: binaryPath,
      version,
      pinnedVersion,
      message: version
        ? `Found cua-driver ${version}, but Aegis runs ${pinnedVersion} only.`
        : `The file at ${binaryPath} did not answer as cua-driver ${pinnedVersion}.`,
    };
  }
  return { state: 'ready', path: binaryPath, version, pinnedVersion, message: null };
}

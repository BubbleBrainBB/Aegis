// Where the cua-driver binary is, and whether it is the version Aegis runs.
//
// Cua Driver (trycua/cua, MIT) is a single Rust binary. Upstream ships several
// releases a day and its tool schemas still move, so Aegis runs exactly one
// version: the one below. `npm run fetch:cua-driver` downloads and verifies
// it. The macOS app ships that copy in its resources (electron-builder.json,
// release.yml), signed with the app; a source checkout runs the fetched copy.

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import {
  cuaDriverAssetName,
  cuaDriverReleaseUrl,
  type ComputerUseDriverSource,
  type ComputerUseDriverStatus,
} from '../../../shared/computer-use';
import { baseCuaDriverEnv } from './driver-env';
import { getComputerUseSettings, isComputerUsePlatformSupported } from './settings';

/** The one cua-driver release Aegis runs. Change it together with scripts/fetch-cua-driver.mjs. */
export const CUA_DRIVER_VERSION = '0.61.2';

const BINARY_NAME = 'cua-driver';
/** The folder in the app's resources that holds the driver: `to` of its extraResources entry in electron-builder.json. */
export const CUA_DRIVER_RESOURCES_FOLDER = 'cua-driver';

/** Where the app's resources are: set by Electron, absent under plain Node. */
function appResourcesPath(): string | null {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null;
}

export interface CuaDriverCandidate {
  path: string;
  source: ComputerUseDriverSource;
}

/**
 * Places a binary is looked for, in this order: the copy the app ships with,
 * the environment variable, the path set in Settings, then the copy
 * `npm run fetch:cua-driver` leaves in the repo.
 *
 * The shipped copy comes first, so an installed app runs the driver it was
 * signed and notarized with whatever the environment or a saved path says.
 * A development run has no such copy (Electron's own resources folder holds
 * none), and there the variable and the saved path decide as before.
 */
export function cuaDriverCandidates(
  env: NodeJS.ProcessEnv = process.env,
  configuredPath = getComputerUseSettings().driverPath,
  resourcesPath: string | null = appResourcesPath()
): CuaDriverCandidate[] {
  const candidates: CuaDriverCandidate[] = [];
  if (resourcesPath) candidates.push({ path: path.join(resourcesPath, CUA_DRIVER_RESOURCES_FOLDER, BINARY_NAME), source: 'bundled' });
  const override = env.AEGIS_CUA_DRIVER_PATH?.trim();
  if (override) candidates.push({ path: override, source: 'environment' });
  if (configuredPath) candidates.push({ path: configuredPath, source: 'settings' });
  // dist-electron/electron/libs/computer-use → the repo root.
  candidates.push({
    path: path.resolve(__dirname, '..', '..', '..', '..', 'native', 'cua-driver', 'dist', BINARY_NAME),
    source: 'checkout',
  });
  return candidates;
}

/**
 * Whether this runs from a source checkout, where `npm run fetch:cua-driver`
 * exists. An installed app carries no scripts folder, so the person there is
 * told where to download the driver instead.
 */
function isSourceCheckout(): boolean {
  return existsSync(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'fetch-cua-driver.mjs'));
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
  /** Whether `npm run fetch:cua-driver` exists here; found out when not given. */
  sourceCheckout?: boolean;
  /** The app's resources folder; Electron's when not given, null for none. */
  resourcesPath?: string | null;
} = {}): ComputerUseDriverStatus {
  const pinnedVersion = CUA_DRIVER_VERSION;
  if (!isComputerUsePlatformSupported(options.platform)) {
    return {
      state: 'unsupported-platform',
      source: null,
      path: null,
      version: null,
      pinnedVersion,
      message: 'Computer use is available on macOS only for now.',
    };
  }
  // The first place that holds the pinned version is run. A file that is
  // there but answers otherwise (a damaged copy, another version) does not
  // hide a good one further down; with no good one, the first file is the
  // one reported.
  const readVersion = options.readVersion ?? readCuaDriverVersion;
  const present = cuaDriverCandidates(options.env, options.configuredPath, options.resourcesPath)
    .filter((candidate) => existsSync(candidate.path))
    .map((candidate) => ({ ...candidate, version: readVersion(candidate.path) }));
  const found = present.find((candidate) => candidate.version === pinnedVersion) ?? present[0];
  if (!found) {
    return {
      state: 'missing',
      source: null,
      path: null,
      version: null,
      pinnedVersion,
      message: (options.sourceCheckout ?? isSourceCheckout())
        ? `cua-driver ${pinnedVersion} was not found. Run "npm run fetch:cua-driver", or set its path below.`
        : `cua-driver ${pinnedVersion} is missing from this copy of Aegis. Reinstall Aegis, or download ${cuaDriverAssetName(pinnedVersion)} from ${cuaDriverReleaseUrl(pinnedVersion)}, unpack it, and set the path of the cua-driver file below.`,
    };
  }
  const { path: binaryPath, version } = found;
  if (version !== pinnedVersion) {
    return {
      state: 'version-mismatch',
      source: found.source,
      path: binaryPath,
      version,
      pinnedVersion,
      message: version
        ? `Found cua-driver ${version}, but Aegis runs ${pinnedVersion} only.`
        : `The file at ${binaryPath} did not answer as cua-driver ${pinnedVersion}.`,
    };
  }
  return { state: 'ready', source: found.source, path: binaryPath, version, pinnedVersion, message: null };
}

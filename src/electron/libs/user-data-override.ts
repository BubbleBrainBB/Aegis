import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * AEGIS_USER_DATA_DIR: a profile folder of the caller's own, for tests and for
 * a launch that must not see the user's data.
 *
 * Whoever sets it asked for that folder and no other. When it cannot be used,
 * the launch must not go on with the default profile: that is the user's real
 * data, and with the variable set the single-instance lock is not taken, so
 * the launch would run beside the installed app on the same files (its
 * startup sweep marks every running task as failed, and it rewrites the
 * window, resume and remote-pairing files when it quits). A relative path is
 * such a case under `open`, where the working directory is `/`.
 */
export type UserDataOverride =
  | { kind: 'none' }
  | { kind: 'use'; path: string }
  | { kind: 'unusable'; path: string; reason: string };

/** What the variable asks for. The folder is created when it can be. */
export function resolveUserDataOverride(value: string | undefined, cwd: string = process.cwd()): UserDataOverride {
  const override = value?.trim();
  if (!override) return { kind: 'none' };
  const resolved = path.resolve(cwd, override);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    if (!fs.statSync(resolved).isDirectory()) {
      return { kind: 'unusable', path: resolved, reason: 'it is not a folder' };
    }
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    return { kind: 'unusable', path: resolved, reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'use', path: resolved };
}

export interface UserDataOverrideHost {
  setUserData(dir: string): void;
  /** Ends the process. Nothing of the app may run after it. */
  quit(code: number): void;
  log?(message: string): void;
  error?(message: string): void;
}

/**
 * Applies the variable: the folder becomes the profile, or the launch ends.
 * Returns true when the profile was set here, false when the variable is not
 * set (the caller then picks the default profile).
 */
export function applyUserDataOverride(value: string | undefined, host: UserDataOverrideHost, cwd?: string): boolean {
  const override = resolveUserDataOverride(value, cwd);
  if (override.kind === 'none') return false;
  if (override.kind === 'unusable') {
    (host.error ?? console.error)(
      `[main] AEGIS_USER_DATA_DIR cannot be used (${override.path}): ${override.reason}. Quitting instead of opening the default profile.`
    );
    host.quit(1);
    // A host whose quit returns must still not fall through to the default profile.
    return true;
  }
  host.setUserData(override.path);
  (host.log ?? console.log)(`[main] userData overridden via AEGIS_USER_DATA_DIR: ${override.path}`);
  return true;
}

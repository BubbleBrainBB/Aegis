// Computer use settings: the master switch and an optional driver path, in
// ~/.aegis/computer-use.json. Off unless the user turned it on.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export interface ComputerUseSettings {
  enabled: boolean;
  /** A cua-driver binary the user pointed at; empty for the default places. */
  driverPath: string;
}

function settingsPath(): string {
  return (
    process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH?.trim() ||
    path.join(homedir(), '.aegis', 'computer-use.json')
  );
}

export function getComputerUseSettings(): ComputerUseSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<ComputerUseSettings>;
    return {
      enabled: parsed.enabled === true,
      driverPath: typeof parsed.driverPath === 'string' ? parsed.driverPath.trim() : '',
    };
  } catch {
    return { enabled: false, driverPath: '' };
  }
}

export function saveComputerUseSettings(settings: ComputerUseSettings): void {
  const target = settingsPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(settings, null, 2));
  try {
    chmodSync(target, 0o600);
  } catch {
    // best effort on filesystems without modes
  }
}

/** The driver only exists for macOS in this phase. */
export function isComputerUsePlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** A development run turned Computer use on from outside, whatever the settings file says. */
export function isComputerUseForcedOn(): boolean {
  return isComputerUsePlatformSupported() && process.env.AEGIS_COMPUTER_USE_ENABLED === '1';
}

/**
 * Whether Computer use is on: the switch in Settings (off by default), or
 * AEGIS_COMPUTER_USE_ENABLED=1 for a development run. Settings shows this
 * value, not the stored one, so the page never says "off" while it is on.
 */
export function isComputerUseEnabled(): boolean {
  if (!isComputerUsePlatformSupported()) return false;
  if (isComputerUseForcedOn()) return true;
  return getComputerUseSettings().enabled;
}

export function setComputerUseEnabled(enabled: boolean): void {
  saveComputerUseSettings({ ...getComputerUseSettings(), enabled });
}

export function setComputerUseDriverPath(driverPath: string): void {
  saveComputerUseSettings({ ...getComputerUseSettings(), driverPath: driverPath.trim() });
}

import { rendererStateStorage } from './renderer-state-storage';
import type { MinimaxPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredMinimaxPermissionMode';
const MINIMAX_PERMISSION_MODES: ReadonlyArray<MinimaxPermissionMode> = ['default', 'auto', 'plan', 'bypassPermissions'];

export function normalizeMinimaxPermissionMode(value: unknown): MinimaxPermissionMode {
  return MINIMAX_PERMISSION_MODES.includes(value as MinimaxPermissionMode)
    ? (value as MinimaxPermissionMode)
    : 'default';
}

export function loadPreferredMinimaxPermissionMode(): MinimaxPermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeMinimaxPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredMinimaxPermissionMode(mode: MinimaxPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeMinimaxPermissionMode(mode));
}

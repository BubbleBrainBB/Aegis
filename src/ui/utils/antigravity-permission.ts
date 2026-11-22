import { rendererStateStorage } from './renderer-state-storage';
import type { AntigravityModelConfig, AntigravityPermissionMode } from '../types';
import type { PermissionModeOption } from './permission-modes';

const STORAGE_KEY = 'cowork.preferredAntigravityPermissionMode';
/** ACP's name for the mode a session starts in; what is sent before agy's own list is known. */
export const ANTIGRAVITY_DEFAULT_MODE: AntigravityPermissionMode = 'default';

/** An open set: the ids are agy's own, so only their shape is checked here. */
export function normalizeAntigravityPermissionMode(value: unknown): AntigravityPermissionMode {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim()) ? value.trim() : ANTIGRAVITY_DEFAULT_MODE;
}

export function loadPreferredAntigravityPermissionMode(): AntigravityPermissionMode {
  if (typeof window === 'undefined') return ANTIGRAVITY_DEFAULT_MODE;
  return normalizeAntigravityPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredAntigravityPermissionMode(mode: AntigravityPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeAntigravityPermissionMode(mode));
}

/**
 * The mode picker's rows: the session modes agy offers, under agy's own names
 * and descriptions. Until its list is read there is one row, the mode a
 * session starts in.
 */
export function buildAntigravityPermissionModeOptions(
  config: Pick<AntigravityModelConfig, 'modes'> | null | undefined
): ReadonlyArray<PermissionModeOption<AntigravityPermissionMode>> {
  const modes = config?.modes ?? [];
  if (modes.length === 0) {
    return [{ mode: ANTIGRAVITY_DEFAULT_MODE, label: 'Default', description: 'Antigravity asks before edits and commands' }];
  }
  return modes.map((mode) => ({
    mode: mode.id,
    label: mode.label,
    ...(mode.description ? { description: mode.description, wrapDescription: true } : {}),
  }));
}

/** The saved mode while agy still offers it, else the one its sessions start in. */
export function resolveAntigravityPermissionMode(
  preferred: AntigravityPermissionMode,
  config: Pick<AntigravityModelConfig, 'modes' | 'defaultMode'> | null | undefined
): AntigravityPermissionMode {
  const modes = config?.modes ?? [];
  if (modes.length === 0 || modes.some((mode) => mode.id === preferred)) return preferred;
  return config?.defaultMode ?? modes[0]?.id ?? ANTIGRAVITY_DEFAULT_MODE;
}

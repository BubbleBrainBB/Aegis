import { useEffect, useState } from 'react';
import type { AntigravityModelConfig } from '../types';
import { rendererStateStorage } from '../utils/renderer-state-storage';

const FALLBACK_CONFIG: AntigravityModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
  modes: [],
  defaultMode: null,
  authMethods: [],
  imagePrompts: false,
  agentVersion: null,
};

// Last-good catalog so the first paint already has agy's own names: the live
// read boots an ACP probe session and lands a few seconds after launch.
const CACHE_STORAGE_KEY = 'cowork.antigravityModelConfigCache';

// Every composer mounts this hook; share one catalog read (an ACP probe session
// in the main process) across all of them.
let sharedRequest: Promise<AntigravityModelConfig> | null = null;

type Named = { id: string; label: string; description?: string };

function namedList(raw: unknown): Named[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry): entry is Named => Boolean(entry && typeof entry.id === 'string' && entry.id.trim()))
    .map((entry) => ({
      id: entry.id.trim(),
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : entry.id.trim(),
      ...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
    }));
}

function normalizeAntigravityModelConfig(raw: Partial<AntigravityModelConfig> | null | undefined): AntigravityModelConfig {
  const availableModels = namedList(raw?.availableModels).map(({ id, label }) => ({ id, label }));
  const defaultModel = raw?.defaultModel?.trim() || null;
  const options = Array.from(
    new Set(
      [defaultModel, ...(raw?.options || []), ...availableModels.map((model) => model.id)]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  const modes = namedList(raw?.modes);
  const defaultMode = raw?.defaultMode?.trim() || null;
  return {
    defaultModel,
    options,
    availableModels,
    modes,
    defaultMode: modes.some((mode) => mode.id === defaultMode) ? defaultMode : null,
    authMethods: namedList(raw?.authMethods),
    imagePrompts: raw?.imagePrompts === true,
    agentVersion: raw?.agentVersion?.trim() || null,
  };
}

function loadCachedConfig(): AntigravityModelConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = rendererStateStorage.getItem(CACHE_STORAGE_KEY);
    return raw ? normalizeAntigravityModelConfig(JSON.parse(raw) as Partial<AntigravityModelConfig>) : null;
  } catch {
    return null;
  }
}

function saveCachedConfig(config: AntigravityModelConfig): void {
  if (typeof window === 'undefined') return;
  try {
    rendererStateStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // cache is best-effort
  }
}

/** agy's own name for a model id, else the id. */
export function formatAntigravityModelLabel(value: string, config?: AntigravityModelConfig): string {
  return config?.availableModels.find((model) => model.id === value)?.label || value;
}

/** Forget the shared read: the executable or the account changed. */
export function refreshAntigravityModelConfig(): void {
  sharedRequest = null;
}

/**
 * Models, modes and sign-in methods `agy acp` offers this account, as read
 * over ACP. Empty until the first read lands (or when agy is missing).
 */
export function useAntigravityModelConfig() {
  const [config, setConfig] = useState<AntigravityModelConfig>(() => loadCachedConfig() ?? FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    sharedRequest ??= window.electron.getAntigravityModelConfig().then((next) => {
      const normalized = normalizeAntigravityModelConfig(next);
      // A failed read (CLI missing, signed out, offline) must not stick for
      // the session, nor replace the last good catalog.
      if (normalized.options.length === 0) sharedRequest = null;
      else saveCachedConfig(normalized);
      return normalized;
    });
    sharedRequest
      .then((nextConfig) => {
        if (!cancelled && nextConfig.options.length > 0) setConfig(nextConfig);
      })
      .catch(() => {
        sharedRequest = null;
        // CLI missing: the picker falls back to the provider default row.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

import { useEffect, useState } from 'react';
import type { MinimaxModelConfig } from '../types';
import { rendererStateStorage } from '../utils/renderer-state-storage';

const FALLBACK_CONFIG: MinimaxModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// Last-good catalog so the first paint already has mcode's labels: the live
// read boots an ACP probe session and lands a few seconds after launch.
const CACHE_STORAGE_KEY = 'cowork.minimaxModelConfigCache';

// Every composer mounts this hook; share one catalog read (an ACP probe session
// in the main process) across all of them.
let sharedRequest: Promise<MinimaxModelConfig> | null = null;

function normalizeMinimaxModelConfig(raw: Partial<MinimaxModelConfig> | null | undefined): MinimaxModelConfig {
  const availableModels = (raw?.availableModels || []).filter((model) => Boolean(model?.id?.trim()));
  const defaultModel = raw?.defaultModel?.trim() || null;
  const options = Array.from(
    new Set(
      [defaultModel, ...(raw?.options || []), ...availableModels.map((model) => model.id)]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  return { defaultModel, options, availableModels };
}

function loadCachedConfig(): MinimaxModelConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = rendererStateStorage.getItem(CACHE_STORAGE_KEY);
    return raw ? normalizeMinimaxModelConfig(JSON.parse(raw) as Partial<MinimaxModelConfig>) : null;
  } catch {
    return null;
  }
}

function saveCachedConfig(config: MinimaxModelConfig): void {
  if (typeof window === 'undefined') return;
  try {
    rendererStateStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // cache is best-effort
  }
}

/**
 * Readable name for an mcode select value (`m:<provider>:<model>:v:<variant>`)
 * the catalog does not list (yet): the model id plus its variant, the way mcode
 * names a model without a display name.
 */
export function formatMinimaxModelLabel(value: string, config?: MinimaxModelConfig): string {
  const listed = config?.availableModels.find((model) => model.id === value)?.label;
  if (listed) return listed;
  const [prefix, , model, kind, variant] = value.split(':');
  if (prefix !== 'm' || !model) return value;
  const name = decodeURIComponent(model);
  return kind === 'v' && variant ? `${name} · ${decodeURIComponent(variant)}` : name;
}

export function useMinimaxModelConfig() {
  const [config, setConfig] = useState<MinimaxModelConfig>(() => loadCachedConfig() ?? FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    sharedRequest ??= window.electron.getMinimaxModelConfig().then((next) => {
      const normalized = normalizeMinimaxModelConfig(next);
      // A failed read (CLI missing, offline) must not stick for the session,
      // nor replace the last good catalog.
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

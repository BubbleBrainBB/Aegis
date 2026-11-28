import { useCallback, useState } from 'react';
import type { MimoModelConfig } from '../types';

const FALLBACK_CONFIG: MimoModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// A cold catalog read runs `mimo models`. Share it across interested pickers.
let sharedRequest: Promise<MimoModelConfig> | null = null;

function normalizeMimoModelConfig(raw: Partial<MimoModelConfig> | null | undefined): MimoModelConfig {
  const availableModels = (raw?.availableModels || [])
    .filter((model) => Boolean(model?.id?.trim()))
    .map((model) => ({ ...model, reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [] }));
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

export function useMimoModelConfig() {
  const [config, setConfig] = useState<MimoModelConfig>(FALLBACK_CONFIG);

  const load = useCallback(() => {
    sharedRequest ??= window.electron.getMimoModelConfig()
      .then(normalizeMimoModelConfig)
      .catch(() => FALLBACK_CONFIG)
      .then(next => {
        // A missing CLI or empty catalog can be retried on the next open.
        if (next.options.length === 0) sharedRequest = null;
        return next;
      });
    void sharedRequest.then(setConfig);
  }, []);

  return { config, load };
}

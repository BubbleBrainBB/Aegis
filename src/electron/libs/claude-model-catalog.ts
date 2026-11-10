import { homedir } from 'os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeEnv, sanitizeOfficialClaudeEnv } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';
import type { ClaudeModelInfo } from '../../shared/types';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 25_000;

let cachedModels: { values: ClaudeModelInfo[]; fetchedAt: number } | null = null;
let inflight: Promise<ClaudeModelInfo[]> | null = null;

function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string
  ) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
}

/**
 * Ask the local Claude Code (via the Agent SDK control channel) which models
 * the signed-in account can use — the same source as the CLI's own /model
 * picker, with the CLI's own display names and what each alias resolves to.
 * The probe session gets the sanitized official env, so a third-party
 * ANTHROPIC_BASE_URL configured for Claude Code never shapes this list.
 *
 * Returns [] when Claude Code is missing or the probe fails; callers fall
 * back to the locally-recorded model candidates.
 */
export function getClaudeSupportedModels(force = false): Promise<ClaudeModelInfo[]> {
  if (!force && cachedModels && Date.now() - cachedModels.fetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(cachedModels.values);
  }
  if (!inflight) {
    inflight = fetchSupportedModels()
      .then((values) => {
        if (values.length > 0) {
          cachedModels = { values, fetchedAt: Date.now() };
        }
        return values;
      })
      .catch((error) => {
        console.warn('[claude-model-catalog] supportedModels probe failed:', error);
        return cachedModels?.values ?? [];
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function fetchSupportedModels(): Promise<ClaudeModelInfo[]> {
  const runtime = getClaudeCodeRuntime();
  if (!runtime.pathToClaudeCodeExecutable) {
    return [];
  }

  const sdk = await loadClaudeAgentSdk();
  // On top of this process's environment, as a real session gets it: without
  // HOME the CLI cannot find the account and answers with its signed-out list.
  const env = { ...sanitizeOfficialClaudeEnv({ ...process.env, ...getClaudeEnv() }), ...runtime.env };
  const abortController = new AbortController();

  // Streaming-input session that never sends a prompt: the control channel
  // (supportedModels) answers as soon as the CLI boots.
  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  const query = sdk.query({
    prompt: idlePrompt,
    options: {
      cwd: homedir(),
      abortController,
      env,
      executable: runtime.executable as unknown as 'node',
      executableArgs: runtime.executableArgs,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      settingSources: [],
    },
  });

  try {
    const models = await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('supportedModels timed out')), CATALOG_TIMEOUT_MS);
      }),
    ]);

    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const rows = new Map<string, ClaudeModelInfo>();
    for (const model of models) {
      const id = text(model.value);
      if (!id || rows.has(id)) continue;
      const label = text(model.displayName);
      const resolvedModel = text(model.resolvedModel);
      rows.set(id, { id, ...(label ? { label } : {}), ...(resolvedModel ? { resolvedModel } : {}) });
    }
    return Array.from(rows.values());
  } finally {
    abortController.abort();
  }
}

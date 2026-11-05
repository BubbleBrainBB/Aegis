import type { RemoteAgentOptions, RemoteProvider, RemoteTaskSettings } from "./protocol";

// What another Mac can run, in one shape whatever the agent: the composer builds its
// pickers from this, never from this Mac's own catalog.
export interface RemoteAgentModel {
  id: string;
  label: string;
  efforts: string[];
  fast?: boolean;
}
export interface RemoteAgentEntry {
  provider: RemoteProvider;
  defaultModel: string | null;
  defaultEffort?: string | null;
  models: RemoteAgentModel[];
}

/** Modes the host accepts; same values as the desktop permission menus. Plan is a toggle where it isn't listed. */
export const REMOTE_PERMISSION_MODES: Record<RemoteProvider, string[]> = {
  claude: ["default", "auto", "acceptEdits", "dontAsk", "bypassPermissions"],
  codex: ["defaultPermissions", "auto", "fullAccess"],
  bubble: ["default", "bypassPermissions"],
  devin: ["accept-edits", "smart", "ask", "plan", "bypass"],
  mimo: ["ask", "plan", "build"],
  minimax: ["default", "auto", "plan", "bypassPermissions"],
};
export const REMOTE_DEFAULT_PERMISSION: Record<RemoteProvider, string> = {
  claude: "default",
  codex: "defaultPermissions",
  bubble: "default",
  devin: "accept-edits",
  mimo: "ask",
  minimax: "default",
};
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function agentCatalog(options: RemoteAgentOptions): RemoteAgentEntry[] {
  const entries: RemoteAgentEntry[] = [];
  if (options.claude)
    entries.push({
      provider: "claude",
      defaultModel: options.claude.defaultModel,
      models: options.claude.options.map((id) => ({ id, label: id, efforts: CLAUDE_EFFORTS })),
    });
  if (options.codex)
    entries.push({
      provider: "codex",
      defaultModel: options.codex.defaultModel,
      defaultEffort: options.codex.defaultReasoningEffort,
      models: options.codex.availableModels
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.name,
          label: model.label || model.name,
          efforts: model.supportedReasoningLevels?.map((level) => level.effort) ?? [],
          fast: model.supportsFastMode,
        })),
    });
  if (options.bubble)
    entries.push({
      provider: "bubble",
      defaultModel: options.bubble.defaultModel,
      models: options.bubble.availableModels
        .filter((model) => model.enabled)
        .map((model) => ({ id: model.name, label: model.label || model.name, efforts: model.reasoningLevels ?? [] })),
    });
  if (options.devin) {
    const { thoughtLevels } = options.devin;
    entries.push({
      provider: "devin",
      defaultModel: options.devin.defaultModel,
      models: options.devin.availableModels.map((model) => ({
        id: model.id,
        label: model.label,
        efforts: thoughtLevels[model.id]?.levels.map((level) => level.id) ?? [],
      })),
    });
  }
  if (options.mimo)
    entries.push({
      provider: "mimo",
      defaultModel: options.mimo.defaultModel,
      models: options.mimo.availableModels.map((model) => ({ id: model.id, label: model.label, efforts: model.reasoningEfforts })),
    });
  if (options.minimax) {
    const { thoughtLevels } = options.minimax;
    entries.push({
      provider: "minimax",
      defaultModel: options.minimax.defaultModel,
      models: options.minimax.availableModels.map((model) => ({
        id: model.id,
        label: model.label,
        efforts: thoughtLevels[model.id]?.levels.map((level) => level.id) ?? [],
      })),
    });
  }
  return entries;
}

export type { RemoteTaskSettings };

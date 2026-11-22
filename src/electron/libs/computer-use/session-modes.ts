// What "Plan" is called on each provider. The gateway holds one rule for all
// of them (Plan mode looks, it does not act) and has to be told when a
// session is in it; each provider says so with its own field and value.
//
// A provider that is missing here has no Plan mode in Aegis (DeepSeek, Pi).
// The gateway's rule is on top of whatever the provider's own runtime does
// with its tools in Plan: it holds even where that runtime would let an MCP
// tool through.

export interface ComputerUseRunnerModes {
  provider?: string;
  claudeExecutionMode?: string;
  claudeAccessMode?: string;
  codexExecutionMode?: string;
  opencodePermissionMode?: string;
  kimiPermissionMode?: string;
  grokPermissionMode?: string;
  devinPermissionMode?: string;
  mimoPermissionMode?: string;
  minimaxPermissionMode?: string;
  qoderPermissionMode?: string;
  bubblePermissionMode?: string;
}

/** Whether the session's agent is in its provider's Plan mode. */
export function isComputerUsePlanMode(runner: ComputerUseRunnerModes | null | undefined): boolean {
  if (!runner) return false;
  switch (runner.provider) {
    case 'bubble':
      return runner.bubblePermissionMode === 'plan';
    case 'claude':
      return runner.claudeExecutionMode === 'plan' || runner.claudeAccessMode === 'plan';
    case 'codex':
      return runner.codexExecutionMode === 'plan';
    case 'opencode':
      return runner.opencodePermissionMode === 'plan';
    case 'kimi':
      return runner.kimiPermissionMode === 'plan';
    case 'grok':
      return runner.grokPermissionMode === 'plan';
    case 'devin':
      return runner.devinPermissionMode === 'plan';
    case 'mimo':
      return runner.mimoPermissionMode === 'plan';
    case 'minimax':
      return runner.minimaxPermissionMode === 'plan';
    case 'qoder':
      return runner.qoderPermissionMode === 'plan';
    default:
      return false;
  }
}

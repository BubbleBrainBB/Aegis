// Member configurations the Host offers to the Planner (plan §3.2, §6.2).
// Every integrated provider can join a workflow; which roles it may take
// depends on how the Host can hold it to them. Declarations not yet backed by
// a passing conformance run are marked `verified: false` and shown as such.

import type { AgentProvider, SessionStartPayload } from '../../../shared/types';
import type { MemberRole, WorkflowSpec } from '../../../workflow-engine/spec/workflow-spec';
import type { MemberConfig, ValidationContext } from '../../../workflow-engine/validate/spec-validator';
import { CURRENT_SESSION_AGENT } from '../../../shared/workflow';
import type { ModelOption } from './model-catalogs';

export type ReadOnlyMechanism = 'toolAllowlist' | 'readOnlySandbox' | 'permissionGatedWrites' | 'confinedSandbox';

export type ProviderWorkflowDeclaration = {
  provider: AgentProvider;
  label: string;
  /** How read-only roles are enforced; null means the provider can only implement. */
  readOnly: ReadOnlyMechanism | null;
  /** Payload fields that put a read-only member into the mode the mechanism relies on. */
  readOnlyPayload: Partial<SessionStartPayload>;
  /** Which payload field carries the implementer's permission mode. */
  permissionField: keyof SessionStartPayload | null;
  /** Which payload field carries a member's reasoning effort; null when the provider takes none. */
  effortField: keyof SessionStartPayload | null;
  structuredOutput: 'native' | 'json-tail';
  resumeTurns: boolean;
  /**
   * Set once the provider's read-only conformance run has passed on a real
   * runtime (scripts/tests/workflow-conformance-electron.mjs). 2026-10-05:
   * claude, codex, kimi (plan mode), grok, devin and bubble (plan mode) passed;
   * qoder and deepseek could not run (account limits) and opencode could not
   * start (SDK/CLI version mismatch). 2026-10-07: mimo (plan mode) passed.
   */
  verified: boolean;
};

export const PROVIDER_WORKFLOW_DECLARATIONS: ProviderWorkflowDeclaration[] = [
  {
    provider: 'claude',
    label: 'Claude',
    readOnly: 'toolAllowlist',
    readOnlyPayload: { claudeAccessMode: 'default', claudeExecutionMode: 'execute' },
    permissionField: 'claudeAccessMode',
    effortField: 'claudeReasoningEffort',
    structuredOutput: 'json-tail', // native outputFormat/outputSchema not wired for members yet
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'codex',
    label: 'Codex',
    readOnly: 'readOnlySandbox',
    readOnlyPayload: { codexPermissionMode: 'defaultPermissions', codexExecutionMode: 'execute' },
    permissionField: 'codexPermissionMode',
    effortField: 'codexReasoningEffort',
    structuredOutput: 'json-tail', // native outputFormat/outputSchema not wired for members yet
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'kimi',
    label: 'Kimi',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { kimiPermissionMode: 'plan' },
    permissionField: 'kimiPermissionMode',
    effortField: 'kimiThinking',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'opencode',
    label: 'OpenCode',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { opencodePermissionMode: 'defaultPermissions' },
    permissionField: 'opencodePermissionMode',
    effortField: null,
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    provider: 'grok',
    label: 'Grok',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { grokPermissionMode: 'default' },
    permissionField: 'grokPermissionMode',
    effortField: 'grokReasoningEffort',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'devin',
    label: 'Devin',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { devinPermissionMode: 'ask' },
    permissionField: 'devinPermissionMode',
    effortField: 'devinThoughtLevel',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'mimo',
    label: 'MiMo Code',
    // MiMo's plan agent denies every edit tool; shell writes ask and are refused.
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { mimoPermissionMode: 'plan' },
    permissionField: 'mimoPermissionMode',
    effortField: 'mimoReasoningEffort',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'minimax',
    label: 'MiniMax Code',
    // MiniMax Code's Ask mode still edits inside the workspace; its plan mode
    // is the read-only one.
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { minimaxPermissionMode: 'plan' },
    permissionField: 'minimaxPermissionMode',
    effortField: 'minimaxThinkingEffort',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    provider: 'qoder',
    label: 'Qoder',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { qoderPermissionMode: 'default' },
    permissionField: 'qoderPermissionMode',
    effortField: null,
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    provider: 'bubble',
    label: 'Bubble',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { bubblePermissionMode: 'plan' },
    permissionField: 'bubblePermissionMode',
    effortField: 'bubbleThinkingLevel',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    // The DeepSeek harness never emits permission requests; workspace-write
    // confines bash/fs to the session cwd, which for read-only roles is the
    // disposable review copy.
    provider: 'deepseek',
    label: 'DeepSeek',
    readOnly: 'confinedSandbox',
    readOnlyPayload: { deepseekPermissionMode: 'workspace-write' },
    permissionField: 'deepseekPermissionMode',
    effortField: 'deepseekReasoningEffort',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    // No permission requests and no sandbox: nothing can hold Pi to read-only.
    provider: 'pi',
    label: 'Pi',
    readOnly: null,
    readOnlyPayload: {},
    permissionField: null,
    effortField: null,
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
];

export function declarationFor(provider: string): ProviderWorkflowDeclaration | undefined {
  return PROVIDER_WORKFLOW_DECLARATIONS.find((d) => d.provider === provider);
}

export function rolesFor(declaration: ProviderWorkflowDeclaration): MemberRole[] {
  return declaration.readOnly ? ['implementer', 'reviewer', 'advisor'] : ['implementer'];
}

export function degradedFor(declaration: ProviderWorkflowDeclaration): string[] {
  const degraded: string[] = [];
  if (declaration.structuredOutput !== 'native') degraded.push('structuredOutput');
  if (!declaration.resumeTurns) degraded.push('resumeTurns');
  if (!declaration.verified) degraded.push('unverified');
  return degraded;
}

/**
 * Configurations for the providers available on this machine, plus the chat
 * session that started the run when there is one. That session keeps its own
 * permission mode and is never held read-only, so it may only implement. It
 * also keeps its own model and effort: it continues the chat rather than
 * starting anew.
 */
export function buildMemberConfigs(
  available: AgentProvider[],
  parentProvider?: string | null,
  catalogs: Record<string, ModelOption[]> = {},
): MemberConfig[] {
  const configs: MemberConfig[] = PROVIDER_WORKFLOW_DECLARATIONS.filter((d) => available.includes(d.provider)).map((d) => {
    const catalog = catalogs[d.provider] ?? [];
    const labels = catalog.filter((m) => m.label).map((m) => [m.id, m.label!] as const);
    return {
      name: d.provider,
      provider: d.provider,
      roles: rolesFor(d),
      models: catalog.map((m) => m.id),
      ...(labels.length > 0 ? { modelLabels: Object.fromEntries(labels) } : {}),
      supportsEffort: d.effortField !== null,
      degraded: degradedFor(d),
    };
  });
  const parent = parentProvider ? declarationFor(parentProvider) : undefined;
  if (parent) {
    configs.unshift({
      name: CURRENT_SESSION_AGENT,
      provider: parent.provider,
      roles: ['implementer'],
      models: [],
      degraded: degradedFor(parent).filter((d) => d !== 'unverified'),
    });
  }
  return configs;
}

/** Declaration behind a member's agent name ("current" resolves to the parent session's provider). */
export function declarationForAgent(agent: string, parentProvider?: string | null): ProviderWorkflowDeclaration | undefined {
  return agent === CURRENT_SESSION_AGENT ? (parentProvider ? declarationFor(parentProvider) : undefined) : declarationFor(agent);
}

/** Payload fields for a member session of this role (plan §3.2, §6.3). */
export function memberSessionPayload(
  declaration: ProviderWorkflowDeclaration,
  role: MemberRole | 'planner',
  permissionModes: Record<string, string>
): { payload: Partial<SessionStartPayload>; permissionMode: string | null; permissionDefault: boolean } {
  if (role !== 'implementer') {
    return { payload: { ...declaration.readOnlyPayload }, permissionMode: null, permissionDefault: false };
  }
  const mode = permissionModes[declaration.provider];
  if (!declaration.permissionField || !mode) {
    return { payload: {}, permissionMode: null, permissionDefault: true };
  }
  return {
    payload: { [declaration.permissionField]: mode } as Partial<SessionStartPayload>,
    permissionMode: mode,
    permissionDefault: false,
  };
}

/** Payload field that runs a member at its planned reasoning effort. */
export function memberEffortPayload(declaration: ProviderWorkflowDeclaration, effort: string | null | undefined): Partial<SessionStartPayload> {
  if (!effort || !declaration.effortField) return {};
  return { [declaration.effortField]: effort } as Partial<SessionStartPayload>;
}

/**
 * Fills in the effort levels of the models members were planned on, so the
 * validator can check each requested effort against them. Only the pairs a
 * plan uses are read: some agents probe one model at a time. A level that
 * differs only in case is rewritten to the model's own spelling. A read that
 * fails or times out leaves the model unchecked; its agent applies or
 * ignores the level as its composer would.
 */
export async function withEffortLevels(
  spec: WorkflowSpec,
  context: ValidationContext,
  load: ((provider: string, model: string | null) => Promise<string[] | null>) | undefined,
  timeoutMs = 15_000,
): Promise<ValidationContext> {
  const configs = new Map(context.memberConfigs.map((c) => [c.name, { ...c, efforts: { ...c.efforts } }]));
  const reads = new Map<string, Promise<string[] | null>>();
  for (const member of spec.members) {
    const config = configs.get(member.agent);
    if (!member.effort || !config?.supportsEffort || !load) continue;
    const key = member.model ?? '';
    if (!(key in config.efforts)) {
      const readKey = `${config.provider}\u0000${key}`;
      if (!reads.has(readKey)) reads.set(readKey, readLevels(load, config.provider, member.model ?? null, timeoutMs));
      const levels = await reads.get(readKey)!;
      if (levels) config.efforts[key] = levels;
    }
    const levels = config.efforts[key];
    const match = levels?.find((level) => level.toLowerCase() === member.effort!.toLowerCase());
    if (match) member.effort = match;
  }
  return { ...context, memberConfigs: context.memberConfigs.map((c) => configs.get(c.name)!) };
}

async function readLevels(
  load: (provider: string, model: string | null) => Promise<string[] | null>,
  provider: string,
  model: string | null,
  timeoutMs: number,
): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load(provider, model),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[Workflow] could not read ${provider}'s effort levels:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

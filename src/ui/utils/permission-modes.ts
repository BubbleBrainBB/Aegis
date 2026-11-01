import type {
  BubblePermissionMode,
  ClaudePermissionMode,
  CodexPermissionMode,
  DeepseekPermissionMode,
  DevinPermissionMode,
  MimoPermissionMode,
  MinimaxPermissionMode,
  KimiPermissionMode,
  OpenCodePermissionMode,
  QoderPermissionMode,
} from '../types';

/**
 * One permission-mode picker for every provider. The per-provider pickers were
 * six structurally identical components differing only in their mode list,
 * labels and warn styling — that difference now lives in the option maps
 * below, and the component itself is provider-agnostic.
 *
 * Option semantics:
 * - `tone: 'full-access'` renders the orange trigger with the shield icon
 *   (bypass/full-access modes); `tone: 'danger'` renders the red trigger
 *   without an icon (kimi's YOLO).
 * - `hidden: true` keeps the mode resolvable for the trigger label but out of
 *   the menu — plan modes that enter via /plan and exit via their pill.
 */
export interface PermissionModeOption<M extends string> {
  mode: M;
  label: string;
  /** One line under the label in the menu: what the mode lets the agent do. */
  description?: string;
  tone?: 'full-access' | 'danger';
  hidden?: boolean;
}

// Plan enters via /plan and shows as a separate pill, so it is hidden from
// the menu but still resolvable while active.
export const CLAUDE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<ClaudePermissionMode>> = [
  { mode: 'default', label: 'Default', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', hidden: true },
  { mode: 'auto', label: 'Auto', description: 'Claude handles permission decisions' },
  { mode: 'acceptEdits', label: 'Accept Edits', description: 'Automatically accept file edits' },
  { mode: 'dontAsk', label: "Don't Ask", description: 'Deny anything not pre-approved' },
  { mode: 'bypassPermissions', label: 'Full Access', description: 'Skip all permission checks', tone: 'full-access' },
];

export const CODEX_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<CodexPermissionMode>> = [
  { mode: 'defaultPermissions', label: 'Default', description: 'Edit the workspace, ask for the rest' },
  { mode: 'auto', label: 'Auto', description: 'Codex reviews its own escalations' },
  { mode: 'fullAccess', label: 'Full Access', description: 'No sandbox and no approvals', tone: 'full-access' },
];

export const OPENCODE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<OpenCodePermissionMode>> = [
  { mode: 'defaultPermissions', label: 'Default', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'fullAccess', label: 'Full Access', description: 'Approve every request automatically', tone: 'full-access' },
];

// Shared by kimi and grok (grok rides the kimi mode state end to end).
export const KIMI_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<KimiPermissionMode>> = [
  { mode: 'default', label: 'Default', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'auto', label: 'Auto', description: 'The agent handles permission decisions' },
  { mode: 'yolo', label: 'YOLO', description: 'Approve every request automatically', tone: 'danger' },
];

// Mirrors the qoder-agent-sdk `PermissionMode` union (verified 1.0.15).
export const QODER_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<QoderPermissionMode>> = [
  { mode: 'default', label: 'Default', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'auto', label: 'Auto', description: 'Qoder handles permission decisions' },
  { mode: 'acceptEdits', label: 'Accept Edits', description: 'Automatically accept file edits' },
  { mode: 'dontAsk', label: "Don't Ask", description: 'Deny anything not pre-approved' },
  { mode: 'yolo', label: 'YOLO', description: 'Approve every request automatically', tone: 'full-access' },
  { mode: 'bypassPermissions', label: 'Full Access', description: 'Skip all permission checks', tone: 'full-access' },
];

// Like claude: plan is /plan + pill, not a menu entry.
export const BUBBLE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<BubblePermissionMode>> = [
  { mode: 'default', label: 'Default', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', hidden: true },
  { mode: 'bypassPermissions', label: 'Full Access', description: 'Skip all permission checks', tone: 'full-access' },
];

// dsh pins the sandbox mode via env at runtime spawn; switching respawns the
// runtime through the ipc config-drift path.
export const DEEPSEEK_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<DeepseekPermissionMode>> = [
  { mode: 'workspace-write', label: 'Default', description: 'Edit the workspace, ask for the rest' },
  { mode: 'danger-full-access', label: 'Full Access', description: 'No sandbox and no approvals', tone: 'full-access' },
];

// Devin ACP session modes; applied live via session/set_mode before each turn.
export const DEVIN_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<DevinPermissionMode>> = [
  { mode: 'accept-edits', label: 'Accept Edits', description: 'Automatically accept file edits' },
  { mode: 'smart', label: 'Smart', description: 'Devin decides what needs approval' },
  { mode: 'ask', label: 'Ask', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'bypass', label: 'Full Access', description: 'Skip all permission checks', tone: 'full-access' },
];

// MiMo agents; applied live via session/set_mode before each turn. `build`
// is MiMo's own agent, which runs every tool without asking.
export const MIMO_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<MimoPermissionMode>> = [
  { mode: 'ask', label: 'Ask', description: 'Ask before edits and commands' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'build', label: 'Full Access', description: 'Run every tool without asking', tone: 'full-access' },
];

// MiniMax Code: Ask/Auto/Full Access are its `permissionMode` config option,
// Plan its `plan` session mode; all applied live before each turn. Ask still
// lets it edit inside the workspace; commands ask.
export const MINIMAX_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<MinimaxPermissionMode>> = [
  { mode: 'default', label: 'Ask', description: 'Edit the workspace, ask before commands' },
  { mode: 'auto', label: 'Auto', description: 'MiniMax handles permission decisions' },
  { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
  { mode: 'bypassPermissions', label: 'Full Access', description: 'Skip all permission checks', tone: 'full-access' },
];

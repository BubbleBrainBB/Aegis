import type { SessionContinuePayload } from "../../shared/types";
import type { RemoteTaskSettings } from "../../shared/remote/protocol";
import type { SessionRow } from "../types";
import type { RemoteTaskExtras } from "./gateway";

import { CLAUDE_EFFORTS, REMOTE_PERMISSION_MODES } from "../../shared/remote/agent-catalog";

const PERMISSION_MODES: Record<string, string[]> = REMOTE_PERMISSION_MODES;

const allowedMode = (provider: string, mode: string | null | undefined) =>
  mode && PERMISSION_MODES[provider]?.includes(mode) ? mode : undefined;

type StoredSettings = Pick<
  SessionRow,
  | "provider" | "model"
  | "claude_access_mode" | "claude_execution_mode" | "claude_reasoning_effort"
  | "codex_permission_mode" | "codex_execution_mode" | "codex_reasoning_effort" | "codex_fast_mode"
  | "bubble_permission_mode" | "bubble_plan_exit_mode"
  | "devin_permission_mode" | "mimo_permission_mode" | "minimax_permission_mode"
>;

/**
 * What a session on this Mac is set to, as another device's composer reads it.
 * Plan is a toggle beside the mode where the agent's menu doesn't list it; for
 * Bubble, which runs plan as a mode, the mode said here is the one it returns to.
 */
export function sessionTaskSettings(s: StoredSettings): RemoteTaskSettings {
  const provider = s.provider || "claude";
  const settings: RemoteTaskSettings = { model: s.model || undefined };
  if (provider === "claude") {
    settings.effort = s.claude_reasoning_effort || undefined;
    settings.permissionMode = s.claude_access_mode || undefined;
    settings.plan = s.claude_execution_mode === "plan" || undefined;
  } else if (provider === "codex") {
    settings.effort = s.codex_reasoning_effort || undefined;
    settings.fast = s.codex_fast_mode != null ? s.codex_fast_mode === 1 : undefined;
    settings.permissionMode = s.codex_permission_mode || undefined;
    settings.plan = s.codex_execution_mode === "plan" || undefined;
  } else if (provider === "bubble") {
    const plan = s.bubble_permission_mode === "plan";
    settings.permissionMode = allowedMode(provider, plan ? s.bubble_plan_exit_mode : s.bubble_permission_mode);
    settings.plan = plan || undefined;
  } else if (provider === "devin") {
    settings.permissionMode = allowedMode(provider, s.devin_permission_mode);
  } else if (provider === "mimo") {
    settings.permissionMode = allowedMode(provider, s.mimo_permission_mode);
  } else if (provider === "minimax") {
    settings.permissionMode = allowedMode(provider, s.minimax_permission_mode);
  }
  return settings;
}

/**
 * The settings a session keeps when a message from another device leaves them
 * out (`RemoteSession.keepsSettings`): stored on the session, so they hold
 * across a restart of its agent, and said in every report. A sender leaves
 * these out unless it means to change them, and says the rest in full.
 *
 * Effort is on the list only where the session stores it. For the others it
 * lives with the running agent: a fresh one starts on the agent's default
 * unless the message says otherwise, as it always did.
 */
export function keptSettings(provider: string | null | undefined): Array<keyof RemoteTaskSettings> {
  switch (provider || "claude") {
    case "claude":
      return ["model", "effort", "permissionMode", "plan"];
    case "codex":
      return ["model", "effort", "fast", "permissionMode", "plan"];
    case "bubble":
      return ["model", "permissionMode", "plan"];
    case "devin":
    case "mimo":
    case "minimax":
      return ["model", "permissionMode"];
    default:
      return [];
  }
}

/**
 * Maps task settings from another device onto the desktop composer's payload
 * fields. `current` is what the session is set to, for a message to a session
 * that exists: what the message doesn't say (its mode, plan or not) then stays
 * as it is, where a new task starts on the agent's defaults. The session's own
 * settings are the newest there are; a sender's copy of them may be stale, so
 * a sender says only what it means to change of the fields in `keptSettings`.
 */
export function remoteTaskPayload(
  provider: string,
  extras: RemoteTaskExtras = {},
  current?: RemoteTaskSettings,
): Partial<SessionContinuePayload> {
  const s = extras.settings ?? {};
  const mode = allowedMode(provider, s.permissionMode);
  const followUp = current !== undefined;
  /** The mode said, else the agent's default for a new task, else nothing: the session keeps its own. */
  const orDefault = (fallback: string) => mode ?? (followUp ? undefined : fallback);
  /**
   * Plan or not as said; unsaid, a session that exists stays as it is and a new
   * task executes.
   *
   * Across versions: hosts before this one read a follow-up without `plan` as
   * "execute". A controller from then that leaves it out (its composer does
   * when it shows no plan; it says `plan: false` only when a mode is picked)
   * therefore no longer takes a Claude or Codex session out of a plan it does
   * not know of, one that began here since its last report. The session stays
   * in Plan until a message says otherwise, which is the careful side to err
   * on. Phones, and composers from this version on, always say `plan`.
   */
  const execution = s.plan === undefined && followUp ? undefined : s.plan ? "plan" : "execute";
  const payload: Partial<SessionContinuePayload> = {
    model: s.model || undefined,
    attachments: extras.attachments?.length ? extras.attachments : undefined,
  };
  if (provider === "claude") {
    payload.claudeAccessMode = orDefault("default") as SessionContinuePayload["claudeAccessMode"];
    payload.claudeExecutionMode = execution;
    if (s.effort && CLAUDE_EFFORTS.includes(s.effort))
      payload.claudeReasoningEffort = s.effort as SessionContinuePayload["claudeReasoningEffort"];
  } else if (provider === "codex") {
    payload.codexPermissionMode = orDefault("defaultPermissions") as SessionContinuePayload["codexPermissionMode"];
    payload.codexExecutionMode = execution;
    payload.codexReasoningEffort = s.effort || undefined;
    payload.codexFastMode = s.fast ?? undefined;
  } else if (provider === "bubble") {
    // Plan is one of Bubble's modes, so the mode a message leaves out can't be
    // left to the session alone: the one to come back to is read from `current`.
    // A message that names a mode without the toggle means that mode, not plan.
    const plan = s.plan ?? (mode ? false : (current?.plan ?? false));
    const base = (mode
      ?? (followUp ? allowedMode(provider, current.permissionMode) : "default")
      // Told to leave plan with no mode known to return to: Bubble's own default, or the session would stay in plan.
      ?? (s.plan === false && current?.plan ? "default" : undefined)) as "default" | "bypassPermissions" | undefined;
    if (plan) {
      payload.bubblePermissionMode = "plan";
      if (base) payload.bubblePlanExitMode = base;
    } else if (base) {
      payload.bubblePermissionMode = base;
      payload.bubblePlanExitMode = base;
    }
    payload.bubbleThinkingLevel = s.effort || undefined;
  } else if (provider === "devin") {
    payload.devinPermissionMode = orDefault("accept-edits") as SessionContinuePayload["devinPermissionMode"];
    // Thinking levels are an open set per model; the desktop validates them.
    payload.devinThoughtLevel = s.effort || undefined;
  } else if (provider === "mimo") {
    payload.mimoPermissionMode = orDefault("ask") as SessionContinuePayload["mimoPermissionMode"];
    // Variants are an open set per model; the desktop validates them.
    payload.mimoReasoningEffort = s.effort || undefined;
  } else if (provider === "minimax") {
    payload.minimaxPermissionMode = orDefault("default") as SessionContinuePayload["minimaxPermissionMode"];
    // Thinking efforts are an open set per model; the desktop validates them.
    payload.minimaxThinkingEffort = s.effort || undefined;
  }
  return payload;
}

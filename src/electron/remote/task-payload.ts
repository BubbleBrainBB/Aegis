import type { SessionContinuePayload } from "../../shared/types";
import type { RemoteTaskExtras } from "./gateway";

import { CLAUDE_EFFORTS, REMOTE_PERMISSION_MODES } from "../../shared/remote/agent-catalog";

const PERMISSION_MODES: Record<string, string[]> = REMOTE_PERMISSION_MODES;

/** Maps phone task settings onto the desktop composer's payload fields. */
export function remoteTaskPayload(
  provider: string,
  extras: RemoteTaskExtras = {},
): Partial<SessionContinuePayload> {
  const s = extras.settings ?? {};
  const mode = s.permissionMode && PERMISSION_MODES[provider]?.includes(s.permissionMode) ? s.permissionMode : undefined;
  const payload: Partial<SessionContinuePayload> = {
    model: s.model || undefined,
    attachments: extras.attachments?.length ? extras.attachments : undefined,
  };
  if (provider === "claude") {
    payload.claudeAccessMode = (mode ?? "default") as SessionContinuePayload["claudeAccessMode"];
    payload.claudeExecutionMode = s.plan ? "plan" : "execute";
    if (s.effort && CLAUDE_EFFORTS.includes(s.effort))
      payload.claudeReasoningEffort = s.effort as SessionContinuePayload["claudeReasoningEffort"];
  } else if (provider === "codex") {
    payload.codexPermissionMode = (mode ?? "defaultPermissions") as SessionContinuePayload["codexPermissionMode"];
    payload.codexExecutionMode = s.plan ? "plan" : "execute";
    payload.codexReasoningEffort = s.effort || undefined;
    payload.codexFastMode = s.fast ?? undefined;
  } else if (provider === "bubble") {
    const base = (mode ?? "default") as "default" | "bypassPermissions";
    payload.bubblePermissionMode = s.plan ? "plan" : base;
    payload.bubblePlanExitMode = base === "bypassPermissions" ? "bypassPermissions" : "default";
    payload.bubbleThinkingLevel = s.effort || undefined;
  } else if (provider === "devin") {
    payload.devinPermissionMode = (mode ?? "accept-edits") as SessionContinuePayload["devinPermissionMode"];
    // Thinking levels are an open set per model; the desktop validates them.
    payload.devinThoughtLevel = s.effort || undefined;
  } else if (provider === "mimo") {
    payload.mimoPermissionMode = (mode ?? "ask") as SessionContinuePayload["mimoPermissionMode"];
    // Variants are an open set per model; the desktop validates them.
    payload.mimoReasoningEffort = s.effort || undefined;
  } else if (provider === "minimax") {
    payload.minimaxPermissionMode = (mode ?? "default") as SessionContinuePayload["minimaxPermissionMode"];
    // Thinking efforts are an open set per model; the desktop validates them.
    payload.minimaxThinkingEffort = s.effort || undefined;
  }
  return payload;
}


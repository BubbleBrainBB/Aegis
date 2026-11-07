import type { StreamMessage } from "../types";
import type { WorkflowRunView } from "../workflow";
import type { RemoteMessage, RemoteWorkflow } from "./protocol";

// The phone rebuilds the desktop trace (turns, work groups, stage summaries)
// from the same stream messages the desktop renders, so it ships a bounded
// copy of each message rather than a text-only projection.
const TEXT_LIMIT = 64000;
const VALUE_LIMIT = 8000;
const ARRAY_LIMIT = 200;
const MESSAGE_BYTES = 192 * 1024;
const DROPPED_KEYS = new Set(["images", "mediaRefs", "signature", "encrypted_content"]);

function trim(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) + "\n…" : text;
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") return trim(value, key === "text" || key === "prompt" ? TEXT_LIMIT : VALUE_LIMIT);
  if (!value || typeof value !== "object") return value;
  if (depth > 12) return undefined;
  if (Array.isArray(value))
    return value.slice(0, ARRAY_LIMIT).map((item) => sanitize(item, key, depth + 1));
  const record = value as Record<string, unknown>;
  // Inline images (base64) are replaced by a marker; the phone can't page them.
  if (record.type === "image") return { type: "text", text: "[image]" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (DROPPED_KEYS.has(k)) continue;
    const next = sanitize(v, k, depth + 1);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

function plainText(message: StreamMessage): string {
  if (message.type === "user_prompt") return message.prompt;
  if (message.type !== "assistant" && message.type !== "user") return "";
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

const roleOf = (message: StreamMessage): RemoteMessage["role"] =>
  message.type === "user_prompt"
    ? "user"
    : message.type === "assistant"
      ? "assistant"
      : message.type === "user"
        ? "tool"
        : "system";

export function projectMessages(messages: StreamMessage[]): RemoteMessage[] {
  const result: RemoteMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    // Token deltas and provider bootstrap carry nothing the transcript shows.
    if (message.type === "stream_event") continue;
    if (message.type === "mcp_status" || message.type === "turn_started") continue;
    if (
      message.type === "system" &&
      ["init", "available_commands_update", "token_usage"].includes(message.subtype)
    )
      continue;
    const id =
      ("uuid" in message && message.uuid) ||
      `${message.type}:${message.createdAt ?? 0}:${index}`;
    const at = typeof message.createdAt === "number" ? message.createdAt : undefined;
    let raw = sanitize(message) as StreamMessage;
    if (JSON.stringify(raw).length > MESSAGE_BYTES)
      raw = sanitize(JSON.parse(JSON.stringify(raw, (k, v) => (typeof v === "string" ? trim(v, 1000) : v)))) as StreamMessage;
    result.push({
      id,
      role: roleOf(message),
      text: trim(plainText(message), TEXT_LIMIT),
      at,
      raw,
    });
  }
  return result;
}

const nullableTrim = (text: string | null, limit: number) => (text === null ? null : trim(text, limit));

/** A workflow run for the phone's board: no definition, folders or request text, long text bounded. */
export function projectWorkflow(view: WorkflowRunView): RemoteWorkflow {
  const { spec, cwd: _cwd, isolated: _isolated, goal: _goal, parent, ...run } = view;
  return {
    ...run,
    name: spec?.name ?? null,
    parent: parent ? { sessionId: parent.sessionId, toolUseId: parent.toolUseId, provider: parent.provider } : null,
    description: nullableTrim(run.description, 2000),
    steps: run.steps.map((step) => ({ ...step, summary: nullableTrim(step.summary, 2000) })),
    needsInput: run.needsInput && { ...run.needsInput, detail: nullableTrim(run.needsInput.detail, VALUE_LIMIT) },
    error: nullableTrim(run.error, VALUE_LIMIT),
  };
}

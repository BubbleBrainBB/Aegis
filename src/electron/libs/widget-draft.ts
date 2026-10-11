// Live drafts of show_widget calls: providers stream a tool call's arguments
// while the model writes them, and the chat draws the widget's markup as it
// arrives (scripts run once the call is complete and accepted). Each adapter
// feeds its argument deltas to a WidgetDraftTracker, which pulls the HTML out
// of the partial JSON and emits throttled `widget_draft` messages.

import { isShowWidgetToolName } from '../../shared/widget';
import type { StreamMessage } from '../types';

const THROTTLE_MS = 120;

/**
 * The value of a top-level string field in JSON that may stop anywhere —
 * mid-string, mid-escape. Returns what has been written so far, or undefined
 * when the field hasn't started.
 */
export function readPartialJsonString(json: string, field: string): string | undefined {
  const key = new RegExp(`"${field}"\\s*:\\s*"`, 'g');
  const match = key.exec(json);
  if (!match) return undefined;
  let out = '';
  for (let index = match.index + match[0].length; index < json.length; index += 1) {
    const char = json[index];
    if (char === '"') return out;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = json[index + 1];
    if (next === undefined) return out;
    index += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'u': {
        const hex = json.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default: out += next;
    }
  }
  return out;
}

type DraftMessage = Extract<StreamMessage, { type: 'widget_draft' }>;

interface Draft {
  json: string;
  /** Pi hands over already-parsed partial arguments instead of JSON text. */
  html?: string;
  title?: string;
  sent: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WidgetDraftTracker {
  private readonly drafts = new Map<string, Draft>();
  private readonly ignored = new Set<string>();

  constructor(
    private readonly emit: (message: DraftMessage) => void,
    private readonly throttleMs = THROTTLE_MS
  ) {}

  /** A tool call started; tracked only when it is show_widget. */
  begin(callId: string, toolName: string | undefined): void {
    if (!callId || this.drafts.has(callId) || this.ignored.has(callId)) return;
    if (!toolName) return;
    if (!isShowWidgetToolName(toolName)) {
      this.ignored.add(callId);
      return;
    }
    this.drafts.set(callId, { json: '', sent: '', timer: null });
  }

  isTracking(callId: string): boolean {
    return this.drafts.has(callId);
  }

  /** More argument JSON text for a call (the name may come with the first piece). */
  append(callId: string, delta: string, toolName?: string): void {
    if (toolName) this.begin(callId, toolName);
    const draft = this.drafts.get(callId);
    if (!draft || !delta) return;
    draft.json += delta;
    this.schedule(callId, draft);
  }

  /** The argument JSON written so far, in full. */
  replace(callId: string, json: string, toolName?: string): void {
    if (toolName) this.begin(callId, toolName);
    const draft = this.drafts.get(callId);
    if (!draft || typeof json !== 'string') return;
    draft.json = json;
    this.schedule(callId, draft);
  }

  /** Partially parsed arguments (providers that parse as they stream). */
  replaceFields(callId: string, fields: { html?: unknown; title?: unknown }, toolName?: string): void {
    if (toolName) this.begin(callId, toolName);
    const draft = this.drafts.get(callId);
    if (!draft) return;
    if (typeof fields.html === 'string') draft.html = fields.html;
    if (typeof fields.title === 'string') draft.title = fields.title;
    this.schedule(callId, draft);
  }

  /** The call's arguments are complete: send the last draft and stop tracking. */
  end(callId: string): void {
    const draft = this.drafts.get(callId);
    if (!draft) return;
    this.flush(callId, draft);
    if (draft.timer) clearTimeout(draft.timer);
    this.drafts.delete(callId);
  }

  /** Every call's arguments are complete (the model's reply ended). */
  endAll(): void {
    for (const callId of [...this.drafts.keys()]) this.end(callId);
  }

  /** Forget everything (a retried or finished turn). */
  reset(): void {
    for (const draft of this.drafts.values()) if (draft.timer) clearTimeout(draft.timer);
    this.drafts.clear();
    this.ignored.clear();
  }

  private schedule(callId: string, draft: Draft): void {
    if (draft.timer) return;
    draft.timer = setTimeout(() => {
      draft.timer = null;
      this.flush(callId, draft);
    }, this.throttleMs);
  }

  private flush(callId: string, draft: Draft): void {
    const html = draft.html ?? readPartialJsonString(draft.json, 'html');
    if (!html || html === draft.sent) return;
    draft.sent = html;
    const title = draft.title ?? readPartialJsonString(draft.json, 'title');
    this.emit({ type: 'widget_draft', toolUseId: callId, html, ...(title ? { title } : {}) });
  }
}

/**
 * One Anthropic Messages stream event (Claude, Qoder): tool_use blocks open
 * by index, `input_json_delta` pieces fill them, the block's stop ends them.
 * `blocks` maps the open block indexes of the current message to call ids.
 */
export function trackMessagesStreamEvent(
  event: Record<string, unknown> | undefined,
  drafts: WidgetDraftTracker,
  blocks: Map<number, string>
): void {
  if (!event || typeof event.type !== 'string') return;
  const index = typeof event.index === 'number' ? event.index : -1;
  const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined;
  const delta = event.delta as { type?: unknown; partial_json?: unknown } | undefined;
  if (event.type === 'message_start') {
    blocks.clear();
  } else if (event.type === 'content_block_start' && block?.type === 'tool_use') {
    const id = String(block.id ?? '');
    blocks.set(index, id);
    drafts.begin(id, typeof block.name === 'string' ? block.name : undefined);
  } else if (event.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
    const id = blocks.get(index);
    if (id) drafts.append(id, String(delta.partial_json ?? ''));
  } else if (event.type === 'content_block_stop') {
    const id = blocks.get(index);
    if (id) drafts.end(id);
  }
}

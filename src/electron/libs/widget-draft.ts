// Live drafts of show_widget and design_update calls: providers stream a tool
// call's arguments while the model writes them, and the chat draws the
// widget's markup, or the canvas the boards, as they arrive (scripts run once
// the call is complete and accepted). Each adapter feeds its argument deltas
// to a WidgetDraftTracker, which pulls the HTML out of the partial JSON and
// emits throttled `widget_draft` / `design_draft` messages.

import { isShowWidgetToolName } from '../../shared/widget';
import { DESIGN_UPDATE_TOOL, designToolNameOf } from '../../shared/design-tools';
import type { StreamMessage } from '../types';
import type { DesignDraftBoard } from '../../shared/types';

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

/**
 * JSON that may stop anywhere, parsed as far as it goes: open strings keep
 * what was written, open objects and arrays keep their finished members, and
 * a value cut off mid-number or mid-literal is left out. `closed` holds the
 * objects and arrays whose closing bracket arrived.
 */
export function parsePartialJson(text: string): { value: unknown; closed: WeakSet<object> } {
  const closed = new WeakSet<object>();
  let at = 0;
  const ws = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const string = (): string => {
    at += 1;
    let out = '';
    while (at < text.length) {
      const char = text[at];
      if (char === '"') {
        at += 1;
        return out;
      }
      if (char !== '\\') {
        out += char;
        at += 1;
        continue;
      }
      const next = text[at + 1];
      if (next === undefined) {
        at = text.length;
        return out;
      }
      at += 2;
      if (next === 'u') {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          at = text.length;
          return out;
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else {
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
      }
    }
    return out;
  };
  const value = (): unknown => {
    ws();
    const char = text[at];
    if (char === undefined) return undefined;
    if (char === '"') return string();
    if (char === '{') {
      at += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (at >= text.length) return object;
        if (text[at] === '}') {
          at += 1;
          closed.add(object);
          return object;
        }
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        if (text[at] !== '"') return object;
        const key = string();
        ws();
        if (text[at] !== ':') return object;
        at += 1;
        const member = value();
        if (member !== undefined) object[key] = member;
        if (at >= text.length) return object;
      }
    }
    if (char === '[') {
      at += 1;
      const array: unknown[] = [];
      for (;;) {
        ws();
        if (at >= text.length) return array;
        if (text[at] === ']') {
          at += 1;
          closed.add(array);
          return array;
        }
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        const item = value();
        if (item !== undefined) array.push(item);
        if (at >= text.length) return array;
      }
    }
    const token = /^[-+0-9.eE]+|^true|^false|^null/.exec(text.slice(at))?.[0];
    if (!token) {
      at = text.length;
      return undefined;
    }
    at += token.length;
    // A number running into the end may still be growing.
    if (at >= text.length && /^[-+0-9.eE]/.test(token)) return undefined;
    return token === 'true' ? true : token === 'false' ? false : token === 'null' ? null : Number(token);
  };
  return { value: value(), closed };
}

/** The boards a design_update call is writing, from its partial arguments. */
export function designDraftFromArgs(args: unknown, closed: WeakSet<object> | null, final: boolean) {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const operations = Array.isArray(record.operations) ? record.operations : [];
  const boards: DesignDraftBoard[] = [];
  operations.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const op = raw as Record<string, unknown>;
    if ((op.type !== 'add' && op.type !== 'content') || typeof op.html !== 'string' || !op.html) return;
    boards.push({
      index,
      op: op.type,
      ...(typeof op.boardId === 'string' ? { boardId: op.boardId } : {}),
      ...(typeof op.name === 'string' ? { name: op.name } : {}),
      ...(typeof op.width === 'number' ? { width: op.width } : {}),
      ...(typeof op.height === 'number' ? { height: op.height } : {}),
      html: op.html,
      complete: final || Boolean(closed?.has(op)),
    });
  });
  return {
    ...(typeof record.documentId === 'string' ? { documentId: record.documentId } : {}),
    boards,
  };
}

type DraftMessage = Extract<StreamMessage, { type: 'widget_draft' | 'design_draft' }>;

interface Draft {
  kind: 'widget' | 'design';
  json: string;
  /** Pi hands over already-parsed partial arguments instead of JSON text. */
  fields?: Record<string, unknown>;
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

  /** A tool call started; tracked only when it is show_widget or design_update. */
  begin(callId: string, toolName: string | undefined): void {
    if (!callId || this.drafts.has(callId) || this.ignored.has(callId)) return;
    if (!toolName) return;
    const kind = isShowWidgetToolName(toolName) ? 'widget' : designToolNameOf(toolName) === DESIGN_UPDATE_TOOL ? 'design' : null;
    if (!kind) {
      this.ignored.add(callId);
      return;
    }
    this.drafts.set(callId, { kind, json: '', sent: '', timer: null });
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
  replaceFields(callId: string, fields: Record<string, unknown>, toolName?: string): void {
    if (toolName) this.begin(callId, toolName);
    const draft = this.drafts.get(callId);
    if (!draft || !fields || typeof fields !== 'object') return;
    draft.fields = fields;
    this.schedule(callId, draft);
  }

  /** The call's arguments are complete: send the last draft and stop tracking. */
  end(callId: string): void {
    const draft = this.drafts.get(callId);
    if (!draft) return;
    this.flush(callId, draft, true);
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

  private flush(callId: string, draft: Draft, final = false): void {
    if (draft.kind === 'design') {
      const parsed = draft.fields ? { value: draft.fields, closed: null } : parsePartialJson(draft.json);
      const design = designDraftFromArgs(parsed.value, parsed.closed, final);
      if (!design.boards.length) return;
      const key = JSON.stringify([design.documentId, design.boards.map((b) => [b.index, b.html.length, b.complete, b.name])]);
      if (key === draft.sent) return;
      draft.sent = key;
      this.emit({ type: 'design_draft', toolUseId: callId, ...design });
      return;
    }
    const fieldHtml = typeof draft.fields?.html === 'string' ? draft.fields.html : undefined;
    const html = fieldHtml ?? readPartialJsonString(draft.json, 'html');
    if (!html || html === draft.sent) return;
    draft.sent = html;
    const fieldTitle = typeof draft.fields?.title === 'string' ? draft.fields.title : undefined;
    const title = fieldTitle ?? readPartialJsonString(draft.json, 'title');
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

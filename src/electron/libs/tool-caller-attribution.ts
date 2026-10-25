import type { StreamMessage } from '../../shared/types';

/**
 * Which running session made an HTTP MCP tool call, for providers whose MCP
 * configuration is process-global (Kimi), and for tools that do not read the
 * session header (start_workflow). The call's tool_use lands in the caller's
 * history around the time the request arrives; match it by name and input.
 */
export interface ToolCallerAttributionHost {
  getSessionHistory(sessionId: string): StreamMessage[];
  listRunningSessionIds(): string[];
}

let host: ToolCallerAttributionHost | null = null;
export function initializeToolCallerAttribution(next: ToolCallerAttributionHost): void {
  host = next;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function blocksOf(message: StreamMessage): Record<string, unknown>[] {
  const content = asRecord((message as unknown as Record<string, unknown>).message)?.content;
  return Array.isArray(content) ? content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null) : [];
}

/** Order-insensitive structural equality for JSON-like tool inputs. */
export function sameToolInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameToolInput(v, b[i]));
  }
  const ra = asRecord(a);
  const rb = asRecord(b);
  if (!ra || !rb) return false;
  // Providers drop undefined-valued keys; compare the defined ones.
  const keys = (r: Record<string, unknown>) => Object.keys(r).filter((k) => r[k] !== undefined).sort();
  const ka = keys(ra);
  const kb = keys(rb);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameToolInput(ra[k], rb[k]));
}

/**
 * A recorded tool_use input as the provider sent it: adapters add their own
 * top-level `__aegis*` fields (display title, Computer Use action) to it.
 */
function sentToolInput(input: unknown): unknown {
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('__aegis')));
}

/** The latest unanswered top-level tool_use in `history` matching the call. */
export function findPendingToolUse(
  history: StreamMessage[],
  matchesName: (name: unknown) => boolean,
  input: unknown,
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  const resolved = new Set<string>();
  const candidates: string[] = [];
  for (const message of history) {
    if ((message as { parentToolUseId?: string | null }).parentToolUseId) continue;
    if (message.type === 'assistant') {
      for (const block of blocksOf(message)) {
        if (block.type !== 'tool_use' || !matchesName(block.name) || !sameToolInput(sentToolInput(block.input), input)) continue;
        if (typeof block.id === 'string' && block.id) candidates.push(block.id);
      }
    } else if (message.type === 'user') {
      for (const block of blocksOf(message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resolved.add(block.tool_use_id);
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (!resolved.has(candidates[i]) && !claimed.has(candidates[i])) return candidates[i];
  }
  return null;
}

const POLL_MS = 200;
const TIMEOUT_MS = 5_000;
const CLAIM_TTL_MS = 2 * 60_000;
const claimed = new Set<string>();

/**
 * Wait up to five seconds for a running session to show the matching pending
 * call (the HTTP request can beat the runner's event loop). A claimed call is
 * never attributed twice, so two identical concurrent calls stay apart.
 */
export function findToolCallerSessionId(
  matchesName: (name: unknown) => boolean,
  input: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + TIMEOUT_MS;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (sessionId: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(sessionId);
    };
    const onAbort = () => finish(null);
    const attempt = () => {
      if (signal?.aborted || !host) return finish(null);
      for (const sessionId of host.listRunningSessionIds()) {
        const toolUseId = findPendingToolUse(host.getSessionHistory(sessionId) ?? [], matchesName, input, claimed);
        if (!toolUseId) continue;
        claimed.add(toolUseId);
        setTimeout(() => claimed.delete(toolUseId), CLAIM_TTL_MS).unref?.();
        return finish(sessionId);
      }
      if (Date.now() >= deadline) return finish(null);
      timer = setTimeout(attempt, POLL_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    attempt();
  });
}

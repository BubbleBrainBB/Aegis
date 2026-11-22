// What a provider adapter needs to give its runtime the gateway's tools over
// MCP: the entry for a session's runtime, and the screenshots of a finished
// call for the transcript. Every adapter that is wired goes through here, so
// "who gets Computer use" is decided in one place: the switch is on, the
// pinned driver is there, and the session is not a read-only workflow member.
// (The gateway checks all of that again on every call.)

import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  computerUseToolName,
  computerUseToolOfProviderName,
  type ComputerUseMediaRef,
} from '../../../shared/computer-use';
import { createGrokAcpHttpMcpServer, type GrokAcpHttpMcpServer } from '../provider/grok-acp-mcp';
import type { StreamMessage } from '../../../shared/types';
import { getWorkflowSessionPolicy } from '../workflow/session-hooks';
import { getComputerUseGateway, getComputerUseMcpBridge, isComputerUseAvailableNow } from './index';
import { COMPUTER_USE_TOOL_DEFINITIONS } from './tools';
import type {
  ComputerUseMcpBridge,
  ComputerUseMcpDescriptor,
  ComputerUseMcpImages,
  ComputerUseMcpSessionResolver,
} from './mcp-bridge';

/** Whether a session's runtime is offered the tools right now. */
export function isComputerUseOfferedTo(sessionId: string): boolean {
  return isComputerUseAvailableNow() && !getWorkflowSessionPolicy(sessionId)?.readOnly;
}

/**
 * The MCP entry for the runtime of one session, or null when the session
 * gets no Computer use. The caller hands `url` and `headers` to its runtime
 * under AEGIS_COMPUTER_USE_SERVER_NAME and calls `dispose` when the runtime ends.
 */
export async function createComputerUseMcpEntry(
  sessionId: string,
  options: { images?: ComputerUseMcpImages } = {}
): Promise<ComputerUseMcpDescriptor | null> {
  if (!isComputerUseOfferedTo(sessionId)) return null;
  const bridge = getComputerUseMcpBridge();
  if (!bridge) return null;
  try {
    return await bridge.bindSession(sessionId, options);
  } catch (error) {
    // The session runs without Computer use rather than not at all.
    console.warn('Computer use: the MCP entry could not be made:', error);
    return null;
  }
}

/** Per session: the entry of its one SDK runtime (Claude, Qoder). */
const sessionEntries = new Map<string, ComputerUseMcpDescriptor>();

/**
 * The entry for an SDK runtime that is not a process of its own to watch
 * (Claude's and Qoder's queries). A session has one such runtime at a time:
 * making its entry ends the one made before, and the adapter releases it
 * when the runtime ends.
 */
export async function createComputerUseSessionEntry(
  sessionId: string,
  options: { images?: ComputerUseMcpImages } = {}
): Promise<ComputerUseMcpDescriptor | null> {
  releaseComputerUseSessionEntry(sessionId);
  const entry = await createComputerUseMcpEntry(sessionId, options);
  if (!entry) return null;
  // A start that raced this one made its own meanwhile: the later one stands.
  sessionEntries.get(sessionId)?.dispose();
  sessionEntries.set(sessionId, entry);
  return entry;
}

/** The session's SDK runtime ended (or the session is gone). `entry`: only if it is still that one. */
export function releaseComputerUseSessionEntry(sessionId: string, entry?: ComputerUseMcpDescriptor | null): void {
  const current = sessionEntries.get(sessionId);
  if (!current || (entry && current !== entry)) {
    entry?.dispose();
    return;
  }
  sessionEntries.delete(sessionId);
  current.dispose();
}

/**
 * The gateway's tools as Pi custom tools, bound to their session by closure
 * (Pi takes no MCP servers; this is what Bubble's host tools are for Bubble).
 * Empty when the session gets no Computer use. Pi has no approval of its
 * own and no Plan mode: the gateway's card is the one that asks.
 */
export function createPiComputerUseTools(sessionId: string) {
  if (!isComputerUseOfferedTo(sessionId)) return [];
  return COMPUTER_USE_TOOL_DEFINITIONS.map((definition) => ({
    // The name the transcript, the tool cards and the HUD know these tools by.
    name: computerUseToolName(definition.name),
    label: `Computer use: ${definition.name.replace(/_/g, ' ')}`,
    description: definition.description,
    promptSnippet: definition.description.split('. ')[0] + '.',
    parameters: definition.parameters,
    async execute(callId: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const gateway = getComputerUseGateway();
      if (!gateway) throw new Error('Computer use is not available in this app.');
      const result = await gateway.call({
        sessionId,
        tool: definition.name,
        args: args && typeof args === 'object' ? args : {},
        toolUseId: callId || `computer-use-${Date.now().toString(36)}`,
        signal,
      });
      // Pi reads a thrown error as the tool's failure, with its message for the model.
      if (result.isError) throw new Error(result.text);
      return {
        content: [
          { type: 'text' as const, text: result.text },
          ...result.images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
        ],
        details: {},
      };
    },
  }));
}

/** The names of the Pi tools above, for the session's tool list. */
export function piComputerUseToolNames(sessionId: string): string[] {
  return isComputerUseOfferedTo(sessionId) ? COMPUTER_USE_TOOL_DEFINITIONS.map((definition) => computerUseToolName(definition.name)) : [];
}

/**
 * The entry for a runtime that serves many sessions from one MCP
 * configuration. Read-only workflow members are refused per call, by the gateway.
 */
export async function createComputerUseProviderMcpEntry(
  resolve: ComputerUseMcpSessionResolver,
  options: { images?: ComputerUseMcpImages } = {}
): Promise<ComputerUseMcpDescriptor | null> {
  if (!isComputerUseAvailableNow()) return null;
  const bridge = getComputerUseMcpBridge();
  if (!bridge) return null;
  try {
    return await bridge.bindResolver(resolve, options);
  } catch (error) {
    console.warn('Computer use: the MCP entry could not be made:', error);
    return null;
  }
}

/**
 * The entry for an ACP agent process that serves one session, in the shape
 * `session/new` takes (`mcpServers`, http variant), or null when the session
 * gets no Computer use. The entry lives exactly as long as the process: when
 * the process is gone, however it went, its capability names nobody.
 */
export async function createComputerUseAcpEntry(
  sessionId: string,
  proc: { once(event: 'exit', listener: () => void): unknown; exitCode: number | null; signalCode: string | null },
  options: { images?: ComputerUseMcpImages } = {}
): Promise<{ server: GrokAcpHttpMcpServer; entry: ComputerUseMcpDescriptor } | null> {
  const entry = await createComputerUseMcpEntry(sessionId, options);
  if (!entry) return null;
  proc.once('exit', () => entry.dispose());
  // It may have gone while the entry was being made.
  if (proc.exitCode !== null || proc.signalCode !== null) {
    entry.dispose();
    return null;
  }
  return { server: createGrokAcpHttpMcpServer(AEGIS_COMPUTER_USE_SERVER_NAME, entry), entry };
}

/**
 * A provider's own approval request for a call to a gateway tool: which of
 * its options the adapter answers with, without showing a card, or null when
 * the request is not the gateway's and gets the provider's ordinary card.
 *
 * Some agents ask before every MCP tool call (Devin does, for reads too).
 * The gateway decides those calls itself (lease, Plan, grant, the COMPUTER
 * USE card with the app and the element on it), and asking twice for one
 * click only teaches people to click through.
 *
 * It is answered only when all of this holds:
 * - this session's runtime was handed the gateway's entry, and has reached
 *   the server with it (so the server it calls `aegis-computer-use` is not
 *   one that merely shares the name: with the switch off there is no entry,
 *   and the same request gets the provider's card);
 * - one of the names the request carries is a gateway tool of that server;
 * - the provider offers "allow once". Nothing wider is ever picked: the
 *   provider goes on asking, and the gateway goes on deciding, call by call.
 */
export function gatewayApprovalOption(
  entry: Pick<ComputerUseMcpDescriptor, 'connected'> | null | undefined,
  toolNames: Array<string | null | undefined>,
  options: Array<{ optionId: string; kind?: string }>
): string | null {
  if (!entry?.connected()) return null;
  if (!toolNames.some((name) => computerUseToolOfProviderName(name))) return null;
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
}

/**
 * The same question for a provider that asks with a plain yes or no (an SDK
 * `canUseTool`, as Qoder's): whether the call is the gateway's to decide, so
 * the adapter lets it through without a card of its own.
 */
export function isGatewayToolCall(
  entry: Pick<ComputerUseMcpDescriptor, 'connected'> | null | undefined,
  toolName: string | null | undefined
): boolean {
  return Boolean(entry?.connected() && computerUseToolOfProviderName(toolName));
}

type ToolUse = { tool: string; input: unknown };

/**
 * What the transcript of a session needs for gateway calls, done as it goes
 * by, for every provider that reaches the gateway over MCP:
 *
 * - The tool is named the way the rest of the app knows it. Providers spell
 *   MCP tool names differently (see computerUseToolOfProviderName); the tool
 *   cards, the labels and the Environment strip read one spelling.
 * - The screenshots a call saved are filed with its result. They are what
 *   the Environment strip and the tool card show; without this they would be
 *   on disk and nowhere in the conversation. (Bubble's host tools know their
 *   own call id and file theirs in the adapter; a result that already
 *   carries `mediaRefs` is left alone.)
 */
export class ComputerUseTranscript {
  /** Per session: gateway tool calls seen and not answered yet. */
  private readonly pending = new Map<string, Map<string, ToolUse>>();
  /** Per session: what was filed with a result, so the same result sent again keeps it. */
  private readonly filed = new Map<string, Map<string, ComputerUseMediaRef[]>>();

  constructor(
    private readonly bridge: () => Pick<ComputerUseMcpBridge, 'claimMedia'> | null,
    /**
     * Screenshots of a call made with the agent's own tool call id (native
     * tools: Pi's, which do not come through the bridge).
     */
    private readonly native: (sessionId: string, toolUseId: string) => ComputerUseMediaRef[] = () => []
  ) {}

  /** The message as it should be stored and shown. Never changes the one passed in. */
  annotate(sessionId: string, message: StreamMessage): StreamMessage {
    if (message.type === 'result') {
      // The turn is over: its calls are answered or never will be.
      this.forget(sessionId);
      return message;
    }
    if (message.type !== 'assistant' && message.type !== 'user') return message;
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return message;
    let next: unknown[] | null = null;
    content.forEach((block, index) => {
      if (!block || typeof block !== 'object') return;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use' && typeof record.id === 'string') {
        const tool = computerUseToolOfProviderName(typeof record.name === 'string' ? record.name : null);
        if (!tool) return;
        // Asked again for a result that was filed already: not pending twice.
        if (!this.filed.get(sessionId)?.has(record.id)) {
          this.of(this.pending, sessionId).set(record.id, { tool, input: record.input });
        }
        const canonical = computerUseToolName(tool);
        if (record.name !== canonical) {
          next ??= [...content];
          next[index] = { ...record, name: canonical };
        }
        return;
      }
      if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') return;
      if (Array.isArray(record.mediaRefs) && record.mediaRefs.length > 0) return;
      const mediaRefs = this.mediaFor(sessionId, record.tool_use_id);
      if (mediaRefs.length === 0) return;
      next ??= [...content];
      next[index] = { ...record, mediaRefs };
    });
    if (!next) return message;
    return { ...message, message: { ...(message as { message: object }).message, content: next } } as StreamMessage;
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.filed.delete(sessionId);
  }

  private mediaFor(sessionId: string, toolUseId: string): ComputerUseMediaRef[] {
    const already = this.filed.get(sessionId)?.get(toolUseId);
    if (already) return already;
    const call = this.pending.get(sessionId)?.get(toolUseId);
    if (!call) return [];
    this.pending.get(sessionId)!.delete(toolUseId);
    const viaBridge = this.bridge()?.claimMedia(sessionId, call.tool, call.input) ?? [];
    const mediaRefs = viaBridge.length > 0 ? viaBridge : this.native(sessionId, toolUseId);
    if (mediaRefs.length > 0) this.of(this.filed, sessionId).set(toolUseId, mediaRefs);
    return mediaRefs;
  }

  private of<T>(map: Map<string, Map<string, T>>, sessionId: string): Map<string, T> {
    let own = map.get(sessionId);
    if (!own) {
      own = new Map();
      map.set(sessionId, own);
    }
    return own;
  }
}

/** The app's one: fed by the agent loop with every provider message. */
export const computerUseTranscript = new ComputerUseTranscript(
  () => getComputerUseMcpBridge(),
  (sessionId, toolUseId) => getComputerUseGateway()?.takeMediaRefs(sessionId, toolUseId) ?? []
);

/** The session was deleted: nothing of it is kept on the MCP side. */
export function forgetComputerUseMcpSession(sessionId: string): void {
  releaseComputerUseSessionEntry(sessionId);
  getComputerUseMcpBridge()?.forgetSession(sessionId);
  computerUseTranscript.forget(sessionId);
}

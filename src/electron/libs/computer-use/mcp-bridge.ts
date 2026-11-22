// The gateway's tools over loopback MCP, for the providers that take their
// tools from an MCP server (DeepSeek, the ACP agents, Grok, Qoder, OpenCode).
// Bubble gets the same tools as host tools (bubble-computer-use-tool.ts).
//
// This is a transport and nothing else. Every call is handed to the one
// ComputerUseGateway (service.ts), which holds the lease, asks with the
// COMPUTER USE card, validates the arguments and owns the driver. Nothing
// here talks to cua-driver, and no provider is given another way in.
//
// What the bridge adds is the one thing the gateway cannot know by itself:
// which Aegis session is calling. A provider runtime is handed a URL and
// headers when it starts; the headers carry a random capability that names
// exactly one session (or, for a runtime that serves many sessions, a
// resolver that names the session of each request). A request without one is
// refused. There is no guessing from transcripts: a desktop action attributed
// to the wrong session would ask the wrong person and take the wrong lease.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  computerUseScreenshotExtension,
  type ComputerUseMediaRef,
} from '../../../shared/computer-use';
import { resolveComputerUseArtifactRoot } from '../codex-computer-use';
import type { ComputerUseGateway } from './service';
import { COMPUTER_USE_TOOL_DEFINITIONS } from './tools';

export const COMPUTER_USE_MCP_SESSION_HEADER = 'x-aegis-computer-use-session';
export const COMPUTER_USE_MCP_RESOLVER_HEADER = 'x-aegis-computer-use-resolver';
const MCP_PATH = '/mcp';

/**
 * How long one call may take here before the bridge answers that it was not
 * run. The approval card is the long part: a person reading it. The gateway
 * itself would wait ten minutes, but an MCP client waits for the response of
 * its HTTP request, and the common ones (Node's fetch) give up on a request
 * without response headers after five minutes. Answering in words before
 * that beats a transport error the model cannot read.
 */
export const COMPUTER_USE_MCP_CALL_DEADLINE_MS = 4.5 * 60_000;

/**
 * The per-call timeout a provider's MCP client is given, where it has one:
 * past the bridge's own deadline, so the bridge's answer is the one that arrives.
 */
export const COMPUTER_USE_MCP_TOOL_TIMEOUT_MS = COMPUTER_USE_MCP_CALL_DEADLINE_MS + 20_000;

export const COMPUTER_USE_MCP_DEADLINE_MESSAGE =
  'Computer use gave up on this call after waiting too long, usually because the approval was not answered. Look at the app again before retrying, and ask the user first.';

export const COMPUTER_USE_MCP_UNBOUND_MESSAGE =
  'Computer use could not tell which Aegis conversation made this call, so it was not run.';

/**
 * What a provider's model gets of a screenshot. `inline`: the image itself,
 * for MCP clients known to hand image blocks to the model. `file`: the path
 * of the saved image in the text, for the rest (an image block such a client
 * does not understand is dropped at best and pasted into the context as
 * base64 at worst).
 */
export type ComputerUseMcpImages = 'inline' | 'file';

export type ComputerUseMcpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ComputerUseMcpResult {
  content: ComputerUseMcpContent[];
  isError: boolean;
}

/** Names the session of one request from its MCP `_meta`, for a runtime that serves many. */
export type ComputerUseMcpSessionResolver = (
  meta: Record<string, unknown> | undefined
) => Promise<string | null> | string | null;

/** What a provider runtime is handed: where the server is and how it says who it is. */
export interface ComputerUseMcpDescriptor {
  url: string;
  headers: Record<string, string>;
  /** The runtime is gone: its capability names nobody from here on. */
  dispose: () => void;
  /**
   * Whether the runtime has reached the server with this entry. Until it
   * has, nothing shows that a tool it calls `aegis-computer-use` is this one.
   */
  connected: () => boolean;
}

export interface ComputerUseMcpBridgeDeps {
  /** The app's one gateway; null before it exists. */
  gateway: () => ComputerUseGateway | null;
  userDataDir: () => string;
  /** For the tests: COMPUTER_USE_MCP_CALL_DEADLINE_MS otherwise. */
  callDeadlineMs?: number;
}

type Binding =
  | { kind: 'session'; sessionId: string; images: ComputerUseMcpImages }
  | { kind: 'resolver'; resolve: ComputerUseMcpSessionResolver; images: ComputerUseMcpImages };

type FinishedCall = {
  tool: string;
  argsKey: string;
  mediaRefs: ComputerUseMediaRef[];
  at: number;
};

/** Finished calls whose screenshots no transcript has asked for yet are kept this long, and this many per session. */
const FINISHED_CALL_TTL_MS = 5 * 60_000;
const FINISHED_CALL_LIMIT = 32;

/** The same arguments give the same key, whatever order their keys came in. */
function argsKeyOf(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sort(item)])
    );
  };
  try {
    return JSON.stringify(sort(value)) ?? '';
  } catch {
    return '';
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

/* eslint-disable @typescript-eslint/no-var-requires */
// Electron compiles to CJS; node10 resolution cannot resolve the SDK export map.
function loadMcpSdk() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  return { Server, StreamableHTTPServerTransport, CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema };
}
/* eslint-enable @typescript-eslint/no-var-requires */

export class ComputerUseMcpBridge {
  private readonly token = randomUUID();
  private readonly bindings = new Map<string, Binding>();
  /** Capabilities a runtime has made a request with. */
  private readonly reached = new Set<string>();
  private readonly finished = new Map<string, FinishedCall[]>();
  /**
   * Calls on their way, per capability and JSON-RPC request id. Each HTTP
   * request is its own MCP server here, so a client's "cancelled" for a call
   * arrives on another request than the call itself and is matched by this.
   */
  private readonly inFlight = new Map<string, Map<string | number, Set<AbortController>>>();
  private http: HttpServer | null = null;
  private listening: Promise<string> | null = null;

  constructor(private readonly deps: ComputerUseMcpBridgeDeps) {}

  /**
   * The entry for a runtime that serves this one session. Every call it
   * makes is this session's, for as long as the runtime lives.
   */
  async bindSession(sessionId: string, options: { images?: ComputerUseMcpImages } = {}): Promise<ComputerUseMcpDescriptor> {
    return this.bind({ kind: 'session', sessionId, images: options.images ?? 'file' }, COMPUTER_USE_MCP_SESSION_HEADER);
  }

  /**
   * The entry for a runtime that serves many sessions from one MCP
   * configuration: each request is the session `resolve` reads out of its
   * `_meta`, and a request it cannot place is refused.
   */
  async bindResolver(
    resolve: ComputerUseMcpSessionResolver,
    options: { images?: ComputerUseMcpImages } = {}
  ): Promise<ComputerUseMcpDescriptor> {
    return this.bind({ kind: 'resolver', resolve, images: options.images ?? 'file' }, COMPUTER_USE_MCP_RESOLVER_HEADER);
  }

  private async bind(binding: Binding, header: string): Promise<ComputerUseMcpDescriptor> {
    const url = await this.listen();
    const capability = randomUUID();
    this.bindings.set(capability, binding);
    return {
      url,
      headers: { Authorization: `Bearer ${this.token}`, [header]: capability },
      dispose: () => {
        this.bindings.delete(capability);
        this.reached.delete(capability);
        // The runtime is gone: nobody waits for what it asked.
        this.cancel(capability);
      },
      connected: () => this.reached.has(capability),
    };
  }

  /** Ends calls on their way: one request of a capability, or all of them. */
  private cancel(capability: string, requestId?: string | number): void {
    const calls = this.inFlight.get(capability);
    if (!calls) return;
    const ending = requestId === undefined ? [...calls.values()] : [calls.get(requestId) ?? new Set<AbortController>()];
    for (const controllers of ending) {
      for (const controller of controllers) controller.abort(new Error('The MCP client cancelled the call.'));
    }
  }

  private track(capability: string, requestId: string | number, controller: AbortController): () => void {
    const calls = this.inFlight.get(capability) ?? new Map<string | number, Set<AbortController>>();
    this.inFlight.set(capability, calls);
    // Two connections of one runtime can use the same id; a cancel then ends
    // both. Ending one call too many is the safe side of that.
    const controllers = calls.get(requestId) ?? new Set<AbortController>();
    calls.set(requestId, controllers);
    controllers.add(controller);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) calls.delete(requestId);
      if (calls.size === 0) this.inFlight.delete(capability);
    };
  }

  /**
   * One tool call of one session, through the gateway. The id the lease,
   * the live frames and the saved screenshots are filed under is made here:
   * an MCP request does not carry the agent's own tool call id.
   */
  async callTool(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; images?: ComputerUseMcpImages } = {}
  ): Promise<ComputerUseMcpResult> {
    const gateway = this.deps.gateway();
    if (!gateway) {
      return { content: [{ type: 'text', text: 'Computer use is not available in this app.' }], isError: true };
    }
    const toolUseId = `mcp-${randomUUID()}`;
    // The call ends when its caller goes away, or when it has waited as long
    // as an MCP client can be expected to wait for it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.deps.callDeadlineMs ?? COMPUTER_USE_MCP_CALL_DEADLINE_MS);
    let result: Awaited<ReturnType<ComputerUseGateway['call']>>;
    try {
      result = await gateway.call({
        sessionId,
        tool,
        args,
        toolUseId,
        signal: options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (deadline.signal.aborted && result.isError && !options.signal?.aborted) {
      // The gateway ended it like any cancelled call: card down, hold on the
      // desktop given back. The model is told why. Nearly always nothing ran
      // (the wait was the card), but an action that was approved at the last
      // moment may have been under way, so the words do not promise that.
      return { content: [{ type: 'text', text: COMPUTER_USE_MCP_DEADLINE_MESSAGE }], isError: true };
    }
    const mediaRefs = gateway.takeMediaRefs(sessionId, toolUseId);
    if (mediaRefs.length > 0) this.remember(sessionId, { tool, argsKey: argsKeyOf(args), mediaRefs, at: Date.now() });
    // The screenshot is always a file the text names; `inline` attaches the
    // image too. A model that cannot take the image still has the path.
    const saved = mediaRefs.map((ref) => this.artifactPath(ref));
    const inline = options.images === 'inline';
    const where =
      saved.length === 0
        ? ''
        : inline
          ? `\n\nScreenshot also saved to ${saved.join(', ')}.`
          : `\n\nScreenshot saved to ${saved.join(', ')}. Open that image file (for example with your image viewing or file reading tool) when the tree is not enough.`;
    return {
      content: [
        { type: 'text', text: `${result.text}${where}` },
        ...(inline
          ? result.images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
          : []),
      ],
      isError: result.isError,
    };
  }

  /**
   * The screenshots of a finished call, for the transcript: asked for by the
   * provider's own tool result once it arrives, which knows the tool and the
   * arguments but not the id made in callTool. The call with the same
   * arguments is meant; failing that, the oldest of that tool. Handed over once.
   */
  claimMedia(sessionId: string, tool: string, args: unknown): ComputerUseMediaRef[] {
    const calls = this.fresh(sessionId);
    if (calls.length === 0) return [];
    const key = argsKeyOf(args);
    let index = calls.findIndex((call) => call.tool === tool && call.argsKey === key);
    if (index < 0) index = calls.findIndex((call) => call.tool === tool);
    if (index < 0) return [];
    const [call] = calls.splice(index, 1);
    if (calls.length === 0) this.finished.delete(sessionId);
    return call.mediaRefs;
  }

  /** The session's turn ended, or the session is gone. */
  forgetSession(sessionId: string): void {
    this.finished.delete(sessionId);
  }

  /** The session's finished calls that are still kept; the list itself, so a claim can take from it. */
  private fresh(sessionId: string): FinishedCall[] {
    const calls = this.finished.get(sessionId);
    if (!calls) return [];
    const oldest = Date.now() - FINISHED_CALL_TTL_MS;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (calls[index].at < oldest) calls.splice(index, 1);
    }
    if (calls.length === 0) this.finished.delete(sessionId);
    return calls;
  }

  private remember(sessionId: string, call: FinishedCall): void {
    const calls = [...this.fresh(sessionId), call].slice(-FINISHED_CALL_LIMIT);
    this.finished.set(sessionId, calls);
  }

  private artifactPath(ref: ComputerUseMediaRef): string {
    return path.join(
      resolveComputerUseArtifactRoot(this.deps.userDataDir(), ref.sessionId),
      `${ref.sha256}.${computerUseScreenshotExtension(ref.mimeType)}`
    );
  }

  /** Starts the loopback server on first use. Nothing here starts the driver. */
  private listen(): Promise<string> {
    if (this.listening) return this.listening;
    this.listening = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.warn('Computer use MCP request failed:', error);
          if (!res.headersSent) rpcError(res, 500, 'Internal error');
          else res.end();
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('The Computer use MCP server did not bind a port.'));
          return;
        }
        server.unref();
        this.http = server;
        resolve(`http://127.0.0.1:${address.port}${MCP_PATH}`);
      });
    });
    this.listening.catch(() => {
      this.listening = null;
    });
    return this.listening;
  }

  /** One streamable-HTTP MCP request. Exposed for the tests. */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = headerOf(req, 'authorization');
    if (!sameSecret(`Bearer ${this.token}`, authorization)) return rpcError(res, 401, 'Unauthorized');
    if ((req.url || '').split('?')[0] !== MCP_PATH) return rpcError(res, 404, 'Not Found');
    if (req.method !== 'POST') {
      // No server-to-client stream and no MCP session to end.
      res.writeHead(405).end();
      return;
    }
    const capability = headerOf(req, COMPUTER_USE_MCP_SESSION_HEADER) || headerOf(req, COMPUTER_USE_MCP_RESOLVER_HEADER);
    const binding = capability ? this.bindings.get(capability) : undefined;
    // Who calls is settled before anything is listed or run.
    if (!binding) return rpcError(res, 403, 'Invalid or expired Computer use capability');
    this.reached.add(capability!);

    const disconnected = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) disconnected.abort(new Error('MCP client disconnected.'));
    };
    const onAborted = () => disconnected.abort(new Error('MCP request aborted.'));
    res.once('close', onClose);
    req.once('aborted', onAborted);

    const { Server, StreamableHTTPServerTransport, CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } = loadMcpSdk();
    const server = new Server(
      { name: AEGIS_COMPUTER_USE_SERVER_NAME, version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: COMPUTER_USE_TOOL_DEFINITIONS.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.parameters,
        annotations: { readOnlyHint: !definition.mutating, openWorldHint: false },
      })),
    }));
    // A provider that gives up on a call (its own timeout, a stop) says so
    // with a notification of its own request: the call it names ends, with
    // its approval card and its hold on the desktop.
    server.setNotificationHandler(
      CancelledNotificationSchema,
      async (notification: { params?: { requestId?: string | number } }) => {
        const requestId = notification.params?.requestId;
        if (requestId !== undefined) this.cancel(capability!, requestId);
      }
    );
    server.setRequestHandler(
      CallToolRequestSchema,
      async (
        request: { params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } },
        extra: { signal?: AbortSignal; requestId?: string | number } | undefined
      ) => {
        const sessionId =
          binding.kind === 'session'
            ? binding.sessionId
            : await Promise.resolve(binding.resolve(request.params._meta)).catch(() => null);
        if (!sessionId) {
          return { content: [{ type: 'text', text: COMPUTER_USE_MCP_UNBOUND_MESSAGE }], isError: true };
        }
        // The runtime may have ended (and its capability with it) while the session was being read.
        if (this.bindings.get(capability!) !== binding) {
          return { content: [{ type: 'text', text: COMPUTER_USE_MCP_UNBOUND_MESSAGE }], isError: true };
        }
        const cancelled = new AbortController();
        const untrack = extra?.requestId === undefined ? () => undefined : this.track(capability!, extra.requestId, cancelled);
        const signals = [disconnected.signal, cancelled.signal, extra?.signal].filter(
          (signal): signal is AbortSignal => Boolean(signal)
        );
        const args = request.params.arguments;
        try {
          return await this.callTool(sessionId, request.params.name, args && typeof args === 'object' ? args : {}, {
            signal: AbortSignal.any(signals),
            images: binding.images,
          });
        } finally {
          untrack();
        }
      }
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      res.removeListener('close', onClose);
      req.removeListener('aborted', onAborted);
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  /** At app quit, and for the tests. Every capability ends with the server. */
  dispose(): void {
    for (const capability of [...this.inFlight.keys()]) this.cancel(capability);
    this.bindings.clear();
    this.reached.clear();
    this.finished.clear();
    this.http?.close();
    this.http = null;
    this.listening = null;
  }
}

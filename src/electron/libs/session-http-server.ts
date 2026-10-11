import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { buildSessionMcpServer, SESSION_MCP_SERVER_NAME } from './session-mcp';
import { removeKimiMcpServerRaw, upsertKimiMcpServerRaw } from './kimi-mcp-settings';
import { SHOW_WIDGET_TOOL, WIDGET_GUIDE_TOOL } from '../../shared/widget';

export { SESSION_MCP_SERVER_NAME } from './session-mcp';
export const SESSION_TOKEN_ENV_VAR = 'AEGIS_SESSION_MCP_TOKEN';
export interface SessionHttpServerInfo { url: string; port: number; token: string }
let pending: Promise<SessionHttpServerInfo> | null = null;
let http: Server | null = null;

/** Kimi's entry for Aegis's widget tools (show_widget and widget_guide only). */
export const KIMI_WIDGET_SERVER_NAME = 'aegis-widgets';

export async function handleSessionMcpRequest(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  // `?tools=a,b` narrows the server to those tools (Kimi's widget entry).
  const only = requestUrl.searchParams.get('tools');
  const server = buildSessionMcpServer(only ? { only: new Set(only.split(',').map(name => name.trim()).filter(Boolean)) } : {});
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

/**
 * Set the token before any provider process starts: a Kimi daemon reads the
 * token for its widget entry from the environment it inherits.
 */
export function primeSessionToken(): void {
  if (!process.env[SESSION_TOKEN_ENV_VAR]) process.env[SESSION_TOKEN_ENV_VAR] = randomUUID();
}

export function ensureSessionHttpServer(): Promise<SessionHttpServerInfo> {
  if (pending) return pending;
  pending = (async () => {
    const token = process.env[SESSION_TOKEN_ENV_VAR] || randomUUID();
    const server = createServer((req, res) => {
      void handleSessionMcpRequest(req, res, token).catch(error => {
        console.warn('Conversation reader request failed:', error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Conversation reader did not bind a port.');
      const info = { url: `http://127.0.0.1:${address.port}/mcp`, port: address.port, token };
      process.env[SESSION_TOKEN_ENV_VAR] = token;
      http = server;
      return info;
    } catch (error) {
      server.close();
      throw error;
    }
  })();
  void pending.catch(() => { pending = null; });
  return pending;
}

export function disposeSessionHttpServer(): void {
  http?.close();
  http = null;
  pending = null;
}

// Runtime-only descriptor. Never persist this endpoint in a user's agent config.
export async function getSessionReaderHttpConfig() {
  const info = await ensureSessionHttpServer();
  return { type: 'http' as const, url: info.url, headers: { Authorization: `Bearer ${info.token}` } };
}

/**
 * Kimi takes MCP servers only from its global mcp.json, so its widget tool is
 * an entry there: this instance's URL, narrowed to show_widget, with the token
 * named by an environment variable (never written to the file).
 */
export async function writeKimiWidgetEntry(): Promise<void> {
  const info = await ensureSessionHttpServer();
  kimiWidgetUrl = `${info.url}?tools=${SHOW_WIDGET_TOOL},${WIDGET_GUIDE_TOOL}`;
  upsertKimiMcpServerRaw(KIMI_WIDGET_SERVER_NAME, { url: kimiWidgetUrl, bearerTokenEnvVar: SESSION_TOKEN_ENV_VAR });
}

let kimiWidgetUrl: string | null = null;

/** On quit: drop the entry if it still points at this instance (another
 * running Aegis may have rewritten it since). Synchronous. */
export function releaseKimiWidgetEntrySync(): void {
  const url = kimiWidgetUrl;
  if (!url) return;
  try {
    removeKimiMcpServerRaw(KIMI_WIDGET_SERVER_NAME, (entry) => entry.url === url);
  } catch (error) {
    console.warn('Failed to remove the kimi widget MCP entry on quit:', error);
  }
}

export async function getSessionReaderCodexArgs(): Promise<string[]> {
  const info = await ensureSessionHttpServer();
  return ['-c', `mcp_servers.aegis-sessions={url=${JSON.stringify(info.url)},bearer_token_env_var="${SESSION_TOKEN_ENV_VAR}",enabled=true}`];
}

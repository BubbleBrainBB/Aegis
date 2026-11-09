import type { AcpJsonRpcClient } from './acp-json-rpc-client';

const DISCARD_TIMEOUT_MS = 5_000;

/**
 * Delete a throwaway ACP session (a task-naming one-shot) from the agent's own
 * history, trying each method the agent may speak in turn: ACP's
 * `session/delete`, then an agent's own extension. Best effort: an agent that
 * cannot delete keeps the session, which is all it costs.
 */
export async function discardAcpSession(
  rpc: Pick<AcpJsonRpcClient, 'request'>,
  sessionId: string,
  methods: readonly string[] = ['session/delete']
): Promise<boolean> {
  if (!sessionId) return false;
  for (const method of methods) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        rpc.request(method, { sessionId }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out`)), DISCARD_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      // Not supported, or it failed: try the next way, else keep the session.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

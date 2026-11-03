import { resolve } from 'node:path';

export const RESUME_NOT_FOUND_CODE = 'AEGIS_DSH_RESUME_NOT_FOUND';
export const RESUME_CWD_MISMATCH_CODE = 'AEGIS_DSH_RESUME_CWD_MISMATCH';

const PATCH_MARKER = Symbol.for('aegis.deepseek-sdk-jsonrpc-server.resume-shim');

function resumeError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

/**
 * Open one SDK session with the same create-or-resume policy as the Harness
 * Web host. The JSON-RPC server only checks its process-local map and creates
 * a fresh Agent on the first prompt after a restart; this shim checks the
 * durable store first and routes a stored same-cwd identity through the
 * server's own resume path (`createSession(id, true)` → agents.resume()).
 * Native `session/resume` restores the stored directory without checking it,
 * so the same cwd guard applies to both entry points.
 */
export async function openSessionWithNativeResume({
  server,
  sessionId,
  SessionId,
  createSession,
  expectedResumeSessionId = process.env.AEGIS_DSH_RESUME_SESSION_ID,
}) {
  const persistence = server.ctx.get('sessionPersistence');
  const stored = persistence === undefined
    ? undefined
    : (await persistence.stat(SessionId(sessionId)))?.header;

  if (stored === undefined) {
    if (expectedResumeSessionId === sessionId) {
      throw resumeError(
        RESUME_NOT_FOUND_CODE,
        `persisted session "${sessionId}" was not found; start a fresh session instead`,
      );
    }
    return createSession.call(server, sessionId, false);
  }

  const storedCwd = stored.cwd === undefined ? undefined : resolve(stored.cwd);
  if (storedCwd !== server.cwd) {
    throw resumeError(
      RESUME_CWD_MISMATCH_CODE,
      `session "${sessionId}" belongs to "${stored.cwd ?? '<no cwd>'}", not "${server.cwd}"`,
    );
  }
  return createSession.call(server, sessionId, true);
}

/** Patch the exported JSON-RPC server class before Cordis boots its plugin. */
export function installDeepseekSdkResumeShim({ HarnessSdkJsonRpcServer, SessionId }) {
  const prototype = HarnessSdkJsonRpcServer.prototype;
  if (prototype[PATCH_MARKER]) return;

  const createSession = prototype.createSession;
  Object.defineProperty(prototype, PATCH_MARKER, { value: true });
  prototype.createSession = function createOrResumeSession(sessionId, resume) {
    return openSessionWithNativeResume({
      server: this,
      sessionId,
      SessionId,
      createSession,
      // Native session/resume must never fall back to a fresh session.
      ...(resume ? { expectedResumeSessionId: sessionId } : {}),
    });
  };
}

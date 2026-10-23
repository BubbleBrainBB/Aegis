import { KimiAdapterFacade } from './provider/kimi-adapter-facade';
import { getProviderService } from './provider/service';
import * as sessions from './session-store';

/**
 * Carries an Aegis task title over to its Kimi session, so the terminal and
 * the Kimi app list the session by the same name. Best-effort: only while the
 * Kimi server runs; nothing to do for other providers or unstarted tasks.
 */
export function syncKimiSessionTitle(sessionId: string, title: string): void {
  const session = sessions.getSession(sessionId);
  if (session?.provider !== 'kimi' || !session.kimi_session_id) return;
  const adapter = getProviderService().getAdapter('kimi');
  if (adapter instanceof KimiAdapterFacade) void adapter.syncTitle(session.kimi_session_id, title);
}

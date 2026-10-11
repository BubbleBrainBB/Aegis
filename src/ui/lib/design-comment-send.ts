import { useAppStore } from '../store/useAppStore';
import { isSessionEffectivelyBusy } from '../utils/workstream';
import type { Attachment, DesignPromptRef } from '../../shared/types';

/** Every provider gets the design tools; a draft or read-only chat has no agent to ask. */
export function canSendDesignComment(sessionId: string | null | undefined) {
  const session = sessionId ? useAppStore.getState().sessions[sessionId] : undefined;
  return !!session && !session.readOnly && !session.isDraft;
}

/**
 * Sends a design comment as its own turn through the session's composer, so
 * it goes with the provider, model and permissions the user picked there.
 * The transcript shows `prompt`; the model receives `effectivePrompt`. While a
 * turn runs it waits in the queue as its own item, keeping its thread link.
 */
export function sendDesignComment(input: {
  sessionId: string;
  prompt: string;
  effectivePrompt: string;
  attachments: Attachment[];
  design: DesignPromptRef;
}): 'sent' | 'queued' {
  const { sessionId, prompt, effectivePrompt, attachments, design } = input;
  if (!canSendDesignComment(sessionId)) throw new Error('Start the conversation before sending comments to the agent.');
  const session = useAppStore.getState().sessions[sessionId]!;
  const busy = session.status === 'running' || session.status === 'stopping'
    || session.permissionRequests.length > 0
    || isSessionEffectivelyBusy(session.status, session.messages);
  useAppStore.getState().requestChatInjection({
    sessionId, text: prompt, effectivePrompt, attachments, design, mode: 'append', submit: true, source: 'design-comment',
  });
  return busy ? 'queued' : 'sent';
}

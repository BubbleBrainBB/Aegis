import type { StreamMessage } from '../types';

/**
 * A prompt the user steered into a turn that was already running. It rides in
 * the turn's work group, whose code keys rows by `uuid` (a prompt has none).
 */
export type SteerPromptMessage = Extract<StreamMessage, { type: 'user_prompt' }> & { steer: true; uuid?: string };

/** A steered prompt, drawn in the trace at the point it joined the turn. */
export interface SteerEntry {
  id: string;
  type: 'steer';
  summary: string;
  detail?: never;
  attachmentCount: number;
}

export function isSteerPromptMessage(message: StreamMessage): message is SteerPromptMessage {
  return message.type === 'user_prompt' && message.steer === true;
}

export function steerEntry(message: SteerPromptMessage, index: number): SteerEntry {
  return {
    id: `steer:${message.promptId ?? `${message.createdAt ?? 0}:${index}`}`,
    type: 'steer',
    summary: message.prompt,
    attachmentCount: message.attachments?.length ?? 0,
  };
}

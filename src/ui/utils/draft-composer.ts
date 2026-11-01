import type { Attachment } from '../types';

/**
 * What a draft's composer holds while the draft is not on screen. Each draft
 * gets its own composer, so switching to another chat and back keeps what was
 * typed (and attached) there without it showing up in any other draft.
 */
export interface DraftComposerContent {
  prompt: string;
  attachments: Attachment[];
}

const saved = new Map<string, DraftComposerContent>();

export function saveDraftComposer(draftId: string, content: DraftComposerContent) {
  if (!content.prompt && content.attachments.length === 0) saved.delete(draftId);
  else saved.set(draftId, { prompt: content.prompt, attachments: [...content.attachments] });
}

/** The draft's unsent content, handed over once. */
export function takeDraftComposer(draftId: string): DraftComposerContent | undefined {
  const content = saved.get(draftId);
  saved.delete(draftId);
  return content;
}

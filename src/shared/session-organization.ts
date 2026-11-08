/** A state set by hand from the Change status menu; it holds until the task runs again. */
export type ManualTaskStatus = 'review' | 'completed';

export interface SessionOrganization {
  archived: boolean;
  unread: boolean;
  sectionId: string | null;
  manualStatus: ManualTaskStatus | null;
}

export interface SessionSection {
  id: string;
  name: string;
}

export interface SessionOrganizationSnapshot {
  sessions: Record<string, SessionOrganization>;
  sections: SessionSection[];
  projectSources: Record<string, string[]>;
}

export type SessionOrganizationChange =
  | { kind: 'archive'; sessionId: string; archived: boolean }
  | { kind: 'unread'; sessionId: string; unread: boolean }
  | { kind: 'section'; sessionId: string; sectionId: string | null }
  | { kind: 'status'; sessionId: string; status: ManualTaskStatus | null }
  | { kind: 'create-section'; sessionId: string; name: string }
  | { kind: 'rename-section'; sectionId: string; name: string }
  | { kind: 'remove-section'; sectionId: string };

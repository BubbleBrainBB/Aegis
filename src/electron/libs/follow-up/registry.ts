// Which sessions run a follow-up task. The runner asks before it offers the
// proposal tool, without depending on the service (which lives with IPC).

let check: (sessionId: string) => boolean = () => false;

export function setFollowUpSessionCheck(next: (sessionId: string) => boolean): void {
  check = next;
}

export function isFollowUpSession(sessionId: string): boolean {
  return check(sessionId);
}

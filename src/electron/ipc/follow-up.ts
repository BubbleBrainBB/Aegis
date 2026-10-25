import { ipcMainHandle } from '../util';
import type { FollowUpAction } from '../../shared/follow-up';
import type { FollowUpService } from '../libs/follow-up/service';

/** Typed IPC for follow-up proposals; changes are pushed as `follow-up.updated` server events. */
export function setupFollowUpIPC(service: FollowUpService): void {
  ipcMainHandle('follow-up-list', () => service.list());
  ipcMainHandle('follow-up-act', (_event, action: FollowUpAction) => service.act(action));
  ipcMainHandle('follow-up-continue-with-report', (_event, proposalId: string) => service.continueWithReport(proposalId));
  ipcMainHandle('follow-up-detach', (_event, childSessionId: string) => service.detach(childSessionId));
}

import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { confirmDialog } from '../components/ui/confirm-dialog';
import { sendEvent } from '../hooks/useIPC';
import { useAppStore } from '../store/useAppStore';
import { useSidebarViewStore } from '../store/useSidebarViewStore';
import { getProjectLabel } from './sidebar-view';

/** What a project's menus offer, wherever the project shows (My Tasks' Project filter, a row's project chip). */

function startDraftIn(path: string, channelId: string) {
  const app = useAppStore.getState();
  app.setProjectCwd(path);
  app.setActiveChannelForProject(path, channelId);
  app.setActiveWorkspace('chat');
  app.setChatSidebarView('threads');
  app.setShowSettings(false);
  app.openDraftSession(path, channelId);
}

export function newTaskInProject(path: string) {
  const channels = useAppStore.getState().activeChannelByProject;
  startDraftIn(path, channels[path.trim() || '__no_project__'] || DEFAULT_WORKSPACE_CHANNEL_ID);
}

/** Pick a folder and start a task there: a project exists once it has one. */
export async function addProject() {
  const selected = await window.electron.selectDirectory();
  if (selected) startDraftIn(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
}

export function revealProject(path: string) {
  void window.electron.revealPath(path);
}

/** Show only this project's tasks on My Tasks. */
export function filterTasksByProject(path: string | null) {
  useSidebarViewStore.getState().setOption('project', path);
  if (path) useAppStore.getState().setProjectCwd(path);
}

// A project is not stored on its own (its tasks make it), so removing it
// deletes its tasks. External read-only sessions (claude_remote) stay.
export async function removeProject(path: string) {
  const { sessions, projectCwd, setProjectCwd } = useAppStore.getState();
  const tasks = Object.values(sessions).filter(
    (session) =>
      !session.hiddenFromThreads &&
      session.scope !== 'dm' &&
      !session.isChat &&
      !session.isDraft &&
      (session.projectCwd || session.cwd)?.trim() === path
  );
  const deletable = tasks.filter((session) => session.source !== 'claude_remote');
  const remoteCount = tasks.length - deletable.length;

  if (deletable.length > 0) {
    const details = [
      deletable.length === 1
        ? 'This permanently deletes its 1 conversation.'
        : `This permanently deletes all ${deletable.length} conversations in it, archived ones too.`,
    ];
    if (deletable.some((session) => session.status === 'running')) {
      details.push('Running tasks will be stopped.');
    }
    if (remoteCount > 0) {
      details.push(
        `${remoteCount} external Claude ${remoteCount === 1 ? 'session is' : 'sessions are'} read-only and will stay.`
      );
    }
    const confirmed = await confirmDialog({
      title: `Remove ${getProjectLabel(path)}?`,
      description: details.join(' '),
      confirmLabel: 'Remove project',
    });
    if (!confirmed) return;
    for (const session of deletable) {
      sendEvent({ type: 'session.delete', payload: { sessionId: session.id } });
    }
  }

  // A selected project stays listed; clearing the selection lets it go.
  if (projectCwd?.trim() === path) setProjectCwd(null);
  if (useSidebarViewStore.getState().project === path) useSidebarViewStore.getState().setOption('project', null);
}

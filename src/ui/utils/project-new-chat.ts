import { useAppStore } from '../store/useAppStore';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';

/** Open a local New chat, retaining an existing unsent draft when switching projects. */
export function openProjectNewChat(cwd: string, sourceSessionId?: string | null) {
  const dir = cwd.trim();
  const state = useAppStore.getState();
  if (!dir || state.pendingStart) return;
  const source = sourceSessionId ? state.sessions[sourceSessionId] : undefined;
  if (source?.status === 'running') return;
  if (source && (source.projectCwd || source.cwd) === dir) return;

  if (source?.isDraft && source.messages.length === 0) {
    // Keep the session identity so the mounted composer retains its text,
    // attachments, model selection and goal draft.
    useAppStore.setState((current) => ({
      sessions: {
        ...current.sessions,
        [source.id]: {
          ...current.sessions[source.id],
          cwd: dir,
          projectCwd: dir,
          channelId: current.activeChannelByProject[dir]?.trim() || DEFAULT_WORKSPACE_CHANNEL_ID,
          envMode: 'local',
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          updatedAt: Date.now(),
        },
      },
      draftStartMode: { ...current.draftStartMode, [source.id]: 'local' },
    }));
    state.setProjectCwd(dir);
    return source.id;
  }

  state.setProjectCwd(dir);
  state.setChatSidebarView('threads');
  state.setSidebarSearchQuery('');
  const draftId = state.createDraftSession(dir, null, { projectCwd: dir });
  return draftId;
}

/** Turn an unsent draft into a chat with no project; the last project stays the default for New Task. */
export function openNoProjectChat(sourceSessionId?: string | null) {
  const state = useAppStore.getState();
  if (state.pendingStart || !sourceSessionId) return;
  const source = state.sessions[sourceSessionId];
  if (!source?.isDraft || source.messages.length > 0 || !(source.projectCwd || source.cwd)) return;
  useAppStore.setState((current) => ({
    sessions: {
      ...current.sessions,
      [source.id]: {
        ...current.sessions[source.id],
        cwd: '',
        projectCwd: null,
        channelId: DEFAULT_WORKSPACE_CHANNEL_ID,
        envMode: 'local',
        worktreePath: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        updatedAt: Date.now(),
      },
    },
    draftStartMode: { ...current.draftStartMode, [source.id]: 'local' },
  }));
  return source.id;
}

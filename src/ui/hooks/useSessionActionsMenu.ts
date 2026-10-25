import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { confirmDialog } from '../components/ui/confirm-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from './useIPC';
import type { SessionView } from '../types';
import type { SessionMenuAction, SessionMenuItem } from '../../shared/session-menu';

import { textInputDialog } from '../components/ui/text-input-dialog';
import { useSessionOrganization, changeSessionOrganization } from '../store/useSessionOrganizationStore';
import { findProposalForChild, nestedSessionIds, subSessionParents, useFollowUpStore } from '../store/useFollowUpStore';
import type { EnvironmentEditorLauncher } from '../../shared/types';

let launcherRequest: Promise<EnvironmentEditorLauncher[]> | undefined;
type WorktreeAction = 'move' | 'apply' | 'discard';
// Both entry points observe the same pending state, including split panes.
const useMenuPending = create<{ actions: Record<string, WorktreeAction | undefined> }>(() => ({ actions: {} }));

export function useSessionActionsMenu(session: SessionView) {
  const organization = useSessionOrganization();
  const metadata = organization.sessions[session.id];
  const sessions = useAppStore(s => s.sessions);
  const projectCwd = useAppStore(s => s.projectCwd);
  const projectIdentity = (cwd: string) => organization.projectSources?.[cwd]?.[0] || cwd;
  const projects = [...new Set([projectCwd, ...Object.values(organization.projectSources ?? {}).map(roots => roots[0]), ...Object.values(sessions).filter(s => !s.hiddenFromThreads && s.scope !== 'dm').map(s => s.projectCwd || s.cwd)].filter((p): p is string => Boolean(p)).map(projectIdentity))].slice(0, 250);
  const [launchers, setLaunchers] = useState<EnvironmentEditorLauncher[]>([]);
  useEffect(() => {
    if (!window.electron?.getEnvironmentEditorLaunchers) return;
    let alive = true;
    launcherRequest ??= window.electron.getEnvironmentEditorLaunchers().catch(() => { launcherRequest = undefined; return []; });
    void launcherRequest.then(items => { if (alive) setLaunchers(items.filter(item => item.available)); });
    return () => { alive = false; };
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const worktreeAction = useMenuPending(s => s.actions[session.id] ?? null);
  const setWorktreeAction = (action: WorktreeAction | null) => useMenuPending.setState(s => {
    const actions = { ...s.actions };
    if (action) actions[session.id] = action;
    else delete actions[session.id];
    return { actions };
  });
  const forkSessionToPane = useAppStore(s => s.forkSessionToPane);
  const createDraftSession = useAppStore(s => s.createDraftSession);
  const inWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  const providerSupportsFork = ['claude', 'codex', 'opencode', 'kimi'].includes(session.provider ?? 'claude');
  const canFork = !session.isDraft && !(session.provider === 'kimi' && session.status === 'running');
  const canChangeWorktree = !session.isDraft && session.status !== 'running' && !worktreeAction;

  const handleNewInWorktree = () => {
    if (!session.worktreePath) return;
    createDraftSession(session.worktreePath, session.channelId || null, {
      title: `New Chat - ${session.associatedWorktreeBranch || 'Worktree'}`,
      projectCwd: session.projectCwd ?? null,
      envMode: 'worktree',
      worktreePath: session.worktreePath,
      associatedWorktreePath: session.worktreePath,
      associatedWorktreeBranch: session.associatedWorktreeBranch ?? null,
      associatedWorktreeRef: session.associatedWorktreeRef ?? null,
    });
  };

  const handleMoveToWorktree = () => {
    void (async () => {
      setWorktreeAction('move');
      const toastId = toast.loading('Moving thread into a new worktree…');
      try {
        const result = await window.electron.moveSessionToWorktree(session.id);
        if (result.ok) {
          toast.success('Thread moved into a new worktree — changes stay on its own branch.', {
            id: toastId,
          });
        } else {
          toast.error(result.message || 'Could not move the thread into a worktree.', {
            id: toastId,
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
      } finally {
        setWorktreeAction(null);
      }
    })();
  };

  // Other conversations working in this worktree: they move back to the project with it.
  const worktreeSharers = () =>
    session.worktreePath
      ? Object.values(useAppStore.getState().sessions).filter(
          other => other.id !== session.id && !other.isDraft && other.envMode === 'worktree' && other.worktreePath === session.worktreePath,
        )
      : [];
  const sharersNote = (sharers: SessionView[], what: string) => {
    if (!sharers.length) return '';
    const names = sharers.slice(0, 3).map(other => `“${other.title}”`).join(', ') + (sharers.length > 3 ? ` and ${sharers.length - 3} more` : '');
    return ` ${names} also ${sharers.length === 1 ? 'works' : 'work'} in this worktree: ${what}`;
  };

  const handleApplyWorktree = () => {
    void (async () => {
      const sharers = worktreeSharers();
      if (sharers.length) {
        const confirmed = await confirmDialog({
          title: 'Squash-merge this worktree into the project?',
          description: `The worktree is removed afterwards.${sharersNote(sharers, `${sharers.length === 1 ? 'its' : 'their'} changes are merged too, and ${sharers.length === 1 ? 'it moves' : 'they move'} back to the project.`)}`,
          confirmLabel: 'Squash-merge',
        });
        if (!confirmed) return;
      }
      setWorktreeAction('apply');
      const toastId = toast.loading('Squash-merging worktree changes into the project…');
      try {
        const applied = await window.electron.applyWorktreeChanges(session.id);
        if (applied.ok) {
          toast.success('Squash-merged — changes are staged in your project for review.', {
            id: toastId,
          });
        } else {
          toast.error(applied.message || 'Squash-merge failed.', { id: toastId });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
      } finally {
        setWorktreeAction(null);
      }
    })();
  };

  const handleDiscardWorktree = () => {
    // confirm 推迟到菜单关闭之后，避免弹窗和菜单抢焦点
    window.setTimeout(() => {
      const branchName = session.associatedWorktreeBranch;
      void (async () => {
        const sharers = worktreeSharers();
        const confirmed = await confirmDialog({
          title: branchName ? `Remove this worktree and branch ${branchName}?` : 'Remove this worktree?',
          description: `All uncommitted changes in it are lost. The conversation stays.${sharersNote(sharers, `${sharers.length === 1 ? 'its' : 'their'} changes are lost too, and ${sharers.length === 1 ? 'it moves' : 'they move'} back to the project.`)}`,
          confirmLabel: 'Remove worktree',
        });
        if (!confirmed) {
          return;
        }
        setWorktreeAction('discard');
        try {
          const discarded = await window.electron.discardWorktreeChanges(session.id);
          if (discarded.ok) {
            toast.success('Worktree removed — thread is back on the project.');
          } else {
            toast.error(discarded.message || 'Could not remove the worktree.');
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setWorktreeAction(null);
        }
      })();
    }, 0);
  };

  const handleDelete = () => {
    window.setTimeout(() => {
      void (async () => {
        const detail = session.status === 'running' ? ' The running task will be stopped.' : '';
        const confirmed = await confirmDialog({
          title: `Delete ${session.title}?`,
          description: `This permanently removes the conversation.${detail}`,
          confirmLabel: 'Delete conversation',
        });
        if (confirmed) {
          sendEvent({ type: 'session.delete', payload: { sessionId: session.id } });
        }
      })();
    }, 0);
  };

  const editable = !session.isDraft;
  const nestedParentId = useFollowUpStore(s => subSessionParents(s.proposals).get(session.id) ?? null);
  // A sub-session in its parent's worktree: the worktree is the parent's to apply or discard.
  const sharesParentWorktree = useFollowUpStore(s => findProposalForChild(s.proposals, session.id)?.place === 'shared') && inWorktree;
  const items: SessionMenuItem[] = [
    { id: 'rename', label: 'Rename…', icon: 'rename', enabled: session.source !== 'claude_remote' },
    { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
    { id: 'unread', label: metadata?.unread || session.runtimeNotice ? 'Mark as read' : 'Mark as unread', icon: 'unread', enabled: editable },
    { id: 'archive', label: metadata?.archived ? 'Unarchive' : 'Archive', icon: 'archive', enabled: editable && session.status !== 'running' },
    ...(nestedParentId ? [{ id: 'detach' as const, label: 'Detach from parent', icon: 'fork' as const }] : []),
    { type: 'separator' },
    { label: 'Project', icon: 'folder', enabled: editable && session.source !== 'claude_remote' && canChangeWorktree && !inWorktree, submenu: [
      ...projects.map((cwd, i): SessionMenuItem => ({ id: `project:${i}`, label: cwd.length > 115 ? '…' + cwd.slice(-114) : cwd, icon: 'folder', checked: cwd === projectIdentity(session.projectCwd || session.cwd || '') })),
      { id: 'project-choose', label: 'Choose folder…', icon: 'folder' },
    ] },
    { label: 'Section', icon: 'section', enabled: editable, submenu: [
      { id: 'section-none', label: 'None', icon: 'section', checked: !metadata?.sectionId },
      ...organization.sections.slice(0, 250).map((section, i): SessionMenuItem => ({ id: `section:${i}`, label: section.name, icon: 'section', checked: metadata?.sectionId === section.id })),
      { type: 'separator' },
      { id: 'section-new', label: 'New section…', icon: 'section' },
    ] },
    { type: 'separator' },
    { label: 'Share', icon: 'share', enabled: editable, submenu: [
      { id: 'export', label: 'Export Markdown…', icon: 'copy' },
      { id: 'share', label: 'Export and share…', icon: 'share' },
    ] },
    { label: 'Copy', icon: 'copy', submenu: [
      { id: 'copy-link', label: 'Conversation link', icon: 'link', enabled: !session.isDraft },
      { id: 'copy-cwd', label: 'Working directory', icon: 'folder', enabled: Boolean(session.cwd) },
      { id: 'copy-markdown', label: 'Conversation as Markdown', icon: 'copy', enabled: editable },
    ] },
    { type: 'separator' },
    ...(providerSupportsFork ? [{ label: 'Fork', icon: 'fork' as const, enabled: canFork && !worktreeAction, submenu: [
      { id: 'fork-local' as const, label: inWorktree ? 'This worktree' : 'Local', icon: 'fork' as const },
      { id: 'fork-worktree' as const, label: 'New worktree', icon: 'worktree' as const, enabled: !inWorktree },
      { id: 'fork' as const, label: 'New pane', icon: 'window' as const },
    ] }] : []),
    { type: 'separator' },
    ...(launchers.length ? [{ label: 'Open in', icon: 'folder' as const, enabled: Boolean(session.cwd), submenu: launchers.map((editor, i): SessionMenuItem => ({ id: `editor:${i}`, label: editor.label, icon: 'window' })) }] : []),
    { id: 'open-window', label: 'Open in new window', icon: 'window', enabled: editable },
    { label: 'Worktree', icon: 'worktree', submenu: inWorktree ? [
      { id: 'new-worktree-thread', label: 'New thread in this worktree', icon: 'worktree', enabled: !worktreeAction },
      { id: 'apply-worktree', label: 'Squash-merge back into project', icon: 'apply', enabled: canChangeWorktree && !sharesParentWorktree },
      { id: 'discard-worktree', label: 'Discard worktree…', icon: 'trash', enabled: canChangeWorktree && !sharesParentWorktree },
    ] : [
      { id: 'move-worktree', label: worktreeAction === 'move' ? 'Moving into a new worktree…' : 'Move into a new worktree', icon: 'worktree', enabled: canChangeWorktree },
    ] },
    { type: 'separator' },
    { id: 'delete', label: 'Delete…', icon: 'trash', enabled: !worktreeAction },
  ];

  const execute = async (action: SessionMenuAction) => {
    if (action === 'copy-link' || action === 'copy-cwd') {
      const target = action === 'copy-link' ? 'link' : 'cwd';
      if (session.isDraft && target === 'cwd' && session.cwd) await navigator.clipboard.writeText(session.cwd);
      else await window.electron.copySessionValue(session.id, target);
      toast.success(target === 'link' ? 'Conversation link copied' : 'Working directory copied');
      return;
    }
    if (action.startsWith('project:') || action === 'project-choose') {
      const cwd = action === 'project-choose' ? await window.electron.selectDirectory() : projects[Number(action.split(':')[1])];
      if (cwd && cwd !== (session.projectCwd || session.cwd)) {
        // A hot-reloaded renderer can still be connected to the old main process,
        // whose move handler mutates immediately and returns no preview.
        const snapshot = await window.electron.getSessionOrganization();
        if (!snapshot.projectSources) throw new Error('Restart Aegis to enable project folders before moving this conversation.');
        let result = await window.electron.moveSessionProject(session.id, cwd);
        while (result.status === 'needs-confirmation') {
          const projectName = result.projectCwd.split(/[\\/]/).filter(Boolean).pop() || result.projectCwd;
          const confirmed = await confirmDialog({
            title: `Add folders to ${projectName}?`,
            description: `All chats in ${projectName} will gain access to these folders:`,
            folders: result.missingSources,
            confirmLabel: 'Continue',
            tone: 'default',
          });
          if (!confirmed) return;
          result = await window.electron.moveSessionProject(session.id, result.projectCwd, result.approvalToken);
        }
        if (result.status === 'unchanged') return;
        toast.success('Conversation moved to project');
      }
      return;
    }
    if (action.startsWith('section:') || action === 'section-none') {
      await changeSessionOrganization({ kind: 'section', sessionId: session.id, sectionId: action === 'section-none' ? null : organization.sections[Number(action.split(':')[1])].id });
      return;
    }
    if (action.startsWith('editor:')) {
      const result = await window.electron.openInEditor({ cwd: session.cwd!, editorId: launchers[Number(action.split(':')[1])].id });
      if (!result.ok) throw new Error(result.message || 'Could not open application');
      return;
    }
    switch (action) {
      case 'rename': {
        const title = await textInputDialog({ title: 'Rename conversation', label: 'Conversation title', value: session.title });
        if (title && title !== session.title) await useAppStore.getState().renameSession(session.id, title);
        break;
      }
      case 'unread': {
        const unread = !(metadata?.unread || session.runtimeNotice);
        await changeSessionOrganization({ kind: 'unread', sessionId: session.id, unread });
        useAppStore.setState(s => ({ sessions: { ...s.sessions, [session.id]: { ...s.sessions[session.id], runtimeNotice: undefined } } }));
        break;
      }
      case 'archive': {
        const archived = !metadata?.archived;
        // Sub-sessions nested under this one follow it in and out of the archive.
        const nested = nestedSessionIds(subSessionParents(useFollowUpStore.getState().proposals), session.id)
          .filter(id => sessions[id] && Boolean(organization.sessions[id]?.archived) !== archived);
        if (archived && nested.length) {
          const running = nested.filter(id => sessions[id]?.status === 'running');
          if (running.length) {
            const names = running.map(id => `“${sessions[id].title}”`).join(', ');
            const confirmed = await confirmDialog({
              title: `Archive “${session.title}” and its ${nested.length} sub-session${nested.length === 1 ? '' : 's'}?`,
              description: `${names} ${running.length === 1 ? 'is' : 'are'} still running and will be stopped. Changes in worktrees are kept.`,
              confirmLabel: 'Archive all',
            });
            if (!confirmed) break;
            for (const id of running) sendEvent({ type: 'session.stop', payload: { sessionId: id } });
          }
        }
        for (const id of [session.id, ...nested]) await changeSessionOrganization({ kind: 'archive', sessionId: id, archived });
        if (archived && useAppStore.getState().activeSessionId === session.id) useAppStore.getState().setShowNewSession(true);
        break;
      }
      case 'detach': {
        const result = await useFollowUpStore.getState().detach(session.id);
        if (!result.ok && result.error) toast.error(result.error);
        break;
      }
      case 'section-new': {
        const name = await textInputDialog({ title: 'New section', label: 'Section name', maxLength: 80 });
        if (name) await changeSessionOrganization({ kind: 'create-section', sessionId: session.id, name });
        break;
      }
      case 'copy-markdown': await window.electron.copySessionMarkdown(session.id); toast.success('Conversation copied'); break;
      case 'open-window': await window.electron.openSessionWindow(session.id); break;
      case 'export': case 'share': await window.electron.exportSessionMarkdown(session.id, action === 'share'); break;
      case 'fork-local': await forkSessionToPane(session.id, 'local'); break;
      case 'fork-worktree': await forkSessionToPane(session.id, 'worktree'); break;
      case 'pin': sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } }); break;
      case 'fork': await forkSessionToPane(session.id); break;
      case 'new-worktree-thread': handleNewInWorktree(); break;
      case 'move-worktree': handleMoveToWorktree(); break;
      case 'apply-worktree': handleApplyWorktree(); break;
      case 'discard-worktree': handleDiscardWorktree(); break;
      case 'delete': handleDelete(); break;
    }
  };

  const openMenu = async (position?: { x: number; y: number }) => {
    if (menuOpen) return;
    setMenuOpen(true);
    try {
      const action = await window.electron.showSessionMenu({ items, position });
      if (action) await execute(action);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open conversation menu');
    } finally {
      setMenuOpen(false);
    }
  };
  return { openMenu, menuOpen, worktreeAction };
}

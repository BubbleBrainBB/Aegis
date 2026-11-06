import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useSidebarViewStore } from '../../store/useSidebarViewStore';
import { getProjectLabel, listWorkspaceProjects } from '../../utils/sidebar-view';
import { FolderClosed, FolderOpen, MoreHorizontal, SquarePen, Trash2 } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import { confirmDialog } from '../ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

// No width until the row is hovered or focused, so a long name gets the whole row.
const ROW_ACTION_CLASS =
  'no-drag flex h-6 w-0 flex-shrink-0 items-center justify-center overflow-hidden text-[var(--text-muted)] opacity-0 transition-opacity duration-150 hover:text-[var(--text-primary)] group-hover/project:w-6 group-hover/project:opacity-100 group-focus-within/project:w-6 group-focus-within/project:opacity-100';

/** The sidebar's projects: each opens My Tasks narrowed to that project. */
export function SidebarWorkspaceProjects({
  onOpenProject,
  onNewTask,
}: {
  onOpenProject: (path: string) => void;
  onNewTask: (path: string) => void;
}) {
  const sessions = useAppStore((state) => state.sessions);
  const projectCwd = useAppStore((state) => state.projectCwd);
  const setProjectCwd = useAppStore((state) => state.setProjectCwd);
  const showingTasks = useAppStore((state) => state.activeWorkspace === 'tasks' && !state.showSettings);
  const viewProject = useSidebarViewStore((state) => state.project);
  const setViewOption = useSidebarViewStore((state) => state.setOption);

  const projects = useMemo(
    () => listWorkspaceProjects(Object.values(sessions), projectCwd),
    [sessions, projectCwd]
  );

  // 项目本身不是持久实体（由 session 分组推导），"移除项目"= 删除它的全部 task；
  // 外部只读会话（claude_remote）删不掉，保留并提示
  const removeProject = async (path: string) => {
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

    // 选中的项目会一直留在列表里，清掉选中态它才会真正消失
    if (projectCwd?.trim() === path) setProjectCwd(null);
    if (viewProject === path) setViewOption('project', null);
  };

  if (projects.length === 0) {
    return <div className="px-2 py-1 text-[13px] text-[var(--text-muted)]">No projects yet</div>;
  }

  return (
    <div className="space-y-px">
      {projects.map((path) => {
        const label = getProjectLabel(path);
        const active = showingTasks && viewProject === path;
        return (
          <div
            key={path}
            data-workspace-project={path}
            className={`group/project flex h-7 items-center rounded-md pr-1 transition-colors duration-150 has-[button[data-popup-open]]:bg-[var(--sidebar-item-hover)] ${
              active
                ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            <button
              type="button"
              aria-current={active ? 'page' : undefined}
              title={path}
              onClick={(event) => {
                onOpenProject(path);
                event.currentTarget.blur();
              }}
              className="no-drag flex h-full min-w-0 flex-1 items-center gap-2 pl-2 pr-1 text-left"
            >
              <FolderClosed className="h-[15px] w-[15px] flex-shrink-0" strokeWidth={1.5} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-normal">{label}</span>
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className={`${ROW_ACTION_CLASS} data-[popup-open]:w-6 data-[popup-open]:text-[var(--text-primary)] data-[popup-open]:opacity-100`}
                    title={`Options for ${label}`}
                    aria-label={`Options for ${label}`}
                  />
                }
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]">
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => void window.electron.revealPath(path)}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Show in Finder</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 cursor-pointer text-[var(--error)]" onSelect={() => void removeProject(path)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              className={ROW_ACTION_CLASS}
              title={`New task in ${label}`}
              aria-label={`New task in ${label}`}
              onClick={() => onNewTask(path)}
            >
              <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
          </div>
        );
      })}
    </div>
  );
}


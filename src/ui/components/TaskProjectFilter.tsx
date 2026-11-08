import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import { Menu } from '@base-ui-components/react/menu';
import { Check, ChevronDown, Filter, FolderOpen, MoreHorizontal, Plus, Search, SquarePen, Trash2 } from './icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { useSessionOrganizationStore } from '../store/useSessionOrganizationStore';
import { useSidebarViewStore } from '../store/useSidebarViewStore';
import { getProjectLabel, listWorkspaceProjects } from '../utils/sidebar-view';
import { addProject, filterTasksByProject, newTaskInProject, removeProject, revealProject } from '../utils/project-actions';

const ITEM_CLASS = 'gap-2 rounded-md px-2 py-1.5 text-[13px]';

/** Show in Finder and Remove, for a project's … button. */
function ProjectMoreItems({ path }: { path: string }) {
  return (
    <>
      <DropdownMenuItem className={ITEM_CLASS} onSelect={() => revealProject(path)}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span>Show in Finder</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={`${ITEM_CLASS} text-[var(--error)]`} onSelect={() => void removeProject(path)}>
        <Trash2 className="h-3.5 w-3.5" />
        <span>Remove project…</span>
      </DropdownMenuItem>
    </>
  );
}

/**
 * My Tasks' Project filter: one project, or all of them. It is also where
 * projects are managed now that the sidebar lists tasks: start a task in
 * one, show it in Finder, remove it, or add a folder.
 */
export function TaskProjectFilter() {
  const project = useSidebarViewStore((state) => state.project);
  const sessions = useAppStore((state) => state.sessions);
  const projectCwd = useAppStore((state) => state.projectCwd);
  const archived = useSessionOrganizationStore((state) => state.sessions);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { projects, counts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of Object.values(sessions)) {
      if (session.hiddenFromThreads || session.scope === 'dm' || session.isChat || session.isDraft || archived[session.id]?.archived) continue;
      const path = (session.projectCwd || session.cwd)?.trim();
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    const projects = listWorkspaceProjects(Object.values(sessions), project ?? projectCwd);
    return { projects, counts };
  }, [sessions, archived, project, projectCwd]);

  const needle = query.trim().toLowerCase();
  const matches = needle ? projects.filter((path) => getProjectLabel(path).toLowerCase().includes(needle)) : projects;
  // All projects leads the list until you search.
  const choices: (string | null)[] = needle ? matches : [null, ...matches];
  const pick = (path: string | null) => {
    filterTasksByProject(path);
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery('');
        setHighlight(0);
      }}
    >
      <Popover.Trigger
        className={`no-drag inline-flex h-7 max-w-[240px] flex-shrink-0 items-center gap-1.5 rounded-full border pl-2.5 pr-2 text-[13px] transition-colors duration-150 ${
          project
            ? 'border-transparent bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[popup-open]:bg-[var(--sidebar-item-hover)]'
        }`}
        aria-label={project ? `Project: ${getProjectLabel(project)}` : 'Project: all'}
        title={project ?? undefined}
        data-task-project-filter
      >
        <span className="min-w-0 truncate">{project ? getProjectLabel(project) : 'Project'}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-[9998]">
          <Popover.Popup
            aria-label="Projects"
            initialFocus={inputRef}
            className="popover-surface flex w-[300px] flex-col text-left"
            data-task-project-menu
          >
            <label className="flex h-9 items-center gap-2 border-b border-[var(--border)] px-3 text-[var(--text-muted)]">
              <Search className="h-3.5 w-3.5 flex-shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlight(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    setHighlight((index) => (index + step + choices.length) % Math.max(choices.length, 1));
                  } else if (event.key === 'Enter' && choices.length) {
                    event.preventDefault();
                    pick(choices[Math.min(highlight, choices.length - 1)]);
                  }
                }}
                placeholder="Filter projects…"
                aria-label="Filter projects"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </label>
            <div className="sidebar-scrollbar flex max-h-[320px] flex-col gap-px overflow-y-auto p-1.5" role="listbox" aria-label="Projects">
              {choices.map((path, index) => (
                <ProjectChoice
                  key={path ?? '__all__'}
                  path={path}
                  count={path ? counts.get(path) ?? 0 : null}
                  selected={path === project}
                  highlighted={index === highlight}
                  onHover={() => setHighlight(index)}
                  onPick={() => pick(path)}
                  onLeave={() => setOpen(false)}
                  divider={!needle && path === null && matches.length > 0}
                />
              ))}
              {needle && matches.length === 0 ? (
                <div className="px-2 py-1.5 text-[13px] text-[var(--text-muted)]">No matching projects</div>
              ) : null}
            </div>
            <div className="border-t border-[var(--border)] p-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void addProject();
                }}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add project…</span>
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProjectChoice({
  path,
  count,
  selected,
  highlighted,
  divider,
  onHover,
  onPick,
  onLeave,
}: {
  path: string | null;
  count: number | null;
  selected: boolean;
  highlighted: boolean;
  divider: boolean;
  onHover: () => void;
  onPick: () => void;
  /** Close the filter before going somewhere else. */
  onLeave: () => void;
}) {
  const label = path ? getProjectLabel(path) : 'All projects';
  return (
    <>
      <div
        role="option"
        aria-selected={selected}
        data-project-choice={path ?? ''}
        onMouseEnter={onHover}
        onClick={onPick}
        title={path ?? undefined}
        className={`group/project flex h-7 cursor-pointer items-center gap-2 rounded-md pl-2 pr-1 text-[13px] text-[var(--text-primary)] ${
          highlighted ? 'bg-[var(--sidebar-item-hover)]' : ''
        } has-[button[data-popup-open]]:bg-[var(--sidebar-item-hover)]`}
      >
        <span className="flex w-3.5 flex-shrink-0 justify-center">{selected ? <Check className="h-3.5 w-3.5" /> : null}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {path ? (
          <span className="flex items-center">
            <span className="px-1 text-[12px] tabular-nums text-[var(--text-muted)] group-hover/project:hidden group-has-[button[data-popup-open]]/project:hidden">
              {count}
            </span>
            <span className="hidden items-center group-hover/project:flex group-has-[button[data-popup-open]]/project:flex">
              <RowAction
                label={`New task in ${label}`}
                onClick={() => {
                  onLeave();
                  newTaskInProject(path);
                }}
              >
                <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
              </RowAction>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      onClick={(event) => event.stopPropagation()}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] data-[popup-open]:text-[var(--text-primary)]"
                      aria-label={`Options for ${label}`}
                      title={`Options for ${label}`}
                    />
                  }
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]" onClick={(event) => event.stopPropagation()}>
                  <ProjectMoreItems path={path} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </span>
        ) : null}
      </div>
      {divider ? <div className="-mx-1.5 my-1 h-px bg-[var(--border)]" /> : null}
    </>
  );
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * A task row's project, as quiet as its date until the pointer is on it: a
 * click shows only that project, a right click offers what the project's row
 * in the filter does.
 */
export function ProjectChip({ path }: { path: string }) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const label = getProjectLabel(path);
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="no-drag inline-flex h-6 max-w-[180px] flex-shrink-0 items-center rounded-md px-1.5 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[menu-open]:bg-[var(--sidebar-item-hover)]"
        data-menu-open={menuOpen ? '' : undefined}
        title={`Show only ${label}`}
        data-task-project
        onClick={(event) => {
          event.stopPropagation();
          filterTasksByProject(path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
        }}
      >
        <span className="truncate">{label}</span>
      </button>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Portal>
          <Menu.Positioner anchor={chipRef} side="bottom" align="end" sideOffset={4} className="z-[9999]">
            <Menu.Popup className="popover-surface min-w-[220px] p-1.5" onClick={(event) => event.stopPropagation()} data-project-chip-menu>
              <DropdownMenuItem className={ITEM_CLASS} onSelect={() => filterTasksByProject(path)}>
                <Filter className="h-3.5 w-3.5" />
                <span className="truncate">Show only {label}</span>
              </DropdownMenuItem>
              <DropdownMenuItem className={ITEM_CLASS} onSelect={() => newTaskInProject(path)}>
                <SquarePen className="h-3.5 w-3.5" />
                <span>New task here</span>
              </DropdownMenuItem>
              <ProjectMoreItems path={path} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}

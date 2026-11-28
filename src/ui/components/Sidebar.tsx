import { shortcutLabel } from '../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../store/useAppPreferences';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  GitPullRequest,
  Home,
  Palette,
  HomeFilled,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  Pin,
  PinFilled,
  Script,
  Search,
  SquarePen,
  Clock,
} from './icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { openTask } from '../utils/task-state';
import { MAIN_BOT_NAME } from '../../shared/main-bot';
import { toggleSidebar, useSidebarCollapsed } from '../store/sidebar-collapse';
import { SearchPalette } from './search/SearchPalette';
import type {
  PaletteAction,
  PaletteProject,
  PaletteThread,
} from './search/palette-ranking';
import { CappedScrollbar } from './CappedScrollbar';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { getMessageContentBlocks } from '../utils/message-content';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../utils/sidebar-width';
import { SessionHistoryButtons } from './SessionHistoryButtons';
import { SidebarProfileMenu } from './sidebar/SidebarProfileMenu';
import { SidebarActiveTasks } from './sidebar/SidebarActiveTasks';
import { SettingsNavPanel } from './settings/Settings';
import { SidebarUpdateButton } from './sidebar/SidebarUpdateButton';
import { SidebarUsageButton } from './sidebar/SidebarUsageMenu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { isPinnableRailSection, useRailPinsStore, type PinnableRailSection } from '../store/useRailPinsStore';
import { useSessionOrganization } from '../store/useSessionOrganizationStore';
import { useSidebarViewStore } from '../store/useSidebarViewStore';
import { useWorkflowRunningSessions, useWorkflowWaitingSessions } from '../store/useWorkflowStore';
import { deriveSidebarSessionState } from '../utils/sidebar-view';

const SIDEBAR_TRIGGER_CLASS =
  'no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] active:scale-95';
function SidebarToggleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 ${className ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="16" x="3" y="4" rx="4" />
      <path d="M9 4v16" />
    </svg>
  );
}

function SidebarToggleButton({
  collapsed,
  className = '',
  onClick,
}: {
  collapsed: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-sidebar-trigger=""
      onClick={onClick}
      className={`${SIDEBAR_TRIGGER_CLASS} ${className}`}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <SidebarToggleIcon />
      <span className="sr-only">Toggle sidebar</span>
    </button>
  );
}

/**
 * Sidebar toggle and Back/Forward, Codex-style, right of the traffic lights.
 * Settings shows only Back/Forward.
 * The sidebar's top row hosts them while it is open; a collapsed sidebar
 * hands them to the main column's top row.
 */
export function TitlebarControls() {
  const sidebarCollapsed = useSidebarCollapsed();
  const showSettings = useAppStore((state) => state.showSettings);

  return (
    <div className="no-drag flex flex-shrink-0 items-center gap-0.5" data-titlebar-controls>
      {showSettings ? null : (
        <SidebarToggleButton
          collapsed={sidebarCollapsed}
          onClick={toggleSidebar}
        />
      )}
      <SessionHistoryButtons />
    </div>
  );
}

const EMPTY_PALETTE_PROJECTS: PaletteProject[] = [];
const EMPTY_PALETTE_THREADS: PaletteThread[] = [];

export function Sidebar() {
  const {
    activeSessionId,
    sidebarWidth,
    projectCwd,
    activeChannelByProject,
    sessions,
    activeWorkspace,
    setSidebarWidth,
    setChatSidebarView,
    setProjectCwd,
    setActiveChannelForProject,
    setActiveWorkspace,
    showNewSession,
    mainBotSessionId,
    setMainBotSessionId,
    openMainBot,
    showSettings,
    setShowSettings,
    openDraftSession,
    searchPaletteOpen,
    setSearchPaletteOpen,
  } = useAppStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      sidebarWidth: s.sidebarWidth,
      projectCwd: s.projectCwd,
      activeChannelByProject: s.activeChannelByProject,
      sessions: s.sessions,
      activeWorkspace: s.activeWorkspace,
      setSidebarWidth: s.setSidebarWidth,
      setChatSidebarView: s.setChatSidebarView,
      setProjectCwd: s.setProjectCwd,
      setActiveChannelForProject: s.setActiveChannelForProject,
      setActiveWorkspace: s.setActiveWorkspace,
      showNewSession: s.showNewSession,
      mainBotSessionId: s.mainBotSessionId,
      setMainBotSessionId: s.setMainBotSessionId,
      openMainBot: s.openMainBot,
      showSettings: s.showSettings,
      setShowSettings: s.setShowSettings,
      openDraftSession: s.openDraftSession,
      searchPaletteOpen: s.searchPaletteOpen,
      setSearchPaletteOpen: s.setSearchPaletteOpen,
    }))
  );
  // The main bot's conversation, if one was made, so its row can show it is open.
  useEffect(() => {
    void window.electron.getMainBotSessionId().then(setMainBotSessionId).catch(() => undefined);
  }, [setMainBotSessionId]);
  const sidebarCollapsed = useSidebarCollapsed();
  const organization = useSessionOrganization();
  const viewProject = useSidebarViewStore((state) => state.project);
  const setViewOption = useSidebarViewStore((state) => state.setOption);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [sidebarScrolled, setSidebarScrolled] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  // New Task from a project's page starts there. A chat's folder is not a
  // project: New Task from a chat keeps the last project.
  const newThreadCwd =
    (activeWorkspace === 'tasks' && viewProject) || (activeSession?.isChat ? null : activeSession?.cwd) || projectCwd;
  const getActiveChannelIdForProject = (cwd?: string | null) => {
    const key = cwd?.trim() || '__no_project__';
    return activeChannelByProject[key] || DEFAULT_WORKSPACE_CHANNEL_ID;
  };

  const finishSidebarResize = () => {
    if (!sidebarResizingRef.current) return;
    sidebarResizingRef.current = false;
    setIsSidebarResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const handleSidebarResizeMove = (clientX: number) => {
    if (!sidebarResizingRef.current) return;
    const delta = clientX - startXRef.current;
    const nextWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, startWidthRef.current + delta)
    );
    setSidebarWidth(nextWidth);
  };

  const handleSidebarResizeStart = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    sidebarResizingRef.current = true;
    setIsSidebarResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isSidebarResizing) return;

    const handleWindowBlur = () => finishSidebarResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const sidebarHidden = sidebarCollapsed;

  const handleProjectFolderSelect = async () => {
    const selected = await window.electron.selectDirectory();
    if (!selected) return;
    setProjectCwd(selected);
    setActiveChannelForProject(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
    setShowSettings(false);
    openDraftSession(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
  };

  const shortcuts = useAppPreferences(state => state.keyboardShortcuts);
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'new-thread',
        label: 'New Task',
        description: 'Start a new conversation',
        keywords: ['create', 'conversation', 'chat', 'session', 'thread', 'task'],
        shortcut: shortcutLabel('newTask', shortcuts),
      },
      {
        id: 'open-project',
        label: 'Open Project Folder',
        description: 'Pick a working directory for a new thread',
        keywords: ['folder', 'cwd', 'directory'],
      },
      {
        id: 'switch-chat',
        label: 'Go to Home',
        description: 'Show your sessions',
        keywords: ['chat', 'sessions'],
      },
      {
        id: 'switch-tasks',
        label: 'Go to My Tasks',
        description: 'Every task, by state or project',
        keywords: ['tasks', 'list', 'sessions', 'threads'],
      },
      {
        id: 'switch-design',
        label: 'Go to Design',
        description: 'Your design canvases',
        keywords: ['design', 'canvas', 'mockup', 'boards'],
      },
      {
        id: 'switch-automations',
        label: 'Go to Automations',
        description: 'Manage scheduled project workflows',
        keywords: ['automation', 'schedule', 'cron', 'workflow'],
      },
      {
        id: 'switch-prs',
        label: 'Go to Pull Requests',
        description: 'Review and merge your GitHub pull requests',
        keywords: ['pr', 'pull request', 'github', 'merge', 'review'],
      },
      {
        id: 'switch-skills',
        label: 'Go to Skills',
        description: 'Browse skills',
        keywords: ['skills', 'agents'],
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Open application settings',
        keywords: ['preferences', 'config'],
      },
    ],
    [shortcuts]
  );

  const visibleSessions = useMemo(
    () =>
      Object.values(sessions).filter(
        (session) =>
          !session.hiddenFromThreads &&
          // The main bot is a place of its own, not a task.
          session.id !== mainBotSessionId &&
          session.scope !== 'dm'
      ),
    [sessions, mainBotSessionId]
  );

  const workflowSessions = useWorkflowRunningSessions();
  const workflowWaiting = useWorkflowWaitingSessions();
  // My Tasks stands in for the list that used to sit here: the sidebar still says when one waits on you.
  const needsInputCount = useMemo(
    () =>
      visibleSessions.filter(
        (session) =>
          !organization.sessions[session.id]?.archived &&
          deriveSidebarSessionState(session, {
            unread: organization.sessions[session.id]?.unread,
            manualStatus: organization.sessions[session.id]?.manualStatus,
            workflowRunning: workflowSessions.has(session.id),
            workflowWaiting: workflowWaiting.has(session.id),
          }) === 'needs-input'
      ).length,
    [visibleSessions, organization, workflowSessions, workflowWaiting]
  );

  const hasRunningSession = useMemo(
    () => visibleSessions.some((session) => session.status === 'running' || workflowSessions.has(session.id)),
    [visibleSessions, workflowSessions]
  );

  const paletteProjects = useMemo<PaletteProject[]>(() => {
    if (!searchPaletteOpen) return EMPTY_PALETTE_PROJECTS;
    const map = new Map<string, PaletteProject>();
    for (const session of visibleSessions) {
      const cwd = (session.projectCwd || session.cwd)?.trim();
      if (!cwd || session.isChat) continue;
      const existing = map.get(cwd);
      if (existing) {
        existing.sessionCount += 1;
        if (session.updatedAt > existing.lastUpdatedAt) {
          existing.lastUpdatedAt = session.updatedAt;
        }
      } else {
        const parts = cwd.split('/').filter(Boolean);
        map.set(cwd, {
          id: cwd,
          name: parts[parts.length - 1] || cwd,
          cwd,
          sessionCount: 1,
          lastUpdatedAt: session.updatedAt,
        });
      }
    }
    return Array.from(map.values());
  }, [searchPaletteOpen, visibleSessions]);

  const paletteThreads = useMemo<PaletteThread[]>(() => {
    if (!searchPaletteOpen) return EMPTY_PALETTE_THREADS;
    return visibleSessions.map((session) => {
      const cwd = session.cwd?.trim() || null;
      const projectName = cwd
        ? cwd.split('/').filter(Boolean).pop() || cwd
        : 'No Project';

      // Only hydrated sessions have message content available in memory.
      // For others we still match title / project — consistent with the
      // lightweight, in-memory-only philosophy of the palette.
      const texts: string[] = [];
      if (session.hydrated) {
        for (const message of session.messages) {
          if (message.type === 'user_prompt') {
            texts.push(message.prompt);
          } else if (message.type === 'assistant' || message.type === 'user') {
            const text = getMessageContentBlocks(message)
              .map((block) => {
                if (block.type === 'text') return block.text;
                if (block.type === 'thinking') return block.thinking;
                return '';
              })
              .filter(Boolean)
              .join(' ');
            if (text) texts.push(text);
          }
        }
      }

      return {
        id: session.id,
        number: session.number,
        title: session.title,
        projectName,
        updatedAt: session.updatedAt,
        texts,
      };
    });
  }, [searchPaletteOpen, visibleSessions]);

  const openTasks = (project: string | null) => {
    setViewOption('project', project);
    if (project) setProjectCwd(project);
    goToWorkspace('tasks');
  };

  const runPaletteAction = (actionId: string) => {
    switch (actionId) {
      case 'new-thread':
        setShowSettings(false);
        openDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
        break;
      case 'open-project':
        void handleProjectFolderSelect();
        break;
      case 'switch-chat':
        setActiveWorkspace('chat');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-tasks':
        openTasks(null);
        break;
      case 'switch-design':
        setActiveWorkspace('design');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-automations':
        setActiveWorkspace('automations');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-prs':
        setActiveWorkspace('prs');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-skills':
        setActiveWorkspace('skills');
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'settings':
        setShowSettings(true);
        break;
    }
  };

  const openThreadFromPalette = (sessionId: string) => {
    // 不要 setChatLayoutMode('single')：那会把整棵平铺树坍缩成单 leaf。
    // openTask -> setActiveSession 会把会话装入当前聚焦 leaf，保留用户的分屏布局。
    openTask(sessionId);
  };

  const openProjectFromPalette = (projectId: string) => openTasks(projectId);


  const goToWorkspace = (workspace: 'chat' | 'tasks' | 'design' | 'automations' | 'prs' | 'skills') => {
    setActiveWorkspace(workspace);
    setChatSidebarView('threads');
    setShowSettings(false);
  };

  return (
    <>
      {isSidebarResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handleSidebarResizeMove(event.clientX)}
          onMouseUp={finishSidebarResize}
        />
      )}

      <div
        className="aegis-sidebar relative flex h-full min-h-0 flex-shrink-0 flex-col self-stretch select-none"
        data-collapsed={sidebarCollapsed}
      >
        {/* Title bar row over the rail and panel: traffic lights, then the
            toggle and history. Collapsed, the main column's row hosts them. */}
        <div
          className={`drag-region flex h-10 flex-shrink-0 items-center ${sidebarCollapsed ? '' : 'pl-[84px] pr-2'}`}
        >
          {!sidebarCollapsed ? <TitlebarControls /> : null}
        </div>
        <div className="flex min-h-0 flex-1">
        <SidebarRail
          activeWorkspace={showSettings ? null : activeWorkspace}
          showRunningDot={sidebarCollapsed && hasRunningSession}
          onSelect={goToWorkspace}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div
          className="aegis-sidebar-panel-slot relative flex h-full min-h-0 flex-shrink-0 self-stretch overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div
            className={`aegis-sidebar-panel relative h-full flex min-h-0 flex-col overflow-hidden transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                sidebarHidden ? '-translate-x-2 opacity-0 pointer-events-none' : 'translate-x-0 opacity-100'
              }`}
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
            aria-hidden={sidebarHidden}
          >
            {showSettings ? <SettingsNavPanel /> : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between pb-1 pl-3.5 pr-2 pt-2.5">
                <div className="aegis-sidebar-brand font-semibold leading-none tracking-[-0.02em] text-[var(--text-primary)]">
                  Aegis
                </div>
              </div>

              <div className="flex flex-col gap-0.5 px-2 pt-2">
                <SidebarNavRow
                  icon={<SquarePen className="h-[15px] w-[15px]" />}
                  label="New Task"
                  onClick={() => {
                    goToWorkspace('chat');
                    openDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
                  }}
                />
                <SidebarNavRow
                  icon={<Search className="h-[15px] w-[15px]" />}
                  label="Search"
                  title={['Search', shortcutLabel('search', shortcuts)].filter(Boolean).join(' · ')}
                  onClick={() => setSearchPaletteOpen(true)}
                />
                <SidebarNavRow
                  icon={<MessageCircle className="h-[15px] w-[15px]" strokeWidth={1.5} />}
                  label={`Ask ${MAIN_BOT_NAME}`}
                  active={activeWorkspace === 'chat' && !showSettings && !showNewSession && Boolean(mainBotSessionId) && activeSessionId === mainBotSessionId}
                  onClick={() => void openMainBot()}
                />
                <SidebarNavRow
                  icon={<ListChecks className="h-[15px] w-[15px]" strokeWidth={1.5} />}
                  label="My Tasks"
                  active={activeWorkspace === 'tasks'}
                  badge={needsInputCount}
                  onClick={() => goToWorkspace('tasks')}
                />
              </div>

              <div className="pb-1.5 pl-4 pr-2 pt-5 text-[13px] font-medium text-[var(--text-secondary)]" data-active-heading>
                Active
              </div>

              <div className="relative min-h-0 flex-1">
                {/* Rows slide under the pinned header, so the edge shows only once they do. */}
                <div
                  aria-hidden="true"
                  data-sidebar-scroll-edge={sidebarScrolled ? 'visible' : 'hidden'}
                  className={`pointer-events-none absolute inset-x-4 top-0 z-10 h-px bg-[var(--border)] transition-opacity duration-150 ${
                    sidebarScrolled ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <div
                  ref={sidebarScrollRef}
                  onScroll={(event) => setSidebarScrolled(event.currentTarget.scrollTop > 0)}
                  className="sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden px-2 pb-2"
                  data-sidebar-scroll-region
                >
                  <SidebarActiveTasks />
                </div>

                <CappedScrollbar scrollRef={sidebarScrollRef} />
              </div>
            </div>
            )}
          </div>

          {!sidebarCollapsed ? (
            <div
              className="group absolute right-0 top-0 bottom-0 z-[2] w-3 translate-x-1/2 cursor-col-resize no-drag"
              onMouseDown={handleSidebarResizeStart}
            >
              <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
            </div>
          ) : null}
        </div>
        </div>
      </div>

      <SearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        actions={paletteActions}
        projects={paletteProjects}
        threads={paletteThreads}
        onPickAction={runPaletteAction}
        onPickProject={openProjectFromPalette}
        onPickThread={openThreadFromPalette}
      />
    </>
  );
}

type RailWorkspace = 'chat' | 'design' | 'automations' | 'prs' | 'skills';

const RAIL_BUTTON_CLASS =
  'no-drag relative inline-flex h-9 w-9 items-center justify-center rounded-[10px] outline-none transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const RAIL_BUTTON_ACTIVE = 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]';
const RAIL_BUTTON_IDLE =
  'text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]';
const RAIL_ICON = { className: 'h-[18px] w-[18px]', strokeWidth: 1.6 };

/** The sections the More menu lists; pinned ones also show under the rail's divider. */
const PINNABLE_SECTIONS: Record<PinnableRailSection, { label: string; icon: typeof GitPullRequest }> = {
  prs: { label: 'Pull Requests', icon: GitPullRequest },
};

/**
 * The always-visible icon rail on the window's left edge. It switches the
 * app's top-level sections; the panel beside it shows the current one.
 * Above the divider are the fixed sections and the More menu; below it, the
 * sections the user pinned from that menu.
 */
function SidebarRail({
  activeWorkspace,
  showRunningDot,
  onSelect,
  onOpenSettings,
}: {
  /** Null while Settings is open: no section is current. */
  activeWorkspace: string | null;
  showRunningDot: boolean;
  onSelect: (workspace: 'chat' | 'tasks' | 'design' | 'automations' | 'prs' | 'skills') => void;
  onOpenSettings: () => void;
}) {
  const pinned = useRailPinsStore((state) => state.pinned);
  const togglePinned = useRailPinsStore((state) => state.togglePinned);
  const item = (
    workspace: RailWorkspace,
    label: string,
    icon: ReactNode,
    activeIcon?: ReactNode,
    dot = false
  ) => {
    // My Tasks is part of Home: it lives in Home's panel.
    const active = activeWorkspace === workspace || (workspace === 'chat' && activeWorkspace === 'tasks');
    return (
      <button
        key={workspace}
        type="button"
        onClick={(event) => {
          onSelect(workspace);
          event.currentTarget.blur();
        }}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        title={label}
        className={`${RAIL_BUTTON_CLASS} ${active ? RAIL_BUTTON_ACTIVE : RAIL_BUTTON_IDLE}`}
      >
        {active && activeIcon ? activeIcon : icon}
        {dot ? (
          <span
            role="img"
            aria-label="A task is running"
            className="absolute right-[5px] top-[5px] h-[7px] w-[7px] rounded-full bg-[var(--text-primary)] ring-2 ring-[var(--app-rail-surface)]"
          />
        ) : null}
      </button>
    );
  };
  // A section that is open but not pinned is reached through More, so More shows as current.
  const inMore = isPinnableRailSection(activeWorkspace) && !pinned.includes(activeWorkspace);

  return (
    <nav
      aria-label="Sections"
      className="flex h-full w-[52px] flex-shrink-0 flex-col items-center gap-2 pb-1 pt-1"
    >
      {item('chat', 'Home', <Home {...RAIL_ICON} />, <HomeFilled className={RAIL_ICON.className} />, showRunningDot)}
      {item('design', 'Design', <Palette {...RAIL_ICON} />)}
      {item('skills', 'Skill Library', <Script {...RAIL_ICON} />)}
      {item('automations', 'Automations', <Clock {...RAIL_ICON} />)}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More sections"
            title="More"
            data-rail-more
            className={`${RAIL_BUTTON_CLASS} data-[popup-open]:bg-[var(--sidebar-item-hover)] data-[popup-open]:text-[var(--text-primary)] ${
              inMore ? RAIL_BUTTON_ACTIVE : RAIL_BUTTON_IDLE
            }`}
          >
            <MoreHorizontal {...RAIL_ICON} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-[216px]">
          {(Object.keys(PINNABLE_SECTIONS) as PinnableRailSection[]).map((section) => {
            const { label, icon: Icon } = PINNABLE_SECTIONS[section];
            const isPinned = pinned.includes(section);
            const pinLabel = isPinned ? `Unpin ${label} from the rail` : `Pin ${label} to the rail`;
            return (
              <DropdownMenuItem
                key={section}
                data-rail-section={section}
                onSelect={() => onSelect(section)}
                className="group/pin gap-2 py-1.5 pl-2 pr-1 text-[13px] text-[var(--text-secondary)]"
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {/* Pinning keeps the menu open and does not leave the current view. */}
                <button
                  type="button"
                  aria-label={pinLabel}
                  aria-pressed={isPinned}
                  title={pinLabel}
                  data-rail-pin={section}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    togglePinned(section);
                  }}
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-[background-color,color,opacity] hover:bg-[var(--sidebar-item-active)] hover:text-[var(--text-primary)] ${
                    isPinned
                      ? 'text-[var(--text-secondary)]'
                      : 'text-[var(--text-muted)] opacity-0 focus-visible:opacity-100 group-hover/pin:opacity-100 group-data-[highlighted]/pin:opacity-100'
                  }`}
                >
                  {isPinned ? <PinFilled className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" strokeWidth={1.6} />}
                </button>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {pinned.length ? (
        <>
          <div aria-hidden="true" className="h-px w-6 bg-[var(--panel-soft-divider)]" data-rail-divider />
          {pinned.map((section) => {
            const { label, icon: Icon } = PINNABLE_SECTIONS[section];
            return item(section, label, <Icon {...RAIL_ICON} />);
          })}
        </>
      ) : null}
      <div className="flex-1" />
      <SidebarUpdateButton />
      <SidebarUsageButton />
      <SidebarProfileMenu variant="rail" onOpenSettings={onOpenSettings} />
    </nav>
  );
}

function SidebarNavRow({
  icon,
  label,
  title,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  /** Small trailing count (hidden when 0): tasks waiting on you. */
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        onClick();
        (e.currentTarget as HTMLButtonElement).blur();
      }}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left no-drag transition-colors duration-150 ${
        active
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      aria-label={label}
      title={title}
    >
      <span className="flex h-4 w-4 items-center justify-center text-[var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-normal">{label}</span>
      {badge ? (
        <span className="text-[12px] tabular-nums text-[var(--warning)]" data-nav-badge>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

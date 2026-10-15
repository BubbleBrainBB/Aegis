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
  Script,
  Search,
  SquarePen,
  Clock,
} from './icons';
import { useAppStore } from '../store/useAppStore';
import { SearchPalette } from './search/SearchPalette';
import type {
  PaletteAction,
  PaletteProject,
  PaletteThread,
} from './search/palette-ranking';
import { FolderTreeView } from './FolderTreeView';
import { CappedScrollbar } from './CappedScrollbar';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { getMessageContentBlocks } from '../utils/message-content';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../utils/sidebar-width';
import { SessionHistoryButtons } from './SessionHistoryButtons';
import { SidebarProfileMenu } from './sidebar/SidebarProfileMenu';
import { SidebarViewMenu } from './sidebar/SidebarViewMenu';

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
 * The sidebar's top row hosts them while it is open; a collapsed sidebar
 * hands them to the main column's top row.
 */
export function TitlebarControls() {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);

  return (
    <div className="no-drag flex flex-shrink-0 items-center gap-0.5" data-titlebar-controls>
      <SidebarToggleButton
        collapsed={sidebarCollapsed}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <SessionHistoryButtons />
    </div>
  );
}

export function Sidebar() {
  const {
    activeSessionId,
    sidebarCollapsed,
    sidebarWidth,
    projectCwd,
    activeChannelByProject,
    sessions,
    activeWorkspace,
    chatLayoutMode,
    setChatLayoutMode,
    setSidebarCollapsed,
    setSidebarWidth,
    setChatSidebarView,
    setProjectCwd,
    setActiveChannelForProject,
    setActiveSession,
    setActiveWorkspace,
    setShowNewSession,
    setShowSettings,
    createDraftSession,
    searchPaletteOpen,
    setSearchPaletteOpen,
  } = useAppStore();
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const newThreadCwd = activeSession?.cwd || projectCwd;
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
    createDraftSession(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
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
          session.scope !== 'dm'
      ),
    [sessions]
  );

  const hasRunningSession = useMemo(
    () => visibleSessions.some((session) => session.status === 'running'),
    [visibleSessions]
  );

  const paletteProjects = useMemo<PaletteProject[]>(() => {
    const map = new Map<string, PaletteProject>();
    for (const session of visibleSessions) {
      const cwd = session.cwd?.trim();
      if (!cwd) continue;
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
  }, [visibleSessions]);

  const paletteThreads = useMemo<PaletteThread[]>(() => {
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
        title: session.title,
        projectName,
        updatedAt: session.updatedAt,
        texts,
      };
    });
  }, [visibleSessions]);

  const runPaletteAction = (actionId: string) => {
    switch (actionId) {
      case 'new-thread':
        setShowSettings(false);
        createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
        break;
      case 'open-project':
        void handleProjectFolderSelect();
        break;
      case 'switch-chat':
        setActiveWorkspace('chat');
        setChatSidebarView('threads');
        setShowSettings(false);
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
    setShowSettings(false);
    // 不要 setChatLayoutMode('single')：那会把整棵平铺树坍缩成单 leaf。
    // setActiveSession 会把会话装入当前聚焦 leaf，保留用户的分屏布局。
    setActiveSession(sessionId);
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
  };

  const openProjectFromPalette = (projectId: string) => {
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
    setProjectCwd(projectId);
    setShowSettings(false);
  };


  const goToWorkspace = (workspace: 'chat' | 'design' | 'automations' | 'prs' | 'skills') => {
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

      <div className="aegis-sidebar relative flex h-full min-h-0 flex-shrink-0 flex-col self-stretch select-none">
        {/* Title bar row over the rail and panel: traffic lights, then the
            toggle and history. Collapsed, the main column's row hosts them. */}
        <div
          className={`drag-region flex h-10 flex-shrink-0 items-center ${sidebarCollapsed ? '' : 'pl-[84px] pr-2'}`}
        >
          {!sidebarCollapsed ? <TitlebarControls /> : null}
        </div>
        <div className="flex min-h-0 flex-1">
        <SidebarRail
          activeWorkspace={activeWorkspace}
          showRunningDot={sidebarCollapsed && hasRunningSession}
          onSelect={goToWorkspace}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div
          className="relative flex h-full min-h-0 flex-shrink-0 self-stretch overflow-hidden pb-1 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div
            className={`aegis-sidebar-panel relative h-full flex min-h-0 flex-col overflow-hidden transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                sidebarHidden ? '-translate-x-2 opacity-0 pointer-events-none' : 'translate-x-0 opacity-100'
              }`}
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
            aria-hidden={sidebarHidden}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between pb-1 pl-3.5 pr-2 pt-2.5">
                <div className="aegis-sidebar-brand font-semibold leading-none tracking-[-0.02em] text-[var(--text-primary)]">
                  Aegis
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setSearchPaletteOpen(true)}
                    className={SIDEBAR_TRIGGER_CLASS}
                    aria-label="Search"
                    title={['Search', shortcutLabel('search', shortcuts)].filter(Boolean).join(' · ')}
                  >
                    <Search className="h-4 w-4" strokeWidth={1.4} />
                  </button>
                  <SidebarViewMenu />
                </div>
              </div>

              <div className="px-2 pt-2">
                <SidebarNavRow
                  icon={<SquarePen className="h-[15px] w-[15px]" />}
                  label="New Task"
                  onClick={() => {
                    goToWorkspace('chat');
                    createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
                  }}
                />
              </div>

              <div className="relative min-h-0 flex-1">
                <div
                  ref={sidebarScrollRef}
                  className="sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden px-2"
                  data-sidebar-scroll-region
                >
                  <div className="pt-3">
                    <FolderTreeView
                      onSessionClick={(sessionId, options) => {
                        setShowSettings(false);
                        setChatLayoutMode(
                          options?.preserveSplit || chatLayoutMode === 'split' ? 'split' : 'single'
                        );
                        setActiveSession(sessionId);
                        setShowNewSession(false);
                        setActiveWorkspace('chat');
                        setChatSidebarView('threads');
                      }}
                      onSelectProjectFolder={handleProjectFolderSelect}
                      projectCwd={projectCwd}
                      onNewSessionForProject={(nextCwd, channelId) => {
                        const nextChannelId = channelId || getActiveChannelIdForProject(nextCwd);
                        setProjectCwd(nextCwd);
                        setActiveChannelForProject(nextCwd, nextChannelId);
                        setShowSettings(false);
                        setChatSidebarView('threads');
                        createDraftSession(nextCwd, nextChannelId);
                      }}
                    />
                  </div>
                </div>

                <CappedScrollbar scrollRef={sidebarScrollRef} />
              </div>
            </div>
          </div>

          {!sidebarCollapsed ? (
            <div
              className="group absolute right-0 top-0 bottom-1 w-3 translate-x-1/2 cursor-col-resize no-drag"
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

const RAIL_BUTTON_CLASS =
  'no-drag relative inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95';

/**
 * The always-visible icon rail on the window's left edge. It switches the
 * app's top-level sections; the panel beside it shows the current one.
 */
function SidebarRail({
  activeWorkspace,
  showRunningDot,
  onSelect,
  onOpenSettings,
}: {
  activeWorkspace: string;
  showRunningDot: boolean;
  onSelect: (workspace: 'chat' | 'design' | 'automations' | 'prs' | 'skills') => void;
  onOpenSettings: () => void;
}) {
  const item = (
    workspace: 'chat' | 'design' | 'automations' | 'prs' | 'skills',
    label: string,
    icon: ReactNode,
    activeIcon?: ReactNode,
    dot = false
  ) => {
    const active = activeWorkspace === workspace;
    return (
      <button
        type="button"
        onClick={(event) => {
          onSelect(workspace);
          event.currentTarget.blur();
        }}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        title={label}
        className={`${RAIL_BUTTON_CLASS} ${
          active
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        {active && activeIcon ? activeIcon : icon}
        {dot ? (
          <span
            role="img"
            aria-label="A task is running"
            className="absolute right-[3px] top-[3px] h-[7px] w-[7px] rounded-full bg-[var(--text-primary)] ring-2 ring-[var(--app-chrome-bg)]"
          />
        ) : null}
      </button>
    );
  };

  return (
    <nav
      aria-label="Sections"
      className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-1.5 pb-3"
    >
      {item(
        'chat',
        'Home',
        <Home className="h-[17px] w-[17px]" strokeWidth={1.6} />,
        <HomeFilled className="h-[17px] w-[17px]" />,
        showRunningDot
      )}
      {item('design', 'Design', <Palette className="h-[17px] w-[17px]" strokeWidth={1.6} />)}
      {item('skills', 'Skill Library', <Script className="h-[17px] w-[17px]" strokeWidth={1.6} />)}
      {item('automations', 'Automations', <Clock className="h-[17px] w-[17px]" strokeWidth={1.6} />)}
      <div aria-hidden="true" className="my-1 h-px w-[22px] bg-[var(--panel-soft-divider)]" />
      {item('prs', 'Pull Requests', <GitPullRequest className="h-[17px] w-[17px]" strokeWidth={1.6} />)}
      <div className="flex-1" />
      <SidebarProfileMenu variant="rail" onOpenSettings={onOpenSettings} />
    </nav>
  );
}

function SidebarNavRow({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  /** Small trailing count (hidden when 0), e.g. Board cards waiting for review. */
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
    >
      <span className="flex h-4 w-4 items-center justify-center text-[var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-normal">{label}</span>
      {badge ? (
        <span className="rounded-full bg-[var(--sidebar-segment-bg)] px-1.5 text-[11px] leading-[16px] text-[var(--text-muted)]">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

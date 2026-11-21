import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Terminal } from './icons';
import { useAgentReadiness, type AgentReadinessEntry } from '../hooks/useAgentReadiness';
import type { TerminalActivityState, TerminalAgentKind } from '../../shared/terminal';
import { MonochromeLogo } from './MonochromeLogo';
import { OpenCodeLogo } from './OpenCodeLogo';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import grokLogo from '../assets/grok.svg';
import { TerminalChrome } from '../terminal/TerminalChrome';
import type { TerminalHooks } from '../terminal/terminal-host';
import { terminalTabs, type TerminalTab, type TerminalTabDraft } from '../terminal/terminal-tabs';

type TerminalAgentSpec = {
  kind: TerminalAgentKind;
  label: string;
  command: string | null;
  provider: 'claude' | 'codex' | 'opencode' | 'grok' | null;
  shortcut: string;
};

const TERMINAL_AGENT_SPECS: TerminalAgentSpec[] = [
  { kind: 'shell', label: 'Default shell', command: null, provider: null, shortcut: '1' },
  { kind: 'claude', label: 'Claude Code', command: 'claude', provider: 'claude', shortcut: '2' },
  { kind: 'codex', label: 'Codex', command: 'codex', provider: 'codex', shortcut: '3' },
  { kind: 'opencode', label: 'OpenCode', command: 'opencode', provider: 'opencode', shortcut: '4' },
  { kind: 'grok', label: 'Grok Build', command: 'grok', provider: 'grok', shortcut: '5' },
];

function AgentLogo({ kind }: { kind: TerminalAgentKind }) {
  if (kind === 'claude') {
    return <MonochromeLogo src={claudeLogo} />;
  }
  if (kind === 'codex') {
    return <MonochromeLogo src={openaiLogo} />;
  }
  if (kind === 'opencode') {
    return <OpenCodeLogo />;
  }
  if (kind === 'grok') {
    return <MonochromeLogo src={grokLogo} />;
  }
  return <Terminal className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />;
}

const LAST_AGENT_STORAGE_KEY = 'aegis.terminal.lastAgent';

function readStoredAgentKind(): TerminalAgentKind {
  if (typeof window === 'undefined') return 'shell';
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    if (raw && TERMINAL_AGENT_SPECS.some((spec) => spec.kind === raw)) {
      return raw as TerminalAgentKind;
    }
  } catch {
    // ignore
  }
  return 'shell';
}

function writeStoredAgentKind(kind: TerminalAgentKind) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, kind);
  } catch {
    // ignore
  }
}

function activityFromEvent(state: Exclude<TerminalActivityState, 'idle'> | null, hasRunningSubprocess: boolean): TerminalActivityState | null {
  if (state) return state;
  return hasRunningSubprocess ? 'running' : null;
}

/**
 * The terminal tabs of one scope. The tabs and their shells belong to the
 * scope, not to this component: they are kept in `terminalTabs`, so leaving
 * the panel (another session, Settings, a different workspace) only takes
 * the terminals off screen. Coming back shows the same tabs, still running.
 * A tab ends when the user closes it or its session is deleted.
 */
export function SessionTerminal({
  sessionId,
  cwd,
  terminalScopeId,
  visible = true,
  onRequestClose,
  hideChromeTabs = false,
}: {
  sessionId: string | null;
  cwd: string | null;
  terminalScopeId?: string | null;
  visible?: boolean;
  onRequestClose?: () => void;
  hideChromeTabs?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null);
  const chevronButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerMenuRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [lastAgentKind, setLastAgentKind] = useState<TerminalAgentKind>(() => readStoredAgentKind());

  const normalizedCwd = cwd?.trim() || null;
  const normalizedSessionId = sessionId?.trim() || null;
  const runtimeThreadId = terminalScopeId?.trim() || normalizedSessionId;
  const canStart = Boolean(runtimeThreadId && normalizedCwd);
  const { tabs, activeTabId, status } = useSyncExternalStore(terminalTabs.subscribe, () => terminalTabs.get(runtimeThreadId));

  const agentReadiness = useAgentReadiness(null, visible);
  const readinessByProvider = useMemo(() => {
    const map = new Map<string, AgentReadinessEntry>();
    for (const entry of agentReadiness.entries) {
      map.set(entry.provider, entry);
    }
    return map;
  }, [agentReadiness.entries]);
  const readinessRef = useRef(readinessByProvider);
  useEffect(() => {
    readinessRef.current = readinessByProvider;
  }, [readinessByProvider]);

  const buildLaunch = useCallback((agentKind: TerminalAgentKind): Pick<TerminalTab, 'initialCommand' | 'initialNotice'> => {
    const spec = TERMINAL_AGENT_SPECS.find((item) => item.kind === agentKind) ?? TERMINAL_AGENT_SPECS[0];
    if (!spec.command) {
      return { initialCommand: null, initialNotice: null };
    }
    const readiness = spec.provider ? readinessRef.current.get(spec.provider) : null;
    if (readiness && readiness.state !== 'ready' && readiness.state !== 'checking') {
      return {
        initialCommand: null,
        initialNotice: readiness.command ? `${readiness.summary}. Try: ${readiness.command}` : readiness.summary,
      };
    }
    return { initialCommand: spec.command, initialNotice: null };
  }, []);

  /** A new tab for this scope, started in the folder the session has now. */
  const draftTab = useCallback(
    (agentKind: TerminalAgentKind, tabCwd: string): TerminalTabDraft => {
      const spec = TERMINAL_AGENT_SPECS.find((item) => item.kind === agentKind) ?? TERMINAL_AGENT_SPECS[0];
      const launch = buildLaunch(spec.kind);
      return {
        label: spec.kind === 'shell' ? 'Terminal' : spec.label,
        agent: spec.kind,
        initialCommand: launch.initialCommand,
        initialNotice: launch.initialNotice,
        cwd: tabCwd,
      };
    },
    [buildLaunch]
  );

  // The scope's first tab, once it is shown. Tabs that already exist are
  // left alone: this runs again on every mount (twice in development) and
  // whenever the folder changes, and none of that may touch a running shell.
  useEffect(() => {
    if (!visible || !runtimeThreadId || !normalizedCwd) return;
    terminalTabs.ensure(runtimeThreadId, () => draftTab('shell', normalizedCwd));
  }, [draftTab, normalizedCwd, runtimeThreadId, visible]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (pickerRef.current?.contains(target)) return;
      if (pickerMenuRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
      const spec = TERMINAL_AGENT_SPECS.find((item) => item.shortcut === event.key);
      if (spec) {
        event.preventDefault();
        handleAddTabWithAgent(spec.kind);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  const handleAddTabWithAgent = useCallback(
    (agentKind: TerminalAgentKind) => {
      if (!runtimeThreadId || !normalizedCwd) return;
      terminalTabs.add(runtimeThreadId, draftTab(agentKind, normalizedCwd));
      if (lastAgentKind !== agentKind) {
        setLastAgentKind(agentKind);
        writeStoredAgentKind(agentKind);
      }
      setPickerOpen(false);
    },
    [draftTab, lastAgentKind, normalizedCwd, runtimeThreadId]
  );

  const handleAddTab = useCallback(() => {
    handleAddTabWithAgent(lastAgentKind);
  }, [handleAddTabWithAgent, lastAgentKind]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (!runtimeThreadId) return;
      // Removing the tab ends its shell; the last one closes the panel tab too.
      if (terminalTabs.remove(runtimeThreadId, tabId) === 0) onRequestClose?.();
    },
    [runtimeThreadId, onRequestClose]
  );

  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      if (runtimeThreadId) terminalTabs.setActive(runtimeThreadId, tabId);
    },
    [runtimeThreadId]
  );

  // These outlive the component: a terminal keeps reporting while its panel
  // is away, so they write to the tab store rather than to component state.
  const hooksForTab = useCallback(
    (tab: TerminalTab): TerminalHooks => {
      const scope = runtimeThreadId;
      if (!scope) return {};
      return {
        onActivity: (event) => {
          terminalTabs.setActivity(scope, tab.id, activityFromEvent(event.agentState, event.hasRunningSubprocess));
        },
        onExit: () => {
          terminalTabs.setActivity(scope, tab.id, null);
        },
        onError: (message) => {
          terminalTabs.setStatus(scope, message);
        },
      };
    },
    [runtimeThreadId]
  );

  const picker = canStart ? (
    <div ref={pickerRef} className="flex shrink-0 items-stretch">
      <button
        ref={chevronButtonRef}
        type="button"
        onClick={() => {
          setPickerOpen((open) => {
            const next = !open;
            if (next && chevronButtonRef.current) {
              const rect = chevronButtonRef.current.getBoundingClientRect();
              const menuWidth = 224;
              const left = Math.max(8, rect.right - menuWidth);
              setPickerAnchor({ top: rect.bottom + 4, left });
            }
            return next;
          });
        }}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        aria-label="Choose terminal type"
        className={`inline-flex h-8 shrink-0 items-center justify-center border-b border-r border-[var(--border)]/70 px-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)] ${
          pickerOpen ? 'bg-[var(--bg-primary)]/70 text-[var(--text-primary)]' : ''
        }`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  ) : null;

  return (
    <>
      {!runtimeThreadId || (!normalizedCwd && tabs.length === 0) ? (
        <section className="flex h-full min-h-0 flex-col">
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
            Select a project folder in the current session to use the terminal.
          </div>
        </section>
      ) : (
        <div className="relative h-full min-h-0">
          <TerminalChrome
            threadId={runtimeThreadId}
            // Existing tabs carry their own folder; this one is for tabs without.
            cwd={normalizedCwd ?? ''}
            visible={visible}
            tabs={tabs}
            activeTabId={activeTabId}
            onActiveTabChange={handleActiveTabChange}
            onCloseTab={handleCloseTab}
            onAddTab={handleAddTab}
            picker={picker}
            hooksForTab={hooksForTab}
            hideTabBar={hideChromeTabs}
          />
          {status ? (
            <div className="absolute bottom-2 right-2 z-10 rounded bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--error)]">
              {status}
            </div>
          ) : null}
        </div>
      )}
      {pickerOpen && pickerAnchor
        ? createPortal(
            <div
              ref={pickerMenuRef}
              role="menu"
              style={{ position: 'fixed', top: pickerAnchor.top, left: pickerAnchor.left }}
              className="popover-surface popover-surface--lg z-[200] min-w-[224px] overflow-hidden p-1.5"
            >
              {TERMINAL_AGENT_SPECS.map((spec) => {
                const readiness = spec.provider ? readinessByProvider.get(spec.provider) : null;
                const dimmed =
                  readiness != null && readiness.state !== 'ready' && readiness.state !== 'checking';
                return (
                  <button
                    key={spec.kind}
                    type="button"
                    role="menuitem"
                    onClick={() => handleAddTabWithAgent(spec.kind)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                  >
                    <AgentLogo kind={spec.kind} />
                    <span className={`flex-1 truncate ${dimmed ? 'text-[var(--text-muted)]' : ''}`}>
                      {spec.label}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400"
                        aria-hidden="true"
                        title={readiness.summary}
                      />
                    ) : null}
                    {spec.kind === lastAgentKind ? (
                      <span className="text-[10px] text-[var(--text-muted)]">default</span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

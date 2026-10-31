import type {
  ProjectUtilityPanelKind,
  ProjectUtilityPanelTarget,
} from '../types';

let fileTabCounter = 0;
let browserTabCounter = 0;
let launcherTabCounter = 0;
let terminalTabCounter = 0;

export function sessionSourceTab(path: string): ProjectUtilityPanelTarget {
  return `sources:${encodeURIComponent(path)}`;
}

export function sessionSourceTabPath(tab: ProjectUtilityPanelTarget | null): string | null {
  if (!tab?.startsWith('sources:')) return null;
  try { return decodeURIComponent(tab.slice('sources:'.length)); }
  catch { return null; }
}

export function isRightUtilityFileTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'files' || Boolean(target?.startsWith('files:'));
}

export function isRightUtilityBrowserTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'browser' || Boolean(target?.startsWith('browser:'));
}

export function isRightUtilitySubagentTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'subagent' || Boolean(target?.startsWith('subagent:'));
}

export function isRightUtilityTerminalTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'terminal' || Boolean(target?.startsWith('terminal:'));
}

/** A new terminal tab with its own shell. */
export function createTerminalTabId(): ProjectUtilityPanelTarget {
  terminalTabCounter += 1;
  return `terminal:${Date.now().toString(36)}-${terminalTabCounter}`;
}

export function isRightUtilityLauncherTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is `launcher:${string}` {
  return Boolean(target?.startsWith('launcher:'));
}

export function createLauncherTabId(): ProjectUtilityPanelTarget {
  launcherTabCounter += 1;
  return `launcher:${Date.now().toString(36)}-${launcherTabCounter}`;
}

/**
 * A "New tab" that picked a tool: the opened tab takes the launcher's place
 * in the strip when it is new, and the launcher tab goes away.
 */
export function replaceLauncherTab(
  previous: ProjectUtilityPanelTarget[],
  opened: ProjectUtilityPanelTarget[],
  activeTab: ProjectUtilityPanelTarget,
  launcher: ProjectUtilityPanelTarget
): ProjectUtilityPanelTarget[] {
  const index = previous.indexOf(launcher);
  const tabs = opened.filter((tab) => tab !== launcher);
  if (index === -1 || previous.includes(activeTab)) return tabs;
  const withoutActive = tabs.filter((tab) => tab !== activeTab);
  withoutActive.splice(Math.min(index, withoutActive.length), 0, activeTab);
  return withoutActive;
}

export function isRightUtilitySideChatTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is `side-chat:${string}` {
  return Boolean(target?.startsWith('side-chat:'));
}

/**
 * Codex-parity loading tab: docked synchronously when a side chat is
 * requested so the panel never collapses while the fork runs; swapped for
 * the real `side-chat:<id>` tab when the fork resolves (or dropped on
 * failure). Not closable.
 */
export const SIDE_CHAT_PENDING_TAB: ProjectUtilityPanelTarget = 'side-chat:pending';

export function isSideChatPendingTab(
  target: ProjectUtilityPanelTarget | null | undefined
): boolean {
  return target === SIDE_CHAT_PENDING_TAB;
}

export function workflowMemberTab(sessionId: string): ProjectUtilityPanelTarget {
  return `workflow-member:${sessionId}`;
}

export function getWorkflowMemberSessionId(target: ProjectUtilityPanelTarget | null | undefined): string | null {
  return target?.startsWith('workflow-member:') ? target.slice('workflow-member:'.length) : null;
}

export function getSideChatSessionId(target: ProjectUtilityPanelTarget): string {
  return target.slice('side-chat:'.length);
}

export function getRightUtilityTabKind(
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelKind {
  if (target.startsWith('sources:')) return 'sources';
  if (target.startsWith('images:')) return 'images';
  if (target.startsWith('goal:')) return 'goal';
  if (target.startsWith('workflow-member:')) return 'workflow-member';
  if (target.startsWith('design:')) return 'design';
  if (isRightUtilityLauncherTab(target)) return 'launcher';
  if (isRightUtilityFileTab(target)) return 'files';
  if (isRightUtilityBrowserTab(target)) return 'browser';
  if (isRightUtilitySubagentTab(target)) return 'subagent';
  if (isRightUtilitySideChatTab(target)) return 'side-chat';
  if (isRightUtilityTerminalTab(target)) return 'terminal';
  return target as ProjectUtilityPanelKind;
}

function createFileTabId(): ProjectUtilityPanelTarget {
  fileTabCounter += 1;
  return `files:${Date.now().toString(36)}-${fileTabCounter}`;
}

function createBrowserTabId(): ProjectUtilityPanelTarget {
  browserTabCounter += 1;
  return `browser:${Date.now().toString(36)}-${browserTabCounter}`;
}

export function addRightUtilityTab(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelTarget[] {
  return tabs.includes(target) ? tabs : [...tabs, target];
}

export function resolveRightUtilityTabOpen(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelTarget,
  options?: { newTab?: boolean }
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files') {
    const existing = tabs.find(isRightUtilityFileTab);
    const activeTab = options?.newTab || !existing ? createFileTabId() : existing;
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }

  if (target === 'browser') {
    const activeTab = options?.newTab ? createBrowserTabId() : 'browser';
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }

  return {
    tabs: addRightUtilityTab(tabs, target),
    activeTab: target,
  };
}

export function resolveRightUtilityTabOpenPreservingActive(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelKind,
  activeTab: ProjectUtilityPanelTarget | null
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files' && isRightUtilityFileTab(activeTab)) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  if (target === 'browser' && isRightUtilityBrowserTab(activeTab)) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  if (target !== 'files' && activeTab === target) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  return resolveRightUtilityTabOpen(tabs, target);
}

import { terminalScopeBelongsTo, type TerminalActivityState, type TerminalAgentKind } from '../../shared/terminal';

/**
 * Which terminal tabs exist, per scope. This lives outside React so a panel
 * that unmounts (the user switched session, opened Settings, …) finds the
 * same tabs, and so the same running shells, when it mounts again. A tab
 * ends only when it is removed here: closed by the user, or dropped with the
 * session that owns it.
 *
 * Free of xterm and the DOM: the app store imports it, and it runs in Node
 * tests. The terminal host follows `onRemove` to tear its terminals down.
 */

export type TerminalTab = {
  id: string;
  label: string;
  agent: TerminalAgentKind;
  activity: TerminalActivityState | null;
  initialCommand: string | null;
  initialNotice: string | null;
  /**
   * Where this tab's shell was started. It stays put when the session's
   * folder changes later; only tabs opened afterwards start in the new one.
   */
  cwd?: string;
};

export type TerminalTabDraft = Omit<TerminalTab, 'id' | 'activity'>;

export type TerminalScopeTabs = {
  tabs: readonly TerminalTab[];
  activeTabId: string | null;
  /** Last error from one of the scope's terminals. */
  status: string | null;
};

type ScopeEntry = TerminalScopeTabs & { nextNumber: number };

const NO_TABS: TerminalScopeTabs = Object.freeze({ tabs: Object.freeze([]) as readonly TerminalTab[], activeTabId: null, status: null });

export class TerminalTabStore {
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly removalListeners = new Set<(scope: string, tabId: string) => void>();
  /** Session id → the earlier id (a draft) whose scopes it keeps using. */
  private readonly ownerAliases = new Map<string, string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called once for every tab that goes away, whatever removed it. */
  onRemove(listener: (scope: string, tabId: string) => void): () => void {
    this.removalListeners.add(listener);
    return () => this.removalListeners.delete(listener);
  }

  /** The scope's tabs; the same object until something in the scope changes. */
  get(scope: string | null | undefined): TerminalScopeTabs {
    return (scope && this.scopes.get(scope)) || NO_TABS;
  }

  scopeIds(): string[] {
    return [...this.scopes.keys()];
  }

  /**
   * Makes sure the scope has a tab, creating the first one when it has none.
   * Safe to call again (React runs effects twice in development): a scope
   * that already has tabs is left as it is.
   */
  ensure(scope: string, draft: () => TerminalTabDraft): TerminalScopeTabs {
    if (!this.scopes.get(scope)?.tabs.length) this.add(scope, draft());
    return this.get(scope);
  }

  /** Adds a tab and makes it the active one. */
  add(scope: string, draft: TerminalTabDraft): TerminalTab {
    const entry = this.scopes.get(scope) ?? { ...NO_TABS, nextNumber: 1 };
    const tab: TerminalTab = { ...draft, id: `terminal-${Date.now()}-${entry.nextNumber}`, activity: null };
    this.scopes.set(scope, { ...entry, tabs: [...entry.tabs, tab], activeTabId: tab.id, nextNumber: entry.nextNumber + 1 });
    this.changed();
    return tab;
  }

  /**
   * Removes one tab for good; its shell ends. Returns how many tabs the
   * scope has left. A scope without tabs is forgotten.
   */
  remove(scope: string, tabId: string): number {
    const entry = this.scopes.get(scope);
    if (!entry?.tabs.some((tab) => tab.id === tabId)) return entry?.tabs.length ?? 0;
    const tabs = entry.tabs.filter((tab) => tab.id !== tabId);
    if (tabs.length) {
      const activeTabId = entry.activeTabId === tabId ? tabs[0].id : entry.activeTabId;
      this.scopes.set(scope, { ...entry, tabs, activeTabId });
    } else {
      this.scopes.delete(scope);
    }
    this.notifyRemoved(scope, tabId);
    this.changed();
    return tabs.length;
  }

  setActive(scope: string, tabId: string): void {
    const entry = this.scopes.get(scope);
    if (!entry || entry.activeTabId === tabId || !entry.tabs.some((tab) => tab.id === tabId)) return;
    this.scopes.set(scope, { ...entry, activeTabId: tabId });
    this.changed();
  }

  setActivity(scope: string, tabId: string, activity: TerminalActivityState | null): void {
    const entry = this.scopes.get(scope);
    const tab = entry?.tabs.find((item) => item.id === tabId);
    if (!entry || !tab || tab.activity === activity) return;
    this.scopes.set(scope, { ...entry, tabs: entry.tabs.map((item) => (item.id === tabId ? { ...item, activity } : item)) });
    this.changed();
  }

  setStatus(scope: string, status: string | null): void {
    const entry = this.scopes.get(scope);
    if (!entry || entry.status === status) return;
    this.scopes.set(scope, { ...entry, status });
    this.changed();
  }

  /** Removes every tab of one scope. */
  dropScope(scope: string): void {
    this.dropWhere((candidate) => candidate === scope);
  }

  /** Removes every tab of the scopes that match. */
  dropWhere(matches: (scope: string) => boolean): void {
    let any = false;
    for (const [scope, entry] of [...this.scopes]) {
      if (!matches(scope)) continue;
      this.scopes.delete(scope);
      any = true;
      for (const tab of entry.tabs) this.notifyRemoved(scope, tab.id);
    }
    if (any) this.changed();
  }

  /**
   * The id a session's scopes are filed under: its own, or the draft's it
   * grew out of when that draft already had terminals.
   */
  ownerFor(sessionId: string): string {
    return this.ownerAliases.get(sessionId) ?? sessionId;
  }

  /**
   * A draft became a real session. Its terminals keep their scope (and so
   * their shells); the session is pointed at them.
   */
  adoptOwner(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const owner = this.ownerFor(fromId);
    this.ownerAliases.delete(fromId);
    if (this.scopeIds().some((scope) => terminalScopeBelongsTo(scope, owner))) this.ownerAliases.set(toId, owner);
  }

  /** A session is gone (deleted, or a draft thrown away): so are its terminals. */
  dropOwner(sessionId: string): void {
    if (!sessionId) return;
    const owners = new Set([sessionId, this.ownerFor(sessionId)]);
    this.ownerAliases.delete(sessionId);
    this.dropWhere((scope) => [...owners].some((owner) => terminalScopeBelongsTo(scope, owner)));
  }

  private notifyRemoved(scope: string, tabId: string): void {
    for (const listener of [...this.removalListeners]) listener(scope, tabId);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const terminalTabs = new TerminalTabStore();

// The first, plain `terminal` tab keeps the scope it always had.
const rightTerminalScopeSuffix = (paneTabId: string) => (paneTabId === 'terminal' ? 'right-terminal' : `right-${paneTabId}`);

/**
 * The scope of a terminal tab in the right panel: one per session and pane
 * tab, or per project folder when no session is open.
 */
export function rightTerminalScopeId(
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
  paneTabId: string,
  store: TerminalTabStore = terminalTabs
): string | null {
  const suffix = rightTerminalScopeSuffix(paneTabId);
  if (sessionId) return `${store.ownerFor(sessionId)}:${suffix}`;
  return cwd ? `project:${cwd}:${suffix}` : null;
}

/**
 * The user closed a terminal tab of the right panel: end its shells. With no
 * session open the pane tab is shared by every project folder, so all of
 * their scopes for it go.
 */
export function closeRightTerminalPaneTab(
  sessionId: string | null | undefined,
  paneTabId: string,
  store: TerminalTabStore = terminalTabs
): void {
  if (sessionId) {
    store.dropScope(rightTerminalScopeId(sessionId, null, paneTabId, store)!);
    return;
  }
  const suffix = `:${rightTerminalScopeSuffix(paneTabId)}`;
  store.dropWhere((scope) => scope.startsWith('project:') && scope.endsWith(suffix));
}

import { RemoteCompanionSettings } from './RemoteCompanionSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import './settings-controls.css';
import { AppearanceControls } from './AppearanceControls';
import { findSettings, type SettingsSearchEntry } from './settings-search';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Keyboard, Server, Settings as SettingsIcon, Sun, ChartColumn, User, PlugZap, Bot, Image, Trash2, Globe, Monitor } from '../icons';
import { useAppStore } from '../../store/useAppStore';
import { ClaudeUsageSettingsContent } from './ClaudeUsageSettings';
import { AgentRuntimeSettings } from './AgentRuntimeSettings';
import { BubbleProviderSettings } from './BubbleProviderSettings';
import { BrowserUseSettings } from './BrowserUseSettings';
import { MCP_RUNTIMES, McpSettingsContent } from './McpSettings';
import { ProviderIcon } from '../AgentModelPicker';
import { BridgeSettingsContent } from './BridgeSettings';
import { ThemeEditorCard } from './ThemeEditorCard';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import { GeneralSettingsContent, PreferenceSelect } from './GeneralSettingsContent';
import { ProfileSettingsGroup } from './ProfileSettingsGroup';
import { sendEvent } from '../../hooks/useIPC';
import { Search } from '../icons';
import { toast } from 'sonner';
import type { ThemeRecipe, Theme, ThemeTypefaces, AppearanceState, ThemeVariant } from '../../types';
import { choiceFor, migrateLegacyFonts, resolveThemeMode } from '../../theme/themes';
import { isImeComposing } from '../../utils/ime';

const SETTINGS_TABS = {
  general: {
    label: 'General',
    title: 'General',
    description: '',
    icon: <SettingsIcon className="w-4 h-4" />,
  },
  connections: { label: 'Connections', title: 'Connections', description: '', icon: <Monitor className="w-4 h-4" /> },
  appearance: { label: 'Appearance', title: 'Appearance', description: '', icon: <Sun className="w-4 h-4" /> },
  shortcuts: { label: 'Keyboard shortcuts', title: 'Keyboard shortcuts', description: '', icon: <Keyboard className="w-4 h-4" /> },
  browser: {
    label: 'Browser',
    title: 'Browser',
    description: '',
    icon: <Globe className="w-4 h-4" />,
  },
  mcp: {
    label: 'MCP Servers',
    title: 'MCP Servers',
    description: '',
    icon: <Server className="w-4 h-4" />,
  },
  providers: {
    label: 'Providers',
    title: 'Providers',
    description: '',
    icon: <PlugZap className="w-4 h-4" />,
  },
  profile: { label: 'Profile', title: 'Profile', description: '', icon: <User className="w-4 h-4" /> },
  usage: {
    label: 'Usage',
    title: 'Usage',
    description: '',
    icon: <ChartColumn className="w-4 h-4" />,
  },
  bridge: {
    label: 'Bridge',
    title: 'Bridge',
    description: '',
    icon: <Bot className="w-4 h-4" />,
  },
} as const;

type SettingsTabKey = keyof typeof SETTINGS_TABS;

const SETTINGS_NAV_GROUPS: { label: string; tabs: SettingsTabKey[] }[] = [
  { label: 'Personal', tabs: ['general', 'appearance', 'shortcuts', 'profile', 'usage'] },
  { label: 'Integrations', tabs: ['connections', 'browser', 'mcp', 'providers', 'bridge'] },
];

function isSettingsTabKey(value: string): value is SettingsTabKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_TABS, value);
}

/** The settings search, shared by the sidebar (where you type) and the page (where a result is revealed). */
const useSettingsSearchStore = create<{
  search: string;
  target: SettingsSearchEntry | null;
  setSearch: (search: string) => void;
  setTarget: (target: SettingsSearchEntry | null) => void;
}>((set) => ({
  search: '',
  target: null,
  setSearch: (search) => set({ search }),
  setTarget: (target) => set({ target }),
}));

// They belong to one visit: closing Settings clears them, so reopening starts on the page list.
useAppStore.subscribe((state, previous) => {
  if (previous.showSettings && !state.showSettings) useSettingsSearchStore.setState({ search: '', target: null });
});

/**
 * Settings in the sidebar panel, Codex-style: a heading, the search, then
 * the pages by group. The rail stays beside it to leave Settings.
 */
export function SettingsNavPanel() {
  const search = useSettingsSearchStore((s) => s.search);
  const setSearch = useSettingsSearchStore((s) => s.setSearch);
  const setTarget = useSettingsSearchStore((s) => s.setTarget);
  const {
    activeSettingsTab,
    setActiveSettingsTab,
    mcpSettingsRuntime,
    setMcpSettingsRuntime,
  } = useAppStore();

  const [bubbleEntries, setBubbleEntries] = useState<SettingsSearchEntry[]>([]);
  const searching = Boolean(search.trim());
  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    const state = useAppStore.getState();
    sendEvent({type: 'mcp.get-config', payload: {projectPath: state.activeSessionId ? state.sessions[state.activeSessionId]?.cwd : undefined}});
    window.electron.getBubbleProvidersConfig().then(config => {
      if (!cancelled) setBubbleEntries(config.providers.map(provider => ({tab:'providers', label:provider.name, scope:'Bubble', id:`Bubble:${provider.name}`, keywords:'api key enabled default provider 密钥 默认 启用'})));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [searching]);
  const store = useAppStore();
  const mcpCatalogs = [store.mcpGlobalServers, store.mcpCodexGlobalServers, store.mcpOpencodeGlobalServers, store.mcpKimiGlobalServers, store.mcpQoderGlobalServers, store.mcpBubbleGlobalServers, store.mcpDeepseekGlobalServers];
  const extraEntries: SettingsSearchEntry[] = [
    ...bubbleEntries,
    ...MCP_RUNTIMES.flatMap((runtime, index) => [
      {tab:'mcp' as const, label:runtime.label, scope:'MCP Servers', id:`mcp-runtime:${runtime.id}`, runtime:runtime.id, keywords:'mcp server tools 服务器 工具'},
      ...Object.keys(mcpCatalogs[index] ?? {}).map(name => ({tab:'mcp' as const, label:name, runtime:runtime.id, scope:runtime.label, id:`mcp:${runtime.id}:${name}`, keywords:'mcp server tools 服务器 工具'})),
    ]),
  ];
  const searchResults = findSettings(search, extraEntries);
  const selectSearchResult = (entry: SettingsSearchEntry) => {
    if (entry.runtime) setMcpSettingsRuntime(entry.runtime);
    setActiveSettingsTab(entry.tab);
    setTarget({...entry});
    setSearch('');
  };

  const resolvedActiveSettingsTab: SettingsTabKey = isSettingsTabKey(activeSettingsTab)
    ? activeSettingsTab
    : 'general';

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-settings-nav>
      <div className="flex items-center pb-1 pl-3.5 pr-2 pt-2.5">
        <div className="aegis-sidebar-brand font-semibold leading-none tracking-[-0.02em] text-[var(--text-primary)]">
          Settings
        </div>
      </div>

      <div className="px-2 pb-4 pt-3">
        <div className="flex h-8 items-center gap-2 rounded-full bg-[var(--sidebar-item-hover)] px-3 focus-within:ring-1 focus-within:ring-[var(--border-focus)]">
          <Search className="h-[15px] w-[15px] shrink-0 text-[var(--text-muted)]" />
          <input aria-label="Search settings" role="searchbox" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => {
            if (isImeComposing(e)) return;
            if (e.key === 'Escape') setSearch('');
            if (e.key === 'Enter') {
              const first = searchResults[0];
              if (first) selectSearchResult(first);
            }
          }} className="no-drag w-full min-w-0 bg-transparent text-[13px] font-normal leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
          {search && <button aria-label="Clear settings search" onClick={() => setSearch('')} className="text-[var(--text-muted)]">×</button>}
        </div>
      </div>

      {search.trim() ? <div role="region" aria-label="Settings search results" className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searchResults.map(entry => <button key={`${entry.tab}:${entry.scope ?? ''}:${entry.label}`} onClick={() => selectSearchResult(entry)} className="mb-px flex w-full flex-col rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <span>{entry.label}</span><span className="text-[12px] text-[var(--text-muted)]">{SETTINGS_TABS[entry.tab].label}{entry.scope ? ` · ${entry.scope}` : ''}</span>
        </button>)}
        {searchResults.length === 0 && <p className="px-2 text-[13px] text-[var(--text-muted)]">No settings found</p>}
      </div> : <nav aria-label="Settings" className="sidebar-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-2">
        {SETTINGS_NAV_GROUPS.map(group => <section key={group.label} aria-label={group.label}>
          <h2 className="pb-1.5 pl-2 text-[13px] font-medium text-[var(--text-secondary)]">{group.label}</h2>
          <ul className="space-y-0.5">
            {group.tabs.map(key => { const tab = SETTINGS_TABS[key]; return (
              <SettingsNavItem
                key={key}
                label={tab.label}
                icon={tab.icon}
                active={resolvedActiveSettingsTab === key}
                // With runtime sub-items showing, the child carries the highlight.
                expanded={key === 'mcp' && resolvedActiveSettingsTab === 'mcp'}
                onClick={() => { setTarget(null); setActiveSettingsTab(key); }}
              >
                {/* Runtimes are sub-pages of MCP Servers rather than tabs inside
                    the page: the list scales to any number of runtimes without
                    a horizontal strip that wraps in narrow panes. */}
                {key === 'mcp' && resolvedActiveSettingsTab === 'mcp' ? (
                  <ul className="relative mb-1 mt-0.5 ml-[15px] space-y-0.5 border-l border-[var(--border-focus)]/60 pl-2">
                    {MCP_RUNTIMES.map((runtime) => {
                      const active = mcpSettingsRuntime === runtime.id;
                      return (
                        <li key={runtime.id}>
                          <button
                            onClick={() => setMcpSettingsRuntime(runtime.id)}
                            className={`flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-3 text-left text-[13px] transition-colors ${
                              active
                                ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                              <ProviderIcon provider={runtime.id} />
                            </span>
                            <span className="truncate">{runtime.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </SettingsNavItem>
            ); })}
          </ul>
        </section>)}
      </nav>}
    </div>
  );
}

// The open Settings page, on the main sheet beside the sidebar's Settings nav.
export function Settings() {
  const target = useSettingsSearchStore((s) => s.target);
  const mainRef = useRef<HTMLElement>(null);

  const {
    showSettings,
    activeSettingsTab,
    theme,
    setTheme,
    themeState,
    setThemeState,
    updateThemeVariant,
    setThemeVariantCodeThemeId,
    setThemeVariantFonts,
    resetThemeVariant,
    uiFontFamily,
    setUiFontFamily,
    chatCodeFontFamily,
    setChatCodeFontFamily,
  } = useAppStore();

  useEffect(() => {
    if (!uiFontFamily && !chatCodeFontFamily) return;
    setThemeState(migrateLegacyFonts(themeState, uiFontFamily, chatCodeFontFamily));
    setUiFontFamily('');
    setChatCodeFontFamily('');
  }, [uiFontFamily, chatCodeFontFamily, themeState, setThemeState, setUiFontFamily, setChatCodeFontFamily]);

  useLayoutEffect(() => {
    if (!showSettings || !target || activeSettingsTab !== target.tab) return;
    const pane = mainRef.current;
    if (!pane) return;
    let matched: HTMLElement | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const locate = () => {
      const row = Array.from(pane.querySelectorAll<HTMLElement>('[data-settings-label],[data-settings-id]')).find(row => target.id ? row.dataset.settingsId === target.id : row.dataset.settingsLabel === target.label);
      if (!row) return false;
      matched = row;
      let parent = row.parentElement;
      while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
      row.scrollIntoView({block:'center'});
      row.setAttribute('tabindex', '-1');
      row.focus({preventScroll:true});
      row.dataset.searchMatch = 'true';
      timer = setTimeout(() => { delete row.dataset.searchMatch; }, 1800);
      return true;
    };
    const observer = new MutationObserver(() => { if (locate()) observer.disconnect(); });
    if (!locate()) observer.observe(pane, {childList:true, subtree:true});
    return () => { observer.disconnect(); clearTimeout(timer); if (matched) { delete matched.dataset.searchMatch; matched.removeAttribute('tabindex'); } };
  }, [showSettings, target, activeSettingsTab]);

  if (!showSettings) return null;

  const resolvedActiveSettingsTab: SettingsTabKey = isSettingsTabKey(activeSettingsTab)
    ? activeSettingsTab
    : 'general';
  const activeMeta = SETTINGS_TABS[resolvedActiveSettingsTab];
  return (
    <div className="aegis-settings flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <main ref={mainRef} className="aegis-settings-panel min-h-0 min-w-0 flex-1 overflow-y-auto select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
        <div
          className={`aegis-settings-content ${['mcp', 'browser', 'bridge', 'usage', 'profile'].includes(resolvedActiveSettingsTab) ? 'settings-standard' : ''} mx-auto w-full px-8 pb-12 pt-11 ${resolvedActiveSettingsTab === 'usage' ? 'max-w-[1000px]' : 'max-w-[792px]'}`}
        >
          {/* The MCP page renders its own header (runtime name). */}
          {resolvedActiveSettingsTab !== 'mcp' ? (
            <header className="mb-10">
              <h1 data-settings-label={activeMeta.title} className="settings-page-title text-[var(--text-primary)]">
                {activeMeta.title}
              </h1>
              {activeMeta.description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{activeMeta.description}</p>}
            </header>
          ) : null}

          {resolvedActiveSettingsTab === 'general' && <GeneralSettingsContent />}
          {resolvedActiveSettingsTab === 'connections' && <RemoteCompanionSettings />}
          {resolvedActiveSettingsTab === 'shortcuts' && <KeyboardShortcutsSettings />}
          {resolvedActiveSettingsTab === 'appearance' && (
            <AppearanceSettingsContent
              theme={theme}
              setTheme={setTheme}
              themeState={themeState}
              setThemeState={setThemeState}
              updateThemeVariant={updateThemeVariant}
              setThemeVariantCodeThemeId={setThemeVariantCodeThemeId}
              setThemeVariantFonts={setThemeVariantFonts}
              resetThemeVariant={resetThemeVariant}
            />
          )}
          {resolvedActiveSettingsTab === 'browser' && (
            <div className="space-y-5">
              <BrowserUseSettings />
            </div>
          )}
          {resolvedActiveSettingsTab === 'mcp' && (
            <div className="space-y-5">
              <McpSettingsContent key={target?.tab === 'mcp' ? `${target.runtime}:${target.id ?? target.label}` : 'mcp'} />
            </div>
          )}
          {resolvedActiveSettingsTab === 'providers' && (
            <div className="providers-settings">
              <AgentRuntimeSettings />
              <BubbleProviderSettings revealTarget={target?.tab === 'providers' ? target.id : undefined} />
            </div>
          )}
          {resolvedActiveSettingsTab === 'usage' && <ClaudeUsageSettingsContent />}
          {resolvedActiveSettingsTab === 'profile' && <ProfileSettingsGroup />}
          {resolvedActiveSettingsTab === 'bridge' && <BridgeSettingsContent />}
        </div>
      </main>
    </div>
  );
}

function SettingsNavItem({
  label,
  icon,
  active,
  expanded = false,
  onClick,
  children,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  expanded?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={`no-drag flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-normal transition-colors duration-150 ${
          active && expanded
            ? 'text-[var(--text-primary)]'
            : active
              ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--text-muted)] [&_svg]:size-[15px] [&_svg]:stroke-[1.5]">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </button>
      {children}
    </li>
  );
}

function AppearanceSettingsContent({
  theme,
  setTheme,
  themeState,
  setThemeState,
  updateThemeVariant,
  setThemeVariantCodeThemeId,
  setThemeVariantFonts,
  resetThemeVariant,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  themeState: AppearanceState;
  setThemeState: (themeState: AppearanceState) => void;
  updateThemeVariant: (variant: ThemeVariant, patch: Partial<ThemeRecipe>) => void;
  setThemeVariantCodeThemeId: (variant: ThemeVariant, codeThemeId: string) => void;
  setThemeVariantFonts: (variant: ThemeVariant, patch: Partial<ThemeTypefaces>) => void;
  resetThemeVariant: (variant: ThemeVariant) => void;
}) {
  const resolvedMode = resolveThemeMode(theme);
  const lightTheme = choiceFor(themeState, 'light');
  const darkTheme = choiceFor(themeState, 'dark');
  const skinImageData = useAppStore((s) => s.skinImageData);
  const skinOpacity = useAppStore((s) => s.skinOpacity);
  const setSkinImage = useAppStore((s) => s.setSkinImage);
  const setSkinOpacity = useAppStore((s) => s.setSkinOpacity);
  const clearSkin = useAppStore((s) => s.clearSkin);

  const handleChooseSkin = async () => {
    try {
      const result = await window.electron.selectSkinImage();
      if (!result) return;
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setSkinImage(result.fileName, result.dataUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set skin image.');
    }
  };

  const handleClearSkin = () => {
    clearSkin();
    window.electron.clearSkinImage().catch(() => {});
  };

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup title="Theme">
        <SettingsRow variant="card" label="Mode" description="Light, dark, or follow system.">
          <PreferenceSelect label="Theme" value={theme} onChange={value => setTheme(value as Theme)} options={[
            { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
          ]} />
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Skin"
          description="Layer a wallpaper image behind the chat area."
        >
          <div className="flex items-center gap-2">
            {skinImageData ? (
              <>
                <img
                  src={skinImageData}
                  alt="Current skin"
                  className="h-8 w-14 rounded-[var(--radius-lg)] border border-[var(--border)] object-cover"
                />
                <button
                  type="button"
                  onClick={() => void handleChooseSkin()}
                  className="inline-flex h-8 items-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={handleClearSkin}
                  aria-label="Remove skin"
                  title="Remove skin"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleChooseSkin()}
                className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <Image className="h-3.5 w-3.5" />
                Choose Image
              </button>
            )}
          </div>
        </SettingsRow>

        {skinImageData ? (
          <SettingsRow
            variant="card"
            label="Skin Opacity"
            description="How strongly the wallpaper shows through."
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={80}
                step={1}
                value={Math.round(skinOpacity * 100)}
                onChange={(event) => setSkinOpacity(Number(event.target.value) / 100)}
                aria-label="Skin opacity"
                className="w-[180px] accent-[var(--accent)]"
              />
              <span className="w-9 text-right text-[12px] tabular-nums text-[var(--text-muted)]">
                {Math.round(skinOpacity * 100)}%
              </span>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <div className="space-y-5">
        <ThemeEditorCard
          variant="light"
          mode={theme}
          isActive={resolvedMode === 'light'}
          pack={lightTheme}
          themeState={themeState}
          onReset={() => resetThemeVariant('light')}
          onCodeThemeChange={(codeThemeId) => setThemeVariantCodeThemeId('light', codeThemeId)}
          onThemePatch={(patch) => updateThemeVariant('light', patch)}
          onFontPatch={(patch) => setThemeVariantFonts('light', patch)}
          onImportThemeString={setThemeState}
        />
        <ThemeEditorCard
          variant="dark"
          mode={theme}
          isActive={resolvedMode === 'dark'}
          pack={darkTheme}
          themeState={themeState}
          onReset={() => resetThemeVariant('dark')}
          onCodeThemeChange={(codeThemeId) => setThemeVariantCodeThemeId('dark', codeThemeId)}
          onThemePatch={(patch) => updateThemeVariant('dark', patch)}
          onFontPatch={(patch) => setThemeVariantFonts('dark', patch)}
          onImportThemeString={setThemeState}
        />
      </div>

      <AppearanceControls />

    </div>
  );
}

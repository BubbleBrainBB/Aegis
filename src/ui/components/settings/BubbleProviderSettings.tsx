import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Plus } from '../icons';
import * as Menu from '../ui/dropdown-menu';
import { AgentProviderLogo } from '../AgentProviderLogo';
import { OpenCodeLogo } from '../OpenCodeLogo';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import grokLogo from '../../assets/grok.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import alibabaLogo from '../../assets/alibaba-color.svg';
import bailianLogo from '../../assets/bailian-color.svg';
import fireworksLogo from '../../assets/fireworks-color.svg';
import geminiLogo from '../../assets/gemini-color.svg';
import volcengineLogo from '../../assets/volcengine-color.svg';
import stepfunLogo from '../../assets/stepfun.svg';
import type { BubbleProvidersConfig } from '../../types';
import { ProviderKeyEditor, ProviderSettingsRow, ProviderSettingsSection } from './ProviderSettingsPrimitives';

// Brand artwork already bundled for other pickers, keyed by Bubble provider id.
// Providers without artwork fall back to a monogram tile in ProviderLogo.
const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: claudeLogo,
  openai: openaiLogo,
  grok: grokLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  'minimax-anthropic': minimaxLogo,
  zhipuai: zhipuLogo,
  'zhipuai-coding-plan': zhipuLogo,
  zai: zhipuLogo,
  'zai-coding-plan': zhipuLogo,
  alibaba: alibabaLogo,
  'bailian-token-plan': bailianLogo,
  fireworks: fireworksLogo,
  google: geminiLogo,
  doubao: volcengineLogo,
  stepfun: stepfunLogo,
  'moonshot-cn': moonshotLogo,
  'moonshot-intl': moonshotLogo,
  'kimi-for-coding': moonshotLogo,
};

export function BubbleProviderLogo({ providerId, name }: { providerId: string; name: string }) {
  // OpenCode's mark is theme-dependent, so it comes from the shared component
  // rather than the static map.
  if (providerId === 'opencode-zen') return <OpenCodeLogo />;
  const logo = PROVIDER_LOGOS[providerId];
  if (logo) {
    return <img src={logo} alt="" className={`h-4 w-4 flex-shrink-0 ${[claudeLogo, openaiLogo, grokLogo, moonshotLogo, stepfunLogo].includes(logo) ? 'provider-monochrome-logo' : ''}`} aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[9px] font-semibold uppercase text-[var(--text-muted)]"
    >
      {name.charAt(0)}
    </span>
  );
}

// Composer hooks re-fetch Bubble catalogs on this event; fire it after any
// credential change so the model picker updates without a restart.
const COLLAPSED_COUNT = 6;

function notifyBubbleConfigChanged() {
  window.dispatchEvent(new Event('bubble-model-config-updated'));
}

/**
 * API-key management for the bundled Bubble agent. Writes the same
 * ~/.bubble/config.json the Bubble CLI uses, so users never need the CLI to
 * get Bubble running inside Aegis.
 */
export function BubbleProviderSettings({ revealTarget }: { revealTarget?: string } = {}) {
  const [config, setConfig] = useState<BubbleProvidersConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const keyEdited = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showOff, setShowOff] = useState(false);
  // An unconfigured provider picked from "Add provider", shown at the top with its key editor open.
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getBubbleProvidersConfig()
      .then((next) => {
        if (!cancelled) {
          setConfig(next);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const applyResult = useCallback((next: BubbleProvidersConfig) => {
    setConfig(next);
    notifyBubbleConfigChanged();
  }, []);

  const toggleExpanded = (providerId: string) => {
    setExpandedId((current) => (current === providerId ? null : providerId));
    setKeyDraft('');
    keyEdited.current = false;
    setShowKey(false);
  };

  const saveKey = async (providerId: string) => {
    if (!keyDraft.trim()) {
      toast.error('Enter an API key first.');
      return;
    }
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderKey(providerId, keyDraft));
      setExpandedId(null);
      setAddingId(null);
      setKeyDraft('');
      toast.success(`Saved ${providerId} key for Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the key.');
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.removeBubbleProvider(providerId));
      setExpandedId(null);
      toast.success(`Removed ${providerId} from Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleDefaultProvider(providerId));
      toast.success(`${providerId} is now Bubble's default provider.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set the default provider.');
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (providerId: string, enabled: boolean) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderEnabled(providerId, enabled));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const providers = config?.providers || [];

  // Prefill the editor with the stored key when one exists, so the user sees
  // it masked (dots) and can reveal it with the eye toggle — the usual
  // "saved credential" pattern. Fetched on demand; the bulk config never
  // carries keys.
  useEffect(() => {
    if (!expandedId) return;
    const provider = providers.find((entry) => entry.id === expandedId);
    if (!provider?.hasApiKey) return;
    let cancelled = false;
    window.electron
      .getBubbleProviderKey(expandedId)
      .then((key) => {
        if (!cancelled && !keyEdited.current && key) setKeyDraft(key);
      })
      .catch(() => {
        // Leave the draft empty; the user can still type a replacement key.
      });
    return () => {
      cancelled = true;
    };
    // Only refetch when a different editor opens — refetching on config
    // changes (e.g. toggling another provider) would clobber an in-progress
    // edit with the stored key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);
  // Default first, then enabled providers missing a key (they need action),
  // then the rest in catalog order.
  const rank = (provider: (typeof providers)[number]) => (provider.isDefault ? 0 : !provider.hasApiKey ? 1 : 2);
  const configuredProviders = providers.filter((provider) => provider.configured);
  const onProviders = configuredProviders.filter((provider) => provider.enabled).sort((a, b) => rank(a) - rank(b));
  const offProviders = configuredProviders.filter((provider) => !provider.enabled);
  const availableProviders = providers.filter((provider) => !provider.configured);
  const defaultCandidates = onProviders.filter((provider) => provider.hasApiKey);
  const defaultProvider = providers.find((provider) => provider.isDefault);
  const addingProvider = addingId ? availableProviders.find((provider) => provider.id === addingId) : undefined;
  const visibleOn = showAll ? onProviders : onProviders.slice(0, COLLAPSED_COUNT);
  const hiddenCount = onProviders.length - visibleOn.length;

  useEffect(() => {
    if (!revealTarget?.startsWith('Bubble:') || !config) return;
    const target = providers.find((provider) => `Bubble:${provider.name}` === revealTarget);
    if (!target) return;
    if (!target.configured) {
      setAddingId(target.id);
      setExpandedId(target.id);
    } else if (!target.enabled) {
      setShowOff(true);
    } else {
      setShowAll(true);
    }
    // Only react to a new search target, not to config refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, Boolean(config)]);

  const startAdding = (providerId: string) => {
    setAddingId(providerId);
    setExpandedId(providerId);
    setKeyDraft('');
    keyEdited.current = false;
    setShowKey(false);
  };

  const renderRow = (provider: (typeof providers)[number]) => {
    const actions = [
      ...(provider.configured && provider.hasApiKey && provider.enabled && !provider.isDefault ? [{ label: 'Make default', onSelect: () => void makeDefault(provider.id) }] : []),
      ...(provider.configured ? [{ label: 'Remove provider', onSelect: () => void removeProvider(provider.id), destructive: true }] : []),
    ];
    const onToggleExpand = provider.configured ? () => toggleExpanded(provider.id) : () => { setAddingId(null); setExpandedId(null); };
    return <ProviderSettingsRow key={provider.id} label={provider.name} scope="Bubble" logo={<BubbleProviderLogo providerId={provider.id} name={provider.name} />}
      expanded={expandedId === provider.id} disabled={busyId !== null} isDefault={provider.isDefault}
      status={provider.configured && !provider.hasApiKey ? 'No API key' : undefined} statusTone="warn"
      enabled={provider.enabled} onToggleEnabled={provider.configured ? value => void setEnabled(provider.id, value) : undefined}
      onToggleExpand={onToggleExpand} actions={actions}>
      <ProviderKeyEditor label={`${provider.name} API key for Bubble`} value={keyDraft} onChange={value => { keyEdited.current = true; setKeyDraft(value); }} showKey={showKey} onToggleVisibility={() => setShowKey(value => !value)} busy={busyId !== null} onSave={() => void saveKey(provider.id)} onCancel={onToggleExpand} />
    </ProviderSettingsRow>;
  };

  const headerActions = config && <>
    {defaultCandidates.length > 0 && <Menu.Root><Menu.Trigger asChild>
      <button type="button" className="provider-header-button" aria-label="Default Bubble provider" disabled={busyId !== null}>
        <span className="provider-header-button-label">Default</span>
        {defaultProvider && <BubbleProviderLogo providerId={defaultProvider.id} name={defaultProvider.name} />}
        <span>{defaultProvider?.name ?? 'None'}</span><ChevronDown className="h-3 w-3 opacity-60" />
      </button>
    </Menu.Trigger><Menu.Portal><Menu.Content align="end" sideOffset={6} className="max-h-[320px] overflow-y-auto">
      {defaultCandidates.map(provider => <Menu.Item key={provider.id} onSelect={() => void makeDefault(provider.id)} className="gap-3 text-[13px]">
        <span className="flex min-w-0 flex-1 items-center gap-2"><BubbleProviderLogo providerId={provider.id} name={provider.name} />{provider.name}</span>
        <Check aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${provider.isDefault ? '' : 'invisible'}`} />
      </Menu.Item>)}
    </Menu.Content></Menu.Portal></Menu.Root>}
    {availableProviders.length > 0 && configuredProviders.length > 0 && <Menu.Root><Menu.Trigger asChild>
      <button type="button" className="provider-header-button provider-add-button" disabled={busyId !== null}><Plus className="h-3 w-3" />Add provider</button>
    </Menu.Trigger><Menu.Portal><Menu.Content align="end" sideOffset={6} className="max-h-[320px] overflow-y-auto">
      {availableProviders.map(provider => <Menu.Item key={provider.id} onSelect={() => startAdding(provider.id)} className="gap-2 text-[13px]">
        <BubbleProviderLogo providerId={provider.id} name={provider.name} />{provider.name}
      </Menu.Item>)}
    </Menu.Content></Menu.Portal></Menu.Root>}
  </>;

  return <ProviderSettingsSection title="Bubble model providers" icon={<AgentProviderLogo provider="bubble" className="h-3.5 w-3.5" />} actions={headerActions}>
    {loadError ? <div className="provider-load-message" role="alert">Could not load providers. <button onClick={() => { setLoadError(null); setLoadAttempt(value => value + 1); }}>Retry</button></div>
      : !config ? <div className="provider-load-message" role="status">Loading…</div>
      : configuredProviders.length === 0 ? availableProviders.map(renderRow)
      : <>
        {addingProvider && renderRow(addingProvider)}
        {visibleOn.map(renderRow)}
        {(hiddenCount > 0 || showAll) && onProviders.length > COLLAPSED_COUNT && <button type="button" className="provider-list-toggle" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
          <ChevronDown className={`h-3 w-3 transition-transform ${showAll ? 'rotate-180' : ''}`} />{showAll ? 'Show less' : `Show ${hiddenCount} more`}
        </button>}
        {offProviders.length > 0 && <button type="button" className="provider-list-toggle provider-off-toggle" onClick={() => setShowOff(!showOff)} aria-expanded={showOff}>
          <span className="provider-off-logos">{offProviders.slice(0, 3).map(provider => <BubbleProviderLogo key={provider.id} providerId={provider.id} name={provider.name} />)}</span>
          <span>{offProviders.length} turned off</span>
          {!showOff && <span className="provider-off-names">{offProviders.map(provider => provider.name).join(', ')}</span>}
          <ChevronDown className={`ml-auto h-3 w-3 transition-transform ${showOff ? 'rotate-180' : ''}`} />
        </button>}
        {showOff && offProviders.map(renderRow)}
      </>}
  </ProviderSettingsSection>;
}

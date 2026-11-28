import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from './ui/dropdown-menu';
import { Check, ChevronDown } from './icons';
import { PermissionModePicker } from './PermissionModePicker';
import {
  BUBBLE_PERMISSION_MODE_OPTIONS,
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_PERMISSION_MODE_OPTIONS,
  DEVIN_PERMISSION_MODE_OPTIONS,
  MIMO_PERMISSION_MODE_OPTIONS,
  MINIMAX_PERMISSION_MODE_OPTIONS,
  type PermissionModeOption,
} from '../utils/permission-modes';
import { PROVIDERS } from '../utils/provider';
import { formatClaudeModelLabel } from '../utils/claude-model';
import {
  REMOTE_DEFAULT_PERMISSION,
  REMOTE_PERMISSION_MODES,
  type RemoteAgentEntry,
} from '../../shared/remote/agent-catalog';
import { chooseSettings, effectiveSettings, markSent, pruneChosen, type ChosenSettings } from '../../shared/remote/chosen-settings';
import type { RemoteProvider, RemoteTaskSettings } from '../../shared/remote/protocol';
import type { AgentProvider } from '../../shared/types';
import { bubbleThinkingLevelName, isBubbleThinkingToggle } from '../../shared/bubble-reasoning';

const PERMISSION_OPTIONS: Record<RemoteProvider, ReadonlyArray<PermissionModeOption<string>>> = {
  claude: CLAUDE_PERMISSION_MODE_OPTIONS,
  codex: CODEX_PERMISSION_MODE_OPTIONS,
  bubble: BUBBLE_PERMISSION_MODE_OPTIONS,
  devin: DEVIN_PERMISSION_MODE_OPTIONS,
  mimo: MIMO_PERMISSION_MODE_OPTIONS,
  minimax: MINIMAX_PERMISSION_MODE_OPTIONS,
};
const PLAN_OPTION: PermissionModeOption<string> = { mode: 'plan', label: 'Plan', description: 'Create a plan before making changes' };
const providerLabel = (provider: string) => PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
const isRemoteProvider = (provider: string | undefined): provider is RemoteProvider =>
  !!provider && provider in REMOTE_PERMISSION_MODES;

const REMOTE_SESSION_ID = /^rh-[a-f0-9]{12}-.+$/;

/**
 * The composer's choices for a task on another Mac, kept apart from this Mac's own
 * preferences. `key` is the session or draft; `initial` is what that Mac has set,
 * under what was chosen here for it before.
 *
 * A choice for a session that exists is also told to the main process, which sends
 * it with every later message to that session (the main bot's too) and gives it
 * back in `initial`: it is not lost when the composer closes or another session is
 * opened. It reaches the other Mac with the next message; a turn that is running
 * there keeps the mode it started with.
 */
export function useRemoteSelection(key: string, catalog: RemoteAgentEntry[], initialProvider: string | undefined, initial?: RemoteTaskSettings) {
  const [changed, setChanged] = useState<{ key: string; provider?: RemoteProvider; chosen?: ChosenSettings }>({ key });
  const own = changed.key === key ? changed : { key, provider: undefined, chosen: undefined };
  // What is held here only bridges the moment until `initial` says something new for
  // the field: the choice came back from the main process (which keeps it until a
  // message carries it), or the other Mac moved on (an approved plan leaves plan
  // mode). Dropped for good, so it can't return when that field changes again.
  const reported = { settings: initial };
  const chosen = pruneChosen(own.chosen, reported);
  if (chosen !== own.chosen) setChanged({ key, provider: own.provider, chosen });
  const update = (picked: RemoteTaskSettings) => {
    // Handed on at once, so `initial` answers for it from here.
    const next = chooseSettings(chosen, reported, picked);
    setChanged({ key, provider: own.provider, chosen: markSent(next, { settings: picked, reported, picked: { ...next?.picked } }) });
    // Lost only if this window outlives the main process; the next message still says it.
    if (REMOTE_SESSION_ID.test(key)) window.electron?.remoteHosts?.('choose', { sessionId: key, settings: picked })?.catch(() => {});
  };

  const wanted = own.provider ?? (isRemoteProvider(initialProvider) ? initialProvider : undefined);
  const entry = catalog.find((item) => item.provider === wanted) ?? catalog[0];
  const provider = entry?.provider ?? wanted;
  const settings = effectiveSettings(reported, chosen);
  // Each message says what it should run with, in full: what the composer shows.
  // An older host treats a missing mode as its default, and a newer one keeps
  // what a message leaves out, so plan is said either way: not planning is
  // reported by leaving it out, and saying nothing back would keep a plan that
  // began over there since.
  const permissionMode = settings.permissionMode ?? (provider ? REMOTE_DEFAULT_PERMISSION[provider] : undefined);
  return {
    provider,
    entry,
    settings: { ...settings, ...(permissionMode ? { permissionMode } : {}), plan: settings.plan === true },
    setProvider: (next: RemoteProvider) => setChanged({ key, provider: next }),
    setModel: (model: string) => update({ model, effort: undefined, fast: undefined }),
    setEffort: (effort: string) => update({ effort }),
    setPermission: (mode: string) =>
      update(mode === 'plan' && !REMOTE_PERMISSION_MODES[provider as RemoteProvider]?.includes('plan') ? { plan: true } : { permissionMode: mode, plan: false }),
  };
}
export type RemoteSelection = ReturnType<typeof useRemoteSelection>;

export function RemotePermissionControl({ selection, disabled }: { selection: RemoteSelection; disabled?: boolean }) {
  const { provider, settings, setPermission } = selection;
  const options = useMemo(() => {
    if (!provider) return [];
    const allowed = REMOTE_PERMISSION_MODES[provider];
    const listed = PERMISSION_OPTIONS[provider].filter((option) => allowed.includes(option.mode) && !option.hidden);
    return allowed.includes('plan') ? listed : [...listed, PLAN_OPTION];
  }, [provider]);
  if (!provider) return null;
  return (
    <PermissionModePicker
      value={settings.plan ? 'plan' : settings.permissionMode ?? REMOTE_DEFAULT_PERMISSION[provider]}
      options={options}
      onChange={setPermission}
      disabled={disabled}
    />
  );
}

/** Agent (for a new task only), model and effort, as that Mac lists them. */
export function RemoteModelControl({ selection, catalog, canChangeAgent, disabled }: {
  selection: RemoteSelection;
  catalog: RemoteAgentEntry[];
  canChangeAgent?: boolean;
  disabled?: boolean;
}) {
  const { entry, provider, settings, setProvider, setModel, setEffort } = selection;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const label = (id: string, fallback?: string) => (provider === 'claude' ? formatClaudeModelLabel(id) : fallback ?? id);
  const modelId = settings.model ?? entry?.defaultModel ?? null;
  const model = entry?.models.find((item) => item.id === modelId);
  const effort = settings.effort ?? entry?.defaultEffort ?? null;
  const efforts = model?.efforts ?? [];
  // A Bubble model that only switches thinking lists "medium" for on.
  const bubbleToggle = provider === 'bubble' && isBubbleThinkingToggle(efforts);
  const effortName = (id: string) => (bubbleToggle ? bubbleThinkingLevelName(id, efforts) : id);
  // Beside the model name a switch reads "thinking" while on, nothing while off.
  const effortChip = !effort || !efforts.includes(effort) ? null : !bubbleToggle ? effort : effort === 'off' ? null : 'thinking';
  const summary = !entry
    ? (catalog.length === 0 && !provider ? 'Checking agents…' : providerLabel(provider ?? ''))
    : [canChangeAgent ? providerLabel(entry.provider) : null, modelId ? label(modelId, model?.label) : 'Default'].filter(Boolean).join(' · ');
  const itemClass = 'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]';
  const heading = 'px-2 pb-1 pt-1.5 text-[12px] font-medium text-[var(--text-muted)]';
  return (
    <DropdownMenu.Root open={open && !disabled} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled || !entry}
          data-remote-agent-picker
          className="flex h-8 max-w-[260px] items-center gap-1 rounded-lg px-2 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60"
        >
          <span className="truncate">{summary}</span>
          {effortChip ? <span className="flex-shrink-0 text-[var(--text-muted)]">{effortChip}</span> : null}
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} className="z-50 flex max-h-[420px] w-[260px] flex-col overflow-y-auto p-1.5">
          {canChangeAgent ? <>
            <div className={heading}>Agent</div>
            {catalog.map((item) => (
              <DropdownMenu.Item key={item.provider} className={itemClass} onSelect={() => setProvider(item.provider)}>
                <span className="min-w-0 flex-1 truncate">{providerLabel(item.provider as AgentProvider)}</span>
                {item.provider === provider ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
              </DropdownMenu.Item>
            ))}
          </> : null}
          {entry?.models.length ? <>
            <div className={heading}>Model</div>
            {entry.models.map((item) => (
              <DropdownMenu.Item key={item.id} className={itemClass} onSelect={() => setModel(item.id)} data-remote-model-option={item.id}>
                <span className="min-w-0 flex-1 truncate">{label(item.id, item.label)}</span>
                {item.id === modelId ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
              </DropdownMenu.Item>
            ))}
          </> : null}
          {efforts.length ? <>
            <div className={heading}>Effort</div>
            {efforts.map((item) => (
              <DropdownMenu.Item key={item} className={itemClass} onSelect={() => setEffort(item)}>
                <span className="min-w-0 flex-1 truncate">{effortName(item)}</span>
                {item === effort ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
              </DropdownMenu.Item>
            ))}
          </> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

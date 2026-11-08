import { useEffect, useMemo, useState } from 'react';
import type { AgentProvider } from '../../types';
import { teamAgent, TEAM_LIMITS, type TeamCandidate, type TeamModelChoice, type TeamSettings } from '../../../shared/team';
import { saveAppPreferences, subscribeAppPreferences, useAppPreferences } from '../../store/useAppPreferences';
import { ProviderIcon } from '../AgentModelPicker';
import { PreferenceSelect } from './GeneralSettingsContent';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

const DEFAULT_MODEL = '';
const NONE = 'none';

function useModels(provider: AgentProvider | null): Array<{ id: string; label?: string }> {
  const [models, setModels] = useState<Array<{ id: string; label?: string }>>([]);
  useEffect(() => {
    let alive = true;
    setModels([]);
    if (provider) void window.electron.getTeamModels(provider).then((list) => { if (alive) setModels(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [provider]);
  return models;
}

/** One agent and one of its models; the model list comes from that agent's own catalog. */
function ModelChoice({ label, value, candidates, allowNone, onChange }: {
  label: string;
  value: TeamModelChoice;
  candidates: TeamCandidate[];
  allowNone?: boolean;
  onChange: (next: TeamModelChoice) => void;
}) {
  const models = useModels(value.provider);
  const agents = [
    ...(allowNone ? [{ value: NONE, label: 'None' }] : []),
    ...candidates.map((candidate) => ({
      value: candidate.provider,
      label: candidate.unavailable ? `${candidate.label} (${candidate.unavailable})` : candidate.label,
      icon: <ProviderIcon provider={candidate.provider} />,
    })),
  ];
  const modelOptions = [
    { value: DEFAULT_MODEL, label: 'Default model' },
    ...models.map((model) => ({ value: model.id, label: model.label ?? model.id })),
    ...(value.model && !models.some((model) => model.id === value.model) ? [{ value: value.model, label: value.model }] : []),
  ];
  return (
    <div className="flex items-center gap-2">
      <PreferenceSelect
        label={`${label} agent`}
        value={value.provider ?? NONE}
        options={agents}
        onChange={(provider) => onChange({ provider: provider === NONE ? null : (provider as AgentProvider), model: '' })}
      />
      {value.provider ? (
        <PreferenceSelect
          label={`${label} model`}
          value={value.model}
          options={modelOptions}
          onChange={(model) => onChange({ ...value, model })}
        />
      ) : null}
    </div>
  );
}

function AgentRow({ candidate, settings, onChange }: {
  candidate: TeamCandidate;
  settings: TeamSettings;
  onChange: (next: TeamSettings) => void;
}) {
  const agent = teamAgent(settings, candidate.provider);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.description);
  useEffect(() => { if (!editing) setDraft(agent.description); }, [agent.description, editing]);
  const update = (patch: Partial<typeof agent>) =>
    onChange({ ...settings, agents: { ...settings.agents, [candidate.provider]: { ...agent, ...patch } } });
  const save = () => {
    update({ description: draft.trim().slice(0, TEAM_LIMITS.description) });
    setEditing(false);
  };
  return (
    <div data-settings-label={candidate.label} data-team-agent={candidate.provider} className="settings-row grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className={`flex items-center gap-2 text-[14px] font-medium ${agent.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
          <span className="flex h-4 w-4 items-center justify-center"><ProviderIcon provider={candidate.provider} /></span>
          {candidate.label}
        </div>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              autoFocus
              value={draft}
              maxLength={TEAM_LIMITS.description}
              rows={2}
              placeholder="What this agent should get, e.g. engineering, debugging and UI work."
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                if (event.key === 'Escape') setEditing(false);
              }}
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
            />
            <div className="flex gap-2">
              <button type="button" onClick={save} className="settings-control h-7 rounded-lg bg-[var(--text-primary)] px-3 text-[12px] font-medium text-[var(--bg-primary)]">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="settings-control h-7 rounded-lg px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)]">Cancel</button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
            {!agent.enabled ? 'Not in Team. Aegis won’t give it work.' : agent.description || 'No description yet. Aegis gives it work only when nothing else fits.'}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 pt-0.5">
        {!editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Edit</button>
        ) : null}
        <SettingsToggle checked={agent.enabled} onChange={(enabled) => update({ enabled })} ariaLabel={`${candidate.label} in Team`} />
      </div>
    </div>
  );
}

export function TeamSettingsContent() {
  const settings = useAppPreferences((state) => state.team);
  const [candidates, setCandidates] = useState<TeamCandidate[] | null>(null);
  useEffect(subscribeAppPreferences, []);
  useEffect(() => {
    let alive = true;
    void window.electron.getTeamCandidates().then((list) => { if (alive) setCandidates(list); }).catch(() => { if (alive) setCandidates([]); });
    return () => { alive = false; };
  }, []);
  const save = (team: TeamSettings) => void saveAppPreferences({ team });
  const ready = useMemo(() => (candidates ?? []).filter((candidate) => !candidate.unavailable), [candidates]);
  const skipped = useMemo(() => (candidates ?? []).filter((candidate) => candidate.unavailable && candidate.unavailable !== 'not installed or not working'), [candidates]);

  if (!candidates) return <p className="text-[13px] text-[var(--text-muted)]">Checking your agents…</p>;

  return (
    <div className="space-y-6" data-team-settings>
      <SettingsGroup title="Coordinator">
        <SettingsRow variant="card" label="Model" description="Reads every message in Team and decides who takes it. A fast model keeps replies quick.">
          <ModelChoice label="Coordinator" value={settings.coordinator} candidates={candidates} onChange={(coordinator) => save({ ...settings, coordinator })} />
        </SettingsRow>
        <SettingsRow variant="card" label="If it doesn’t answer" description="Tried next when the model is unavailable. With neither, a short reply goes to the task you last talked about.">
          <ModelChoice label="Fallback" value={settings.fallback} candidates={candidates} allowNone onChange={(fallback) => save({ ...settings, fallback })} />
        </SettingsRow>
        <SettingsRow variant="card" label="Ask when unsure" description="If a message might belong to a task that already exists, ask before starting anything.">
          <SettingsToggle checked={settings.askWhenUnsure} onChange={(askWhenUnsure) => save({ ...settings, askWhenUnsure })} ariaLabel="Ask when unsure" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Who takes what">
        {ready.map((candidate) => (
          <AgentRow key={candidate.provider} candidate={candidate} settings={settings} onChange={save} />
        ))}
        <div className="px-4 py-2.5 text-[12px] leading-5 text-[var(--text-muted)]" data-settings-label="Skipped automatically">
          Skipped automatically: agents that aren’t signed in, can’t run in that project, or are at their usage limit.
          {skipped.length ? ` Now: ${skipped.map((candidate) => `${candidate.label} (${candidate.unavailable})`).join(', ')}.` : ''}
        </div>
      </SettingsGroup>
    </div>
  );
}

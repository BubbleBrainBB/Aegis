// Team: one conversation whose agent is a coordinator. It answers, or hands
// work to one owner per task, picking the owner from the descriptions the user
// writes here. No busy/idle balancing: the user's descriptions decide.

import type { AgentProvider } from './types';

export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  'claude', 'codex', 'opencode', 'kimi', 'grok', 'pi', 'qoder', 'bubble', 'deepseek', 'devin', 'mimo', 'minimax',
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export interface TeamModelChoice {
  provider: AgentProvider | null;
  /** Empty means the provider's own default model. */
  model: string;
}

export interface TeamAgentSettings {
  /** Off: the coordinator never gives this agent work. */
  enabled: boolean;
  /** What this agent should get, in the user's words. */
  description: string;
}

export interface TeamSettings {
  coordinator: TeamModelChoice;
  /** Tried when the coordinator's agent is not ready. */
  fallback: TeamModelChoice;
  /** Ask before acting when a message might belong to an existing task. */
  askWhenUnsure: boolean;
  agents: Partial<Record<AgentProvider, TeamAgentSettings>>;
}

export const TEAM_LIMITS = {
  description: 600,
  model: 200,
  /** How deep owners may split tasks below a Team task. */
  maxSplitDepth: 4,
  /** How many tasks one turn may start. */
  maxStartsPerTurn: 8,
  /** A no-model follow-up: one short line sent soon after the last task talk. */
  quickFollowUpChars: 40,
  quickFollowUpWindowMs: 10 * 60_000,
} as const;

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  coordinator: { provider: 'claude', model: '' },
  fallback: { provider: null, model: '' },
  askWhenUnsure: true,
  agents: {},
};

function normalizeChoice(value: unknown, fallback: TeamModelChoice): TeamModelChoice {
  if (!value || typeof value !== 'object') return { ...fallback };
  const input = value as Record<string, unknown>;
  const provider = input.provider === null ? null : isAgentProvider(input.provider) ? input.provider : fallback.provider;
  const model = typeof input.model === 'string' && input.model.length <= TEAM_LIMITS.model ? input.model.trim() : '';
  return { provider, model: provider ? model : '' };
}

function normalizeLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, max) : null;
}

export function normalizeTeamSettings(value: unknown): TeamSettings {
  const result: TeamSettings = {
    coordinator: { ...DEFAULT_TEAM_SETTINGS.coordinator },
    fallback: { ...DEFAULT_TEAM_SETTINGS.fallback },
    askWhenUnsure: DEFAULT_TEAM_SETTINGS.askWhenUnsure,
    agents: {},
  };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  result.coordinator = normalizeChoice(input.coordinator, DEFAULT_TEAM_SETTINGS.coordinator);
  result.fallback = normalizeChoice(input.fallback, DEFAULT_TEAM_SETTINGS.fallback);
  if (typeof input.askWhenUnsure === 'boolean') result.askWhenUnsure = input.askWhenUnsure;
  const agents = input.agents && typeof input.agents === 'object' ? (input.agents as Record<string, unknown>) : {};
  for (const [provider, raw] of Object.entries(agents)) {
    if (!isAgentProvider(provider) || !raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    result.agents[provider] = {
      enabled: entry.enabled !== false,
      description: typeof entry.description === 'string' ? entry.description.trim().slice(0, TEAM_LIMITS.description) : '',
    };
  }
  return result;
}

/** An agent's settings, with the defaults a new agent starts from. */
export function teamAgent(settings: TeamSettings, provider: AgentProvider): TeamAgentSettings {
  return settings.agents[provider] ?? { enabled: true, description: '' };
}

export interface TeamCandidate {
  provider: AgentProvider;
  label: string;
  /** Why it can't take work right now, or null when it can. */
  unavailable: string | null;
}

/** The agents the coordinator may pick: on in Team and able to run now. */
export function eligibleAgents(settings: TeamSettings, candidates: TeamCandidate[]): TeamCandidate[] {
  return candidates.filter((candidate) => teamAgent(settings, candidate.provider).enabled && !candidate.unavailable);
}

/**
 * The roster the coordinator reads every turn: who it may give work to and
 * what each takes, in the user's words. Agents that are off or can't run are
 * left out, with a line saying why, so it never picks one.
 */
export function teamRoster(settings: TeamSettings, candidates: TeamCandidate[]): string {
  const lines: string[] = [];
  for (const candidate of candidates) {
    const agent = teamAgent(settings, candidate.provider);
    if (!agent.enabled) continue;
    if (candidate.unavailable) {
      lines.push(`- ${candidate.provider} (${candidate.label}): unavailable now, ${candidate.unavailable}. Do not pick it.`);
      continue;
    }
    lines.push(`- ${candidate.provider} (${candidate.label}): ${agent.description || 'no description yet'}`);
  }
  return lines.length ? lines.join('\n') : '(no agent can take work right now)';
}

/** The coordinator's standing instructions, sent with every Team turn. */
export function teamInstructions(settings: TeamSettings, roster: string, projects: string[]): string {
  return [
    'You are the coordinator of Aegis Team. You never do the work yourself: you answer, or you hand work to one owner per task.',
    'For each message from the user, do exactly one of these:',
    '- A question you can answer from this conversation or a quick look (status, what happened): answer it. No task.',
    '- New work: call start_session with a clear title, the user\'s request in the prompt, the project it runs in, and provider set to the one agent from the roster whose description fits. Leave use_worktree out: each task gets its own worktree so tasks don\'t collide. Say in one short sentence who got it and why, e.g. "Gave it to Claude, since it\'s UI debugging."',
    '- More about an existing task (a correction, an extra requirement, "it broke again"): call add_to_task on that task. A finished task reopens.',
    '- The user wants someone else on a task ("let Codex do it"): call move_task. One owner at a time; this replaces the owner, it does not add one.',
    settings.askWhenUnsure
      ? '- If you can\'t tell whether a message belongs to an existing task or is new work, ask the user with a question (AskUserQuestion when you have it) and start nothing until they answer.'
      : '- If you can\'t tell whether a message belongs to an existing task, pick the most likely one and say which.',
    'Pick owners only from this roster, by their descriptions. Don\'t balance work by how busy an agent is.',
    roster,
    projects.length ? `Projects you can start work in: ${projects.join(', ')}.` : 'There are no projects yet; ask the user to add one before starting work.',
    'Reply in the user\'s language, in one or two short sentences.',
  ].join('\n');
}

/**
 * Without a coordinator model: the task a terse follow-up continues. A short
 * one-line message sent within ten minutes of the last thing a task said here
 * belongs to that task.
 */
export function quickFollowUpTarget(
  text: string,
  lastTaskEvent: { taskId: string; at: number } | null,
  now: number,
): string | null {
  const line = text.trim();
  if (!line || line.includes('\n') || [...line].length > TEAM_LIMITS.quickFollowUpChars) return null;
  if (!lastTaskEvent || now - lastTaskEvent.at > TEAM_LIMITS.quickFollowUpWindowMs) return null;
  return lastTaskEvent.taskId;
}

/**
 * With no coordinator able to run: what to do with a message in Team. Aegis's
 * own messages (a task's result) are only shown; a short follow-up goes to the
 * task it is about; anything else waits for a coordinator.
 */
export function teamFallbackAction(
  message: { prompt: string; internal: boolean },
  lastTaskEvent: { taskId: string; at: number } | null,
  now: number,
): { kind: 'show' } | { kind: 'add'; taskId: string } | { kind: 'none' } {
  if (message.internal) return { kind: 'show' };
  const taskId = quickFollowUpTarget(message.prompt, lastTaskEvent, now);
  return taskId ? { kind: 'add', taskId } : { kind: 'none' };
}

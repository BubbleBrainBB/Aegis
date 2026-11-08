// The one Team conversation: its session, the coordinator that runs it and
// the context the coordinator reads every turn (shared/team.ts has the rules).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProvider } from '../../shared/types';
import {
  eligibleAgents,
  teamInstructions,
  teamRoster,
  type TeamCandidate,
  type TeamModelChoice,
} from '../../shared/team';
import { getAgentRuntimeDirectory } from './agent-runtime-directory';
import { getAppPreferences } from './app-preferences';
import { chatsRoot } from './chat-folders';
import * as sessions from './session-store';
import type { SessionRow } from '../types';

/** Whether an agent is at its plan's usage limit; providers without a signal answer false. */
export type LimitProbe = (provider: AgentProvider) => Promise<boolean>;

const READY_TTL_MS = 60_000;
let readyCache: { at: number; candidates: TeamCandidate[] } | null = null;

export function teamSession(): SessionRow | undefined {
  return sessions.findSessionByRole('team');
}

export function isTeamSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    return sessions.getSession(sessionId)?.session_role === 'team';
  } catch {
    // No session database (tools built outside the app): nothing is Team.
    return false;
  }
}

/** The Team session, made on first use in its own folder under the chats folder. */
export function ensureTeamSession(): SessionRow {
  const existing = teamSession();
  if (existing) return existing;
  const { coordinator } = getAppPreferences().team;
  const cwd = join(chatsRoot(), 'Team');
  mkdirSync(cwd, { recursive: true });
  const created = sessions.createSession({
    title: 'Team',
    cwd,
    projectCwd: cwd,
    provider: coordinator.provider ?? 'claude',
    ...(coordinator.model ? { model: coordinator.model } : {}),
    // Its tasks run in the background and inherit this, so they must not stop
    // for approvals no one is watching. The composer's pill can change it.
    claudeAccessMode: 'fullAccess',
    codexPermissionMode: 'fullAccess',
    opencodePermissionMode: 'fullAccess',
  });
  sessions.setSessionRole(created.id, 'team');
  return sessions.getSession(created.id) ?? created;
}

/** Every agent, with why it can't take work right now (null when it can). */
export async function teamCandidates(limitReached?: LimitProbe, force = false): Promise<TeamCandidate[]> {
  if (!force && readyCache && Date.now() - readyCache.at < READY_TTL_MS) return readyCache.candidates;
  const report = await getAgentRuntimeDirectory(force);
  const candidates = await Promise.all(report.entries.map(async (entry): Promise<TeamCandidate> => {
    let unavailable: string | null = null;
    if (entry.state === 'login_required') unavailable = 'not signed in';
    else if (entry.state !== 'ready') unavailable = 'not installed or not working';
    else if (limitReached && await limitReached(entry.provider).catch(() => false)) unavailable = 'at its usage limit';
    return { provider: entry.provider, label: entry.title, unavailable };
  }));
  readyCache = { at: Date.now(), candidates };
  return candidates;
}

/**
 * Who runs the coordinator this turn: the chosen agent when it can run,
 * else the fallback, else nobody (the no-model path takes over).
 */
export function pickCoordinator(candidates: TeamCandidate[]): TeamModelChoice | null {
  const { coordinator, fallback } = getAppPreferences().team;
  const runs = (choice: TeamModelChoice) =>
    Boolean(choice.provider && candidates.some((candidate) => candidate.provider === choice.provider && !candidate.unavailable));
  if (runs(coordinator)) return coordinator;
  if (runs(fallback)) return fallback;
  return null;
}

/** What the coordinator reads with every message: rules, roster and projects. */
export function teamTurnContext(candidates: TeamCandidate[]): string {
  const settings = getAppPreferences().team;
  const projects = sessions.listProjects();
  return `\n\n<team_coordinator>\n${teamInstructions(settings, teamRoster(settings, candidates), projects)}\n</team_coordinator>`;
}

/** Whether the coordinator may give this agent work now. */
export function canTakeWork(provider: AgentProvider, candidates: TeamCandidate[]): { ok: true } | { ok: false; error: string } {
  const settings = getAppPreferences().team;
  const candidate = candidates.find((entry) => entry.provider === provider);
  if (!candidate) return { ok: false, error: `${provider} is not an agent Aegis knows.` };
  if (!eligibleAgents(settings, [candidate]).length) {
    return {
      ok: false,
      error: candidate.unavailable
        ? `${candidate.label} can't take work right now: ${candidate.unavailable}. Pick another agent from the roster.`
        : `${candidate.label} is off in Team settings. Pick another agent from the roster.`,
    };
  }
  return { ok: true };
}

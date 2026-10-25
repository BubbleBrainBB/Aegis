// The propose_follow_up / withdraw_follow_up / start_session app tools. Only
// in-process (Claude) session servers offer them: the caller is bound by
// closure, never taken from the model's input or guessed across sessions.

import { z } from 'zod';
import { isProposeFollowUpToolName, isStartSessionToolName } from '../../../shared/follow-up';
import type { StreamMessage } from '../../types';
import { findPendingToolUse } from '../tool-caller-attribution';
import { FOLLOW_UP_LIMITS, SUB_SESSION_LIMITS } from './brief';
import type { ProposeArgs, StartSessionArgs, ToolOutcome } from './service';

export const PROPOSE_FOLLOW_UP_DESCRIPTION = [
  'Propose a separate follow-up task to the user: a problem you found that is outside your current task,',
  'that you have concrete evidence for, and that can be checked on its own. The user sees a card and decides',
  'whether it runs in a new session on its own git branch, here after your current work, or not at all.',
  'The call returns immediately; keep working on your current task, and do not do the proposed work yourself',
  'unless the user asks. Do not propose work your current task needs in order to be done, small fixes that are',
  'clearly within what you were asked to do, guesses, or general style suggestions.',
].join(' ');

export const WITHDRAW_FOLLOW_UP_DESCRIPTION =
  'Withdraw a follow-up task you proposed in this conversation that the user has not acted on yet, for example because your current task ended up fixing it.';

export const START_SESSION_DESCRIPTION = [
  'Start a separate Claude session for the user, nested under this one in their sidebar, that works on one task in parallel with you.',
  'Use it only when the user asked in their own words for a separate, parallel or background session ("open a new session to fix X",',
  '"start another one for the tests"); one call per independent task they named. For work the user did not ask to split off, use',
  'propose_follow_up instead, and for parts of your own task use subagents. By default the new session shares this folder;',
  'it gets its own git worktree when this session is in one, or when use_worktree is true (set it when the user asks for a',
  'worktree or the two of you would edit the same files). Write the prompt for someone who has not seen this conversation:',
  'the task, the files or area, what done looks like. The session starts at once and runs on its own; each time it finishes a',
  'turn its reply comes back to you as a message, after every session you started has finished. Do not wait for it.',
].join(' ');

export const startSessionSchema = {
  title: z.string().min(1).max(SUB_SESSION_LIMITS.title).describe('Under 60 characters; names the task in the sidebar, such as "Fix empty export file names".'),
  prompt: z
    .string()
    .min(1)
    .max(SUB_SESSION_LIMITS.prompt)
    .describe('The brief: the task, the files or area, constraints from this conversation, and what done looks like.'),
  use_worktree: z
    .boolean()
    .optional()
    .describe('true: its own git worktree. false: this folder. Omit to follow this session (a worktree only if this session is in one).'),
};

export const proposeFollowUpSchema = {
  title: z.string().min(1).max(FOLLOW_UP_LIMITS.title).describe('A short name for the task, such as "Fix empty file names on export".'),
  reason: z.string().min(1).max(FOLLOW_UP_LIMITS.reason).describe('What you found and the evidence: files, lines, output.'),
  plan: z.string().min(1).max(FOLLOW_UP_LIMITS.plan).describe('What the task should do, and which files it is likely to touch.'),
  acceptance_criteria: z
    .string()
    .min(1)
    .max(FOLLOW_UP_LIMITS.acceptanceCriteria)
    .describe('How to tell the task is done, including how to verify it.'),
};

export const withdrawFollowUpSchema = {
  proposal_id: z.string().min(1).describe('The proposalId the propose_follow_up call returned.'),
};

export interface FollowUpToolEntry {
  propose(callerSessionId: string, toolUseId: string | null, args: ProposeArgs): ToolOutcome;
  startSession(callerSessionId: string, toolUseId: string | null, args: StartSessionArgs): Promise<ToolOutcome>;
  withdraw(callerSessionId: string, proposalId: string): ToolOutcome;
  history(sessionId: string): StreamMessage[];
}

let entry: FollowUpToolEntry | null = null;
const claimed = new Set<string>();

export function setFollowUpToolEntry(next: FollowUpToolEntry | null): void {
  entry = next;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (outcome: ToolOutcome): ToolText =>
  outcome.ok ? { content: [{ type: 'text', text: outcome.text }] } : { content: [{ type: 'text', text: outcome.error }], isError: true };

/**
 * The tool_use this call belongs to, so the chat can draw the card in place.
 * The runtime may name it in the request meta; otherwise it is the caller's
 * own pending call with the same input (its tool_use may land a moment later).
 */
async function resolveToolUseId(
  host: FollowUpToolEntry,
  callerSessionId: string,
  args: unknown,
  extra: unknown,
  matches: (name: unknown) => boolean = isProposeFollowUpToolName,
): Promise<string | null> {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const fromMeta = meta?.['claudecode/toolUseId'];
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = findPendingToolUse(host.history(callerSessionId), matches, args, claimed);
    if (found) {
      claimed.add(found);
      return found;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function proposeFollowUpTool(callerSessionId: string, args: ProposeArgs, extra?: unknown): Promise<ToolText> {
  if (!entry) return text({ ok: false, error: 'Follow-up tasks are not available right now.' });
  try {
    const toolUseId = await resolveToolUseId(entry, callerSessionId, args, extra);
    return text(entry.propose(callerSessionId, toolUseId, args));
  } catch (error) {
    return text({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function startSessionTool(callerSessionId: string, args: StartSessionArgs, extra?: unknown): Promise<ToolText> {
  if (!entry) return text({ ok: false, error: 'Starting sessions is not available right now.' });
  try {
    const toolUseId = await resolveToolUseId(entry, callerSessionId, args, extra, isStartSessionToolName);
    return text(await entry.startSession(callerSessionId, toolUseId, args));
  } catch (error) {
    return text({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function withdrawFollowUpTool(callerSessionId: string, args: { proposal_id: string }): Promise<ToolText> {
  if (!entry) return text({ ok: false, error: 'Follow-up tasks are not available right now.' });
  try {
    return text(entry.withdraw(callerSessionId, args.proposal_id));
  } catch (error) {
    return text({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

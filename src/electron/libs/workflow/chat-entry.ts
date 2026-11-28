// In-chat entry (plan §8): a chat session hands a request that involves other
// agents to the workflow engine through the `start_workflow` app tool. The
// session only submits the request; the Planner turns it into a declarative
// workflow and the engine runs it. The call returns at once and the outcome
// comes back to the session as a follow-up turn.

import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { isStartWorkflowToolName } from '../../../shared/workflow';
import { findPendingToolUse } from '../tool-caller-attribution';
import type { StreamMessage } from '../../types';
import { repoInfo, sameRepository } from './workspace-snapshot';

export const START_WORKFLOW_DESCRIPTION = [
  'Hand a request that involves other coding agents to the Aegis workflow engine, for example',
  '"have DeepSeek review your changes" or "let Codex implement this and Claude review it".',
  'The app plans the workflow, runs the other agents and shows their progress in this conversation.',
  'Use the planning agent, exact model and reasoning effort the user chose. If any choice is missing or ambiguous,',
  'ask the user for the missing choices in chat and wait for their reply before calling. Never guess or substitute a default.',
  'A reviewer or implementer can be a different agent from the planner. If the selection is unavailable,',
  'tell the user why and wait for their decision before retrying.',
  'If the workflow needs fixes from you, they arrive as follow-up messages; do them and reply as asked.',
  'The call returns immediately. The result arrives as a follow-up message when the workflow ends,',
  'so end your turn after a successful call: do not wait, poll, or do the other agents\' work yourself.',
  'Use it only when the user asks for other agents to take part.',
  'The agents work in this conversation\'s folder. If the changes are in another folder of the same Git repository',
  '(for example a separate worktree), pass that folder as `cwd`.',
].join(' ');

const START_WORKFLOW_CWD_DESCRIPTION =
  "Absolute path of the folder the agents work in, when the changes are not in this conversation's folder, for example another worktree of the same repository. Omit it otherwise.";

const plannerField = (description: string) => z.string().min(1).regex(/\S/).describe(description);

export const startWorkflowSchema = {
  planner: z.object({
    agent: plannerField('Provider ID of the agent the user chose to plan this workflow.'),
    model: plannerField('Exact model ID or model name the user chose for the planner.'),
    reasoningEffort: plannerField('Reasoning effort the user chose for this planning model.'),
  }),
  request: z
    .string()
    .min(1)
    .describe("The user's request, self-contained and in the user's words (which agents, what they should do)."),
  context: z
    .string()
    .optional()
    .describe('What the other agents need to know from this conversation, such as a summary of the changes you made.'),
  cwd: z.string().optional().describe(START_WORKFLOW_CWD_DESCRIPTION),
};

const workflowInput = z.object(startWorkflowSchema);
export type StartWorkflowArgs = z.infer<typeof workflowInput>;

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export type WorkflowChatEntry = (call: StartWorkflowArgs & { callerSessionId: string | null }) => Promise<
  { ok: true; runId: string; text: string } | { ok: false; error: string }
>;

let entry: WorkflowChatEntry | null = null;

export function setWorkflowChatEntry(handler: WorkflowChatEntry | null): void {
  entry = handler;
}

/** Tool handler shared by the in-process (Claude) and HTTP session MCP servers. */
export async function startWorkflowTool(callerSessionId: string | null, args: StartWorkflowArgs): Promise<ToolText> {
  if (!entry) return { content: [{ type: 'text', text: 'Workflows are not available right now.' }], isError: true };
  try {
    const parsed = workflowInput.safeParse(args);
    if (!parsed.success) {
      const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
      return { content: [{ type: 'text', text: `Invalid workflow input (${fields}). Ask the user for the missing or ambiguous choices of planning agent, model and reasoning effort before retrying.` }], isError: true };
    }
    const result = await entry({ ...parsed.data, callerSessionId });
    return result.ok
      ? { content: [{ type: 'text', text: result.text }] }
      : { content: [{ type: 'text', text: result.error }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

/**
 * Where a chat-started workflow works: the conversation's folder, or a folder
 * the agent named that belongs to the same repository (e.g. another worktree).
 */
export async function workflowTargetFolder(
  sessionCwd: string,
  requested: string | undefined,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const raw = requested?.trim();
  if (!raw || path.resolve(sessionCwd, raw) === path.resolve(sessionCwd)) return { ok: true, cwd: sessionCwd };
  if (!path.isAbsolute(raw)) return { ok: false, error: `cwd must be an absolute path: ${raw}` };
  const cwd = path.resolve(raw);
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) return { ok: false, error: `cwd is not a folder: ${cwd}` };
  if (!(await repoInfo(cwd).then(() => true, () => false))) {
    return { ok: false, error: `cwd is not inside a Git working tree: ${cwd}` };
  }
  if (!(await sameRepository(sessionCwd, cwd))) {
    return { ok: false, error: `${cwd} is not part of this conversation's Git repository (${sessionCwd}).` };
  }
  return { ok: true, cwd };
}

export function findPendingStartWorkflowCall(history: StreamMessage[], input: StartWorkflowArgs, claimed: ReadonlySet<string>): string | null {
  return findPendingToolUse(history, isStartWorkflowToolName, input, claimed);
}

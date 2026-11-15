// The main bot's tools, as Bubble host tools. Only its own conversation gets
// them (bubbleHostTools). They change nothing but Aegis's own state, and each
// task still runs under its agent's own permission mode, so they run without
// asking, the way the composer's Send does.

import {
  GET_TASK_TOOL,
  LIST_PROJECTS_TOOL,
  LIST_TASKS_TOOL,
  MAIN_BOT_LIMITS,
  MESSAGE_TASK_TOOL,
  START_TASK_TOOL,
  STOP_TASK_TOOL,
} from '../../../shared/main-bot';
import type { ListTasksArgs, MainBotService, StartTaskArgs, ToolOutcome } from './service';

let service: MainBotService | null = null;
let mainSessionId: (() => string | null) | null = null;

export function setMainBotTools(next: MainBotService | null, sessionId: (() => string | null) | null): void {
  service = next;
  mainSessionId = sessionId;
}

/** Whether a session is the main bot's conversation. */
export function isMainBotSession(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && mainSessionId?.() === sessionId;
}

const TASK_REF = 'The task: the id list_tasks gives (such as #128), or its exact title.';

const SPECS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(bot: MainBotService, args: Record<string, unknown>): ToolOutcome | Promise<ToolOutcome>;
}> = [
  {
    name: LIST_TASKS_TOOL,
    description:
      "The person's tasks on this Mac and on the Macs it controls: id, title, where each runs, its agent, how it stands (working, needs approval, asks, failed, idle) and when it was last active. " +
      'Without a filter: everything going on and what ended in the last week.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['working', 'needs approval', 'asks', 'failed', 'idle'] },
        project: { type: 'string', description: "A project's folder name." },
        device: { type: 'string', description: 'The name of one Mac, or "this Mac".' },
        query: { type: 'string', description: 'Words from the title.' },
        include_idle: { type: 'boolean', description: 'Also tasks that ended more than a week ago.' },
      },
    },
    run: (bot, args) => bot.listTasks(args as ListTasksArgs),
  },
  {
    name: GET_TASK_TOOL,
    description: 'One task in detail: how it stands, what it waits for, what it was last asked and its latest reply. For more of a task on this Mac, read_session takes its number.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: { task: { type: 'string', description: TASK_REF } },
    },
    run: (bot, args) => bot.getTask(args as { task: string }),
  },
  {
    name: LIST_PROJECTS_TOOL,
    description: 'This Mac and the Macs it controls: whether each is online, its projects, and the agents ready to take work there.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: (bot) => bot.listProjects(),
  },
  {
    name: START_TASK_TOOL,
    description:
      'Start a task: a session of a coding agent that works on its own in one project, on this Mac or another, and that the person can open. ' +
      'One call per independent piece of work. Its reply comes back to you as a message when its turn ends; do not wait for it. ' +
      'In a git project it gets its own worktree, so tasks can run side by side.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'prompt'],
      properties: {
        title: { type: 'string', maxLength: MAIN_BOT_LIMITS.title, description: 'Under 60 characters; names the task in the sidebar, such as "Fix empty export file names".' },
        prompt: { type: 'string', maxLength: MAIN_BOT_LIMITS.prompt, description: 'The brief, for an agent that has not seen this conversation: the goal, where to look, what done means.' },
        project: { type: 'string', description: "The project it works in: a folder name list_projects gives, or a full path on this Mac. Left out: a conversation with no project, for work that needs no project's files." },
        device: { type: 'string', description: 'The Mac it runs on, by name. Needed only when the project is on several.' },
        agent: { type: 'string', description: 'Only when the person named one (Claude, Codex, …). Left out: the agent they use in that project.' },
        model: { type: 'string', description: "Only when the person named one. Left out: that agent's usual model." },
        worktree: { type: 'boolean', description: 'Leave out. false only when the person wants the work done in the project folder itself.' },
      },
    },
    run: (bot, args) => bot.startTask(args as unknown as StartTaskArgs),
  },
  {
    name: MESSAGE_TASK_TOOL,
    description:
      'Send a message to a task that exists: more work, an answer to its question, a correction. Any task the person means, not only ones you started; ' +
      'one that a workflow or another task runs is closed to you, and list_tasks says so. ' +
      'A task that is working gets it when its current turn ends. Its reply comes back to you as a message; do not wait for it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'message'],
      properties: {
        task: { type: 'string', description: TASK_REF },
        message: { type: 'string', maxLength: MAIN_BOT_LIMITS.prompt, description: 'Self-contained: the task sees only this, not your conversation.' },
      },
    },
    run: (bot, args) => bot.messageTask(args as { task: string; message: string }),
  },
  {
    name: STOP_TASK_TOOL,
    description: 'Stop a task that is working, when the person asks for that. What it has done so far stays.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: { task: { type: 'string', description: TASK_REF } },
    },
    run: (bot, args) => bot.stopTask(args as { task: string }),
  },
];

/** The host tools for a turn of the main bot's conversation. */
export function createMainBotTools(): object[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    readOnly: true,
    effect: 'read' as const,
    async execute(args: Record<string, unknown>) {
      if (!service) return { content: 'The main bot is not available right now.', isError: true };
      try {
        const outcome = await spec.run(service, args ?? {});
        return outcome.ok ? { content: outcome.text, isError: false } : { content: outcome.error, isError: true };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  }));
}

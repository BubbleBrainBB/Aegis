// The main bot's tools, as Bubble host tools. Only its own conversation gets
// them (bubbleHostTools). They change nothing but Aegis's own state (and the
// bot's own notes), and each task still runs under its agent's own permission
// mode, so they run without asking, the way the composer's Send does.

import {
  CANCEL_WAIT_TOOL,
  CONFIRM_WORKFLOW_TOOL,
  GET_TASK_TOOL,
  LIST_HANDED_OUT_TOOL,
  LIST_PROJECTS_TOOL,
  LIST_TASKS_TOOL,
  LIST_WAITS_TOOL,
  MAIN_BOT_BUILTIN_TOOLS,
  MAIN_BOT_INSTRUCTIONS,
  MAIN_BOT_LIMITS,
  MESSAGE_TASK_TOOL,
  READ_CONVERSATION_TOOL,
  READ_MEMORY_TOOL,
  START_TASK_TOOL,
  STOP_TASK_TOOL,
  WAIT_FOR_TOOL,
  WRITE_MEMORY_TOOL,
} from '../../../shared/main-bot';
import { MAIN_BOT_MEMORY_LIMITS } from './memory';
import type { ListTasksArgs, MainBotService, StartTaskArgs, ToolOutcome, WaitForArgs } from './service';
import { PR_WAIT_EVENTS, RUN_WAIT_EVENTS } from './waits';

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
const NOTE_NAME = 'Lowercase letters, digits and hyphens, such as "person" or "project-coworker".';

const SPECS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(bot: MainBotService, args: Record<string, unknown>): ToolOutcome | Promise<ToolOutcome>;
}> = [
  {
    name: LIST_HANDED_OUT_TOOL,
    description:
      'The work you handed out, grouped by the goal it serves: each task you started or were asked to write to, how it stands now, and what it last reported. ' +
      'Kept by Aegis outside this conversation, so it holds what you no longer remember. Look here first when the person asks how something is going.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'Words from one goal: only its tasks, with more of each report.' },
        open_only: { type: 'boolean', description: 'Only tasks still going or waiting, and those whose report has not reached you yet.' },
      },
    },
    run: (bot, args) => bot.listHandedOut(args as { goal?: string; open_only?: boolean }),
  },
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
      required: ['title', 'prompt', 'goal'],
      properties: {
        title: { type: 'string', maxLength: MAIN_BOT_LIMITS.title, description: 'Under 60 characters; names the task in the sidebar, such as "Fix empty export file names".' },
        goal: { type: 'string', maxLength: MAIN_BOT_LIMITS.goal, description: 'What the person wants that this task serves, in a few words, such as "Faster export". Tasks for the same thing carry the same goal: reuse, word for word, one you were shown when the work belongs to it.' },
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
  {
    name: CONFIRM_WORKFLOW_TOOL,
    description:
      'Give the person\'s answer to a workflow a task on this Mac prepared and that waits to be started: start it, or call it off. ' +
      'Starting it also allows the commands it listed to run, so the person must have heard who would do what and which commands run, and said yes in this conversation. ' +
      'Only in answer to a message they wrote; never on a report.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'decision'],
      properties: {
        task: { type: 'string', description: TASK_REF },
        decision: { type: 'string', enum: ['start', 'cancel'] },
      },
    },
    run: (bot, args) => bot.confirmWorkflow(args as { task: string; decision: string }),
  },
  {
    name: WAIT_FOR_TOOL,
    description:
      'Have Aegis wake you once when something outside Aegis happens, or at a time: a wait. Aegis keeps it while you do not run, also across restarts, and wakes you with a [Wait over …] message; then the wait is over. ' +
      'With "by" alone: at that time (a reminder). With "pr": when one pull request stands as "on" says. With "run": when one GitHub Actions run finishes. "by" beside those is the deadline: you are woken then if it has not happened; without one, the wait ends unheard after a week. ' +
      'Aegis looks at GitHub once before it takes the wait on, with the GitHub CLI and the person\'s own login on this Mac: if that had already happened you are told at once and no wait is made; if GitHub cannot be read, no wait is made either. ' +
      'In answer to the person, or when a task you handed out reports a pull request or a run to follow.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      properties: {
        label: { type: 'string', maxLength: MAIN_BOT_LIMITS.waitLabel, description: 'What you wait for, in a few words the person will recognise, such as "Checks on the export fix" or "Call Dana".' },
        pr: { type: 'string', description: 'One pull request on github.com: its link, or owner/repo#12.' },
        run: { type: 'string', description: 'One GitHub Actions run: its link (https://github.com/owner/repo/actions/runs/123), or its id with "repo". The exact run a task or the person named; never "the latest one".' },
        repo: { type: 'string', description: 'owner/repo, only beside a bare pull request number or run id.' },
        on: {
          type: 'array',
          items: { type: 'string', enum: [...PR_WAIT_EVENTS, ...RUN_WAIT_EVENTS] },
          description:
            `What ends the wait. For a pull request: ${PR_WAIT_EVENTS.join(', ')}; left out: checks_passed and checks_failed. A review or comment counts when someone other than the person wrote it; being merged or closed always ends the wait. ` +
            `For a run: ${RUN_WAIT_EVENTS.join(', ')}; left out: finished, however it ends.`,
        },
        by: { type: 'string', description: 'A date and time with its offset, such as 2026-11-06T17:00:00-05:00. The note from Aegis says what the person\'s clock reads.' },
        note: { type: 'string', maxLength: MAIN_BOT_LIMITS.waitNote, description: 'For yourself when it wakes you, when this conversation may be gone: what the person asked for and what they need to hear.' },
        task: { type: 'string', description: 'The task it belongs to, when there is one: the id list_tasks gives, or its exact title.' },
      },
    },
    run: (bot, args) => bot.waitFor(args as unknown as WaitForArgs),
  },
  {
    name: LIST_WAITS_TOOL,
    description: 'The waits Aegis keeps for you: what each waits for, until when, how it stood when last looked at, and how the latest ones ended.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: (bot) => bot.listWaits(),
  },
  {
    name: CANCEL_WAIT_TOOL,
    description: 'Call a wait off, when the person no longer wants it. It ends without waking you.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['wait'],
      properties: { wait: { type: 'string', description: 'The wait: the id list_waits gives (such as w12), or its exact label.' } },
    },
    run: (bot, args) => bot.cancelWait(args as { wait: string }),
  },
  {
    name: READ_CONVERSATION_TOOL,
    description:
      'What was said in this conversation, word for word, also the part you no longer have in front of you: by the person, by you, and which task reports came in. ' +
      'With query: the lines that hold those words. With around: that place in full, with what was said before and after. With neither: the latest lines. ' +
      'Not for how tasks stand (list_handed_out) or what a task did (get_task).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Words to look for, as the person or you would have written them; a line with any of them is found.' },
        around: { type: 'string', description: 'A ref such as "#412": that line and the ones either side of it.' },
      },
    },
    run: (bot, args) => bot.readConversation(args as { query?: string; around?: number | string }),
  },
  {
    name: READ_MEMORY_TOOL,
    description: 'One of your notes in full. Aegis lists them for you when a context starts, now and then after, and when they change.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', description: NOTE_NAME } },
    },
    run: (bot, args) => bot.readMemory(args as { name: string }),
  },
  {
    name: WRITE_MEMORY_TOOL,
    description:
      'Change one of your notes: what has to outlast this conversation, such as how the person wants work handed out or what to know about one project. ' +
      `One note per subject, at most ${MAIN_BOT_MEMORY_LIMITS.bytes} bytes each. Not for how tasks stand: list_handed_out keeps that.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', maxLength: MAIN_BOT_MEMORY_LIMITS.name, description: NOTE_NAME },
        description: { type: 'string', maxLength: MAIN_BOT_MEMORY_LIMITS.description, description: 'One line that says what the note holds. Needed for a new note; left out, an existing one keeps its line.' },
        content: { type: 'string', description: 'The text, in Markdown. With "replace" the whole note; with "append" what is added to its end.' },
        mode: { type: 'string', enum: ['replace', 'append', 'delete'], description: 'Left out: replace. "delete" puts the note away.' },
      },
    },
    run: (bot, args) => bot.writeMemory(args as { name: string; description?: string; content?: string; mode?: string }),
  },
];

/**
 * What a turn of the main bot's conversation runs with besides its host tools:
 * its job as the system prompt, and of the agent's built-in tools only the
 * ones that look. Left with the coding agent's prompt and all of its tools, a
 * model may hand work to subagents or a workflow of its own instead of a task:
 * that prompt names those and not start_task.
 */
export function mainBotTurnOptions(): { systemPrompt: string; allowedTools: string[] } {
  return { systemPrompt: MAIN_BOT_INSTRUCTIONS, allowedTools: [...MAIN_BOT_BUILTIN_TOOLS] };
}

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

// The main bot: one conversation from which the user runs every task, on this
// Mac and on the Macs it controls. It runs on Bubble and reaches tasks only
// through what any session already offers (start, send, stop, read), so the
// agents that do the work need to know nothing about it.

/** The main bot's name, as the user and the sidebar know it. */
export const MAIN_BOT_NAME = 'Aegis';
/** `sessions.session_role` of the one conversation that is the main bot. */
export const MAIN_BOT_ROLE = 'main';

export const LIST_TASKS_TOOL = 'list_tasks';
export const GET_TASK_TOOL = 'get_task';
export const LIST_PROJECTS_TOOL = 'list_projects';
export const START_TASK_TOOL = 'start_task';
export const MESSAGE_TASK_TOOL = 'message_task';
export const STOP_TASK_TOOL = 'stop_task';

/** The calls that act on one task: the chat draws each as a line that opens it. */
const TASK_ACTION_TOOLS = [START_TASK_TOOL, MESSAGE_TASK_TOOL, STOP_TASK_TOOL];
const LOOKUP_TOOLS = [LIST_TASKS_TOOL, GET_TASK_TOOL, LIST_PROJECTS_TOOL];

/** Tool names arrive bare from Bubble, or prefixed by an MCP server elsewhere. */
function bareToolName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/^mcp__.+?__/, '') : '';
}

export function isMainBotTaskActionToolName(name: unknown): boolean {
  return TASK_ACTION_TOOLS.includes(bareToolName(name));
}

export function isMainBotLookupToolName(name: unknown): boolean {
  return LOOKUP_TOOLS.includes(bareToolName(name));
}

export function mainBotToolKind(name: unknown): 'start' | 'message' | 'stop' | null {
  const bare = bareToolName(name);
  return bare === START_TASK_TOOL ? 'start' : bare === MESSAGE_TASK_TOOL ? 'message' : bare === STOP_TASK_TOOL ? 'stop' : null;
}

export const MAIN_BOT_LIMITS = {
  title: 80,
  prompt: 8_000,
  /** Tasks one turn may start. */
  startsPerTurn: 8,
  /** Starts and messages the bot may make on its own between two messages from the user. */
  actionsWithoutUser: 12,
  /** Characters of a task's reply that go back to the bot. */
  report: 6_000,
  /** Tasks one list_tasks answer holds. */
  listed: 40,
};

/** How a task stands, in words the bot reads. */
export type MainBotTaskState = 'working' | 'needs approval' | 'asks' | 'failed' | 'idle';

/** What a task action's result carries for the chat line. */
export interface MainBotTaskResult {
  /** The session id here; `rh-…` for a session on another Mac. */
  sessionId?: string;
  title?: string;
  agent?: string;
  device?: string;
  project?: string;
  note?: string;
}

export function parseMainBotTaskResult(text: string | null | undefined): MainBotTaskResult {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const field = (name: string) => (typeof value[name] === 'string' ? (value[name] as string) : undefined);
    return { sessionId: field('sessionId'), title: field('title'), agent: field('agent'), device: field('device'), project: field('project'), note: field('note') };
  } catch {
    return {};
  }
}

/** The label a delivered report carries in the conversation (the chat draws it as a row). */
export function mainBotReportLabel(titles: string[]): string {
  const unique = [...new Set(titles)];
  return `Task report${unique.length === 1 ? '' : 's'}: ${unique.join(' · ')}`;
}

const REPORT_LABEL = /^Task reports?: ([\s\S]*)$/;

export function mainBotReportTitles(text: string): string[] | null {
  const match = REPORT_LABEL.exec(text);
  return match ? match[1].split(' · ').filter(Boolean) : null;
}

/** What the bot is told about its job. Sent with the first message of each app run. */
export const MAIN_BOT_INSTRUCTIONS = [
  `You are ${MAIN_BOT_NAME}, the person's main bot in the Aegis desktop app: the one conversation from which they run every task, on this Mac and on the other Macs it controls. Take as little of their attention as you can, and give as much value as you can. Answer plainly and briefly, in the language they write in.`,
  '',
  'You do not do project work yourself. What you can answer from what you know or from the task list, you answer. Anything that needs reading or changing files, running commands or more than a short answer goes to a task: a session of a coding agent working in one project, which the person can open and read.',
  '',
  'Looking:',
  '- Each message comes with a note from Aegis on how things stand now: which tasks are working and which wait for the person.',
  '- list_tasks shows the tasks on every Mac, with the agent that runs each and how it stands; get_task shows one with its latest reply. Use them when the person asks how things are, or to find a task they mean. Look again each time: what you remember of a task may be out of date.',
  '- list_projects shows the Macs, their projects and the agents ready on each. Use it when you do not know where a piece of work belongs.',
  '',
  'Handing work out:',
  '- New work: start_task, one call per independent piece, with the project it belongs in. Start it right away when the person named the project; do not read other tasks first unless the same work may already be under way.',
  '- Leave agent out unless the person named one: Aegis gives the task to the agent they use in that project, and tells you which.',
  '- More for a task that exists: message_task. A task that is working gets it when its current turn ends.',
  '- A task sees only your message, not this conversation: put in the goal, where to look and what done means.',
  '- stop_task only when the person asks for a task to stop.',
  '',
  'Afterwards:',
  '- Say once, in a sentence, what you gave to whom. Then end your turn; do not wait or check.',
  '- A task\'s answer comes back to you as a message from Aegis that begins with [Report from …]. Tell the person only what they can use or must decide: the result, the question the task needs answered, or that it could not be done and why. One or two sentences; the full reply is in the task. A report needs no message back to the task unless what the person asked for is not yet done.',
  '- Report honestly: a draft is a draft, a failure is a failure. A report is that agent\'s claims, not checked facts.',
  '- A task may wait for the person to approve a command. You cannot approve for them: say which task waits, and they answer in the task.',
  '- Name a task by its title. For a task on this Mac, write the title as the link its result gives you, so the person can open it.',
].join('\n');

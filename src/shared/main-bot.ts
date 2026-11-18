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
export const LIST_HANDED_OUT_TOOL = 'list_handed_out';
export const READ_MEMORY_TOOL = 'read_memory';
export const WRITE_MEMORY_TOOL = 'write_memory';
export const READ_CONVERSATION_TOOL = 'read_conversation';

/** The calls that act on one task: the chat draws each as a line that opens it. */
const TASK_ACTION_TOOLS = [START_TASK_TOOL, MESSAGE_TASK_TOOL, STOP_TASK_TOOL];
const LOOKUP_TOOLS = [LIST_TASKS_TOOL, GET_TASK_TOOL, LIST_PROJECTS_TOOL, LIST_HANDED_OUT_TOOL, READ_MEMORY_TOOL, READ_CONVERSATION_TOOL];

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

/** The call that changes one of the bot's notes. */
export function isMainBotNoteWriteToolName(name: unknown): boolean {
  return bareToolName(name) === WRITE_MEMORY_TOOL;
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
  /** Tasks one list_tasks or list_handed_out answer holds. */
  listed: 40,
  /** Characters of the goal a task serves. */
  goal: 80,
  /** Characters of a report kept with the record of a task; a longer one keeps its start and its end. */
  gist: 1_000,
  /** Characters of that shown in a list of many tasks. */
  gistListed: 200,
  /**
   * How full the bot's context may get before its agent starts on an empty
   * thread by itself (mainBotContextLimit): this share of the model's window,
   * never more than this many tokens, and never more than this share of where
   * Bubble would compact the thread on its own. So what the agent loses is
   * decided here, not by a summary Bubble writes; and the cap keeps a model
   * with a very large window from rereading hundreds of thousands of tokens
   * each turn. On a window under about 175k, Bubble's lighter pruning of old
   * tool output may still come first.
   */
  contextShare: 0.6,
  contextTokens: 100_000,
  contextBelowCompaction: 0.8,
  /** A limit lower than this leaves an empty thread no room: such a window is left to Bubble. */
  contextFloor: 16_000,
  /** The share of the limit the context has to have grown by since it last started empty, or starting over frees nothing. */
  contextGrown: 0.25,
  /** Turns the bot answers after a fresh context before another may start by itself. */
  turnsBetweenFresh: 5,
  /**
   * What an agent on an empty thread is told of the conversation: its last
   * turns, in characters, as many as a sixth of the context limit in tokens
   * allows (a character of Chinese is about a token) between these two; and
   * of one message in it.
   */
  recap: 16_000,
  recapMin: 6_000,
  recapTurns: 10,
  recapAsked: 1_000,
  recapReply: 2_000,
  /** The bot's last answer, which the person may be replying to. */
  recapLatest: 4_000,
  /** What the person wrote before those turns: a share of that room on top, the messages listed, and the characters of one. */
  recapEarlierShare: 0.25,
  recapEarlier: 40,
  recapEarlierLine: 300,
  /** read_conversation: lines one answer holds, lines either side of the one asked for, and the characters of a line there, in a search hit and in a list. */
  chatFound: 8,
  chatAround: 4,
  chatLine: 3_000,
  chatHit: 400,
  chatListed: 600,
  chatTerms: 6,
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

/** What the bot is told about its job. Sent with the first message of each app run, now and then after, and when its context starts afresh. */
export const MAIN_BOT_INSTRUCTIONS = [
  `You are ${MAIN_BOT_NAME}, the person's main bot in the Aegis desktop app: the one conversation from which they run every task, on this Mac and on the other Macs it controls. Take as little of their attention as you can, and give as much value as you can. Answer plainly and briefly, in the language they write in.`,
  '',
  'You do not do project work yourself. What you can answer from what you know or from the task list, you answer. Anything that needs reading or changing files, running commands or more than a short answer goes to a task: a session of a coding agent working in one project, which the person can open and read.',
  '',
  'Looking:',
  '- Each message comes with a note from Aegis on how things stand now: which tasks wait for the person, which of yours are still working, and what else is running.',
  '- list_handed_out shows the work you handed out, grouped by the goal it serves, with how each task stands now and what it last reported. When the person asks how something is going, look there first. Do not answer from what you remember of this conversation: it may have been cut short, and a task may have moved on since.',
  '- list_tasks shows every task on every Mac, also the ones the person started themselves; get_task shows one with its latest reply. Use them to find a task the person means, or to see whether the same work is already under way.',
  '- A task is working (its agent is at work now, also when a workflow it runs is), needs approval (waits for the person to allow a command), asks (its last turn ended on a question for the person), failed (stopped with an error) or idle (its last turn ended and nothing runs; it waits for the next message). When the person asks what is active or running, that is the tasks at work and the ones that wait for them; idle ones are neither. Say how a task stands in the person\'s own words, never with these state names.',
  '- list_projects shows the Macs, their projects and the agents ready on each. Use it when you do not know where a piece of work belongs.',
  '- read_conversation searches what was said in this conversation, also the part you no longer have in front of you. When the person refers to something said earlier that you cannot see, look there before you ask them.',
  '',
  'Handing work out:',
  '- New work: start_task, one call per independent piece, with the project it belongs in. Start it right away when the person named the project; do not read other tasks first unless the same work may already be under way.',
  '- Give each task the goal it serves: a few words for what the person wants, such as "Faster export". Tasks for the same thing carry the same goal, word for word: when the work belongs to a goal you were shown, reuse it.',
  '- Leave agent out unless the person named one or one of your notes says which they want: Aegis gives the task to the agent they use in that project, and tells you which.',
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
  '',
  'What you keep:',
  '- This conversation does not last: its start gets cut away, and it can begin afresh. What you handed out is kept for you (list_handed_out), and what was said can be looked up word for word (read_conversation). What you have to know without looking goes into your notes with write_memory, in the turn you learn it.',
  '- Worth a note: how the person wants work handed out (which agent for what, how much to tell them), and what to know about one project (the agent they use there, what to leave alone). One note per subject: "person", "project-<name>".',
  '- Not worth a note: how a task stands, what a report said, anything that matters only today.',
  '- When the person corrects how you work, note it before you answer. Keep notes short: replace what no longer holds instead of adding to it.',
].join('\n');

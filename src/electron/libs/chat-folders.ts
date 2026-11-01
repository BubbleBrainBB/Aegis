import { app } from 'electron';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { getAppPreferences } from './app-preferences';
import { branchSlugFromHint } from './worktree-threads';

/**
 * Chats without a project get a folder of their own, Codex style:
 * <chats folder>/<date>/<slug>/ with outputs/ for what the user asked for and
 * work/ for everything else. The folder stays after the chat is deleted; it
 * holds the user's files.
 */
export function chatsRoot(): string {
  return getAppPreferences().chatsFolder || join(app.getPath('documents'), 'Aegis');
}

/** The folder and how to show it, with the home folder as ~. */
export function chatsFolderInfo(): { path: string; display: string } {
  const path = chatsRoot();
  const home = homedir();
  return { path, display: home && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The folder's date and name: the first words of the message, or the time when it has none in Latin script. */
export function chatFolderParts(prompt: string, now: Date): { day: string; name: string } {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const name = branchSlugFromHint(prompt.slice(0, 120)) || `chat-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { day, name };
}

export function createChatFolder(prompt: string, root = chatsRoot(), now = new Date()): string {
  const { day, name } = chatFolderParts(prompt, now);
  mkdirSync(join(root, day), { recursive: true });
  // The date folder must really be inside the chats folder: a link there must
  // not send a chat, and the agent working in it, somewhere else.
  const parent = join(realpathSync(root), day);
  if (realpathSync(parent) !== parent) throw new Error(`${join(root, day)} is a link to another folder.`);
  for (let attempt = 1; ; attempt += 1) {
    const dir = join(parent, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 1000) continue;
      throw error;
    }
    mkdirSync(join(dir, 'outputs'));
    mkdirSync(join(dir, 'work'));
    return dir;
  }
}

/**
 * Which chats already have the folder note. In memory: after a restart a chat
 * gets it once more, which also covers a context compacted meanwhile.
 */
const delivered = new Set<string>();

export function chatFolderInstructions(cwd: string): string {
  return [
    '<chat_folder>',
    `This chat has no project. Aegis made a folder for it, and it is your working directory: ${cwd}`,
    '- Save what the user asked for (reports, documents, images, pages) in outputs/.',
    '- Keep drafts, scripts, downloads and other intermediate files in work/.',
    '- Refer to files by their path relative to this folder, such as outputs/report.md; the user opens them from the chat.',
    'The folder is not a git repository.',
    '</chat_folder>',
  ].join('\n');
}

/** session.start put the note in the first message. */
export function noteChatFolderInstructionsDelivered(sessionId: string) {
  delivered.add(sessionId);
}

/** The folder note for this message, the first time a chat needs it. */
export function takeChatFolderInstructions(sessionId: string, cwd: string | null | undefined, isChat: boolean): string {
  if (!isChat || !cwd || delivered.has(sessionId)) return '';
  delivered.add(sessionId);
  return `\n\n${chatFolderInstructions(cwd)}`;
}

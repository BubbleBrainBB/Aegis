// The main bot's notes: what it has to know however long ago it learned it.
// One markdown file per subject in a folder of its own, so the person can open
// and correct them. The bot is shown them when a context starts, now and then
// after and when they change, and reads or changes one through its tools;
// nothing is extracted on its behalf.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAIN_BOT_MEMORY_LIMITS = {
  /** Characters of a note's name. */
  name: 48,
  /** Characters of the line that says what a note holds. */
  description: 120,
  /** Bytes of one note's text. */
  bytes: 8_000,
  notes: 40,
};

export interface MainBotNote {
  name: string;
  /** One line: what the note holds. */
  description: string;
  /** When its file last changed, by the bot or by hand. */
  updatedAt: number;
  /** Bytes of its text. */
  bytes: number;
}

export type MainBotNoteWrite = { saved: MainBotNote } | { removed: string } | { error: string };

/** A file name that cannot leave the folder. */
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEAD = /^---\n([\s\S]*?)\n---\n?/;
/** What a note's file may weigh beyond its text: the head. */
const HEAD_ROOM = 512;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parse(raw: string): { description: string; content: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const head = HEAD.exec(text);
  const content = (head ? text.slice(head[0].length) : text).trim();
  const described = /^description:[ \t]*(.*)$/m.exec(head?.[1] ?? '')?.[1].trim() ?? '';
  return {
    // A note the person wrote by hand has no head: its first line says what it is.
    description: oneLine(described || (content.split('\n').find((line) => line.trim()) ?? ''), MAIN_BOT_MEMORY_LIMITS.description),
    content,
  };
}

export class MainBotMemory {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    return join(this.dir, `${name}.md`);
  }

  private check(name: string): string | null {
    if (!name) return '"name" is required.';
    if (!NAME.test(name)) {
      return `"name" is lowercase letters, digits and hyphens, at most ${MAIN_BOT_MEMORY_LIMITS.name} characters, such as "person" or "project-coworker".`;
    }
    return null;
  }

  /**
   * One note as it is on disk. `null`: no such file. `'unusable'`: a file is
   * there that is no note (a link, a folder, or grown too large by hand).
   */
  private load(name: string): { note: MainBotNote; content: string } | 'unusable' | null {
    const path = this.path(name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > MAIN_BOT_MEMORY_LIMITS.bytes + HEAD_ROOM) return 'unusable';
    try {
      const { description, content } = parse(readFileSync(path, 'utf8'));
      return { note: { name, description, updatedAt: Math.round(stat.mtimeMs), bytes: Buffer.byteLength(content, 'utf8') }, content };
    } catch {
      return 'unusable';
    }
  }

  /** Every note, by name. Files that are no notes are passed over. */
  index(): MainBotNote[] {
    if (!existsSync(this.dir)) return [];
    const notes: MainBotNote[] = [];
    for (const file of readdirSync(this.dir).sort()) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (!NAME.test(name)) continue;
      const loaded = this.load(name);
      if (loaded && loaded !== 'unusable') notes.push(loaded.note);
    }
    return notes;
  }

  read(name: string): { note: MainBotNote; content: string } | { error: string } {
    const wanted = name?.trim() ?? '';
    const invalid = this.check(wanted);
    if (invalid) return { error: invalid };
    const loaded = this.load(wanted);
    if (loaded && loaded !== 'unusable') return loaded;
    const names = this.index().map((note) => note.name);
    return { error: `There is no note "${wanted}". ${names.length ? `Your notes: ${names.join(', ')}.` : 'You have no notes yet.'}` };
  }

  /** Replace a note, add to its end, or put it away. */
  write(input: { name: string; description?: string; content?: string; mode?: string }): MainBotNoteWrite {
    const name = input.name?.trim() ?? '';
    const invalid = this.check(name);
    if (invalid) return { error: invalid };
    const mode = input.mode?.trim() || 'replace';
    if (mode !== 'replace' && mode !== 'append' && mode !== 'delete') return { error: '"mode" is "replace", "append" or "delete".' };
    const path = this.path(name);
    const before = this.load(name);
    if (before === 'unusable') {
      return { error: `The file of "${name}" was changed by hand into something that is no note (too large, or a link). Use another name, and tell the person.` };
    }
    if (mode === 'delete') {
      if (!before) return { error: `There is no note "${name}" to remove.` };
      // Put away, not destroyed: the person can take it back.
      const trash = join(this.dir, '.trash');
      mkdirSync(trash, { recursive: true });
      renameSync(path, join(trash, `${name}.${Date.now()}.md`));
      return { removed: name };
    }
    const added = input.content?.trim() ?? '';
    if (!added) return { error: `"content" is required. To remove a note, pass mode "delete".` };
    const content = mode === 'append' && before?.content ? `${before.content}\n\n${added}` : added;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAIN_BOT_MEMORY_LIMITS.bytes) {
      return { error: `A note holds at most ${MAIN_BOT_MEMORY_LIMITS.bytes} bytes. Keep what still matters and replace it, or split it by subject.` };
    }
    if (!before && this.index().length >= MAIN_BOT_MEMORY_LIMITS.notes) {
      return { error: `You have ${MAIN_BOT_MEMORY_LIMITS.notes} notes, the most there can be. Merge two or remove one first.` };
    }
    const description = oneLine(input.description ?? '', MAIN_BOT_MEMORY_LIMITS.description) || before?.note.description || '';
    if (!description) return { error: '"description" is required for a new note: one line that says what it holds.' };
    mkdirSync(this.dir, { recursive: true });
    // Written beside the note and moved over it, so a note is never half written.
    const draft = join(this.dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(draft, `---\ndescription: ${description}\n---\n\n${content}\n`, 'utf8');
    renameSync(draft, path);
    const saved = this.load(name);
    return { saved: saved && saved !== 'unusable' ? saved.note : { name, description, updatedAt: Date.now(), bytes } };
  }
}

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, sep } from 'path';

// Config files other tools own (~/.claude.json, ~/.kimi-code/mcp.json,
// opencode.json, ...) are read, changed in one key and written back. Two rules
// keep the user's file safe: a file that exists but does not parse is never
// written over (treating it as empty would replace everything in it with the
// one key Aegis changed), and new content lands in one rename, so neither a
// crash nor the owning tool reading mid-write ever sees half a file.

export class ConfigFileUnreadableError extends Error {
  constructor(readonly filePath: string, reason: string) {
    super(`Aegis left ${displayPath(filePath)} unchanged because it is not valid JSON (${reason}). Fix the file and try again.`);
    this.name = 'ConfigFileUnreadableError';
  }
}

/** The file's top-level object, or `{}` when the file does not exist. Throws
 * ConfigFileUnreadableError when it exists but is not a JSON object; an empty
 * file counts as unreadable too, since that is also what a file looks like
 * while its owner is rewriting it. */
export function readJsonConfigForUpdate<T extends object>(filePath: string): T {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigFileUnreadableError(filePath, text.trim() ? (error instanceof Error ? error.message : String(error)) : 'the file is empty');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileUnreadableError(filePath, 'the top level is not an object');
  }
  return parsed as T;
}

/** Replaces the file with `value` as formatted JSON in one rename. A symlinked
 * config is written through to its target so the link survives, and the file
 * keeps its permission bits unless `mode` sets them (0o600 for files that may
 * name tokens). */
export function writeJsonConfigAtomic(filePath: string, value: unknown, options: { mode?: number } = {}): void {
  const target = resolveWriteTarget(filePath);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });

  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = statSync(target).mode & 0o777;
    } catch {
      // A new file takes the default mode.
    }
  }

  const tempPath = join(directory, `.${basename(target)}.aegis-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tempPath, 'wx', mode ?? 0o666);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== undefined) {
      try {
        // openSync's mode is narrowed by the umask; set the exact bits.
        chmodSync(tempPath, mode);
      } catch {
        // best-effort on exotic filesystems
      }
    }
    renameSync(tempPath, target);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // already renamed or never created
    }
    throw error;
  }
}

function resolveWriteTarget(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function displayPath(filePath: string): string {
  const home = homedir();
  return home && filePath.startsWith(`${home}${sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

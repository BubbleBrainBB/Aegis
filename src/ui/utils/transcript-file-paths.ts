import type { StreamMessage } from '../types';
import { getMessageContentBlocks } from './message-content';
import type { ResolvedProjectFileReference } from './project-file-navigation';

// Directories get one disk check each, so only the most recent ones are tried.
const MAX_DIRECTORIES = 40;
const ABSOLUTE_PATH = /(?:^|[\s"'`(<[=：])((?:\/|[A-Za-z]:[\\/])[^\s"'`<>()[\]|,;，。；：、）】》]*)/g;
const WHOLE_PATH_VALUE = /^(?:\/|[A-Za-z]:[\\/])[^\n]*$/;

function dirnameOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/';
}

function basenameOf(path: string): string {
  return path.split('/').pop() || path;
}

function stringsIn(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => stringsIn(item, into));
}

function absolutePathsIn(text: string): string[] {
  return Array.from(text.matchAll(ABSOLUTE_PATH), (match) => match[1]);
}

/**
 * Where a session's transcript says a file could be, newest first. `files` end
 * in the requested path; `directories` were named in its text or tool calls, or
 * hold a file named there, so a bare name mentioned beside them can live there.
 */
export function collectTranscriptFileCandidates(
  messages: StreamMessage[],
  requestedPath: string
): { files: string[]; directories: string[] } {
  const requested = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const files = new Set<string>();
  const directories = new Set<string>();
  if (!requested) return { files: [], directories: [] };

  const add = (raw: string, toolOutput: boolean) => {
    // Drops the line and text grep prints after a path, then sentence punctuation.
    const cleaned = raw.replace(/\\/g, '/').replace(/:\d+(?::.*)?$/, '').replace(/[.:!?]+$/, '');
    const path = cleaned.replace(/\/+$/, '');
    if (!path) return;
    if (path.endsWith(`/${requested}`)) files.add(path);
    // Tool output names far too many paths to treat its folders as hints.
    if (toolOutput) return;
    const namesDirectory = cleaned.endsWith('/') || !basenameOf(path).includes('.');
    if (namesDirectory) directories.add(path);
    if (!cleaned.endsWith('/')) directories.add(dirnameOf(path));
  };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const block of getMessageContentBlocks(messages[index])) {
      if (block.type === 'text') {
        absolutePathsIn(block.text).forEach((path) => add(path, false));
      } else if (block.type === 'tool_use') {
        const values: string[] = [];
        stringsIn(block.input, values);
        for (const value of values) {
          // A tool argument that is one path may hold spaces ("Application Support");
          // one that only starts with a path may be a command with more paths in it.
          const whole = value.trim();
          if (WHOLE_PATH_VALUE.test(whole)) add(whole, false);
          absolutePathsIn(value).forEach((path) => add(path, false));
        }
      } else if (block.type === 'tool_result') {
        const values: string[] = [];
        stringsIn(block.content, values);
        values.forEach((value) => absolutePathsIn(value).forEach((path) => add(path, true)));
      }
    }
  }
  return { files: [...files], directories: [...directories].slice(0, MAX_DIRECTORIES) };
}

/**
 * Resolve a reference no workspace holds from what the transcript says about
 * it, e.g. a bare `shot.png` the agent wrote to a temp folder. A candidate only
 * counts once it exists on disk; a file named in full beats a folder guess.
 */
export async function resolveTranscriptFileReference(options: {
  requestedPath: string;
  messages: StreamMessage[];
  statFile: (cwd: string, relativePath: string) => Promise<string | null>;
}): Promise<ResolvedProjectFileReference> {
  const { requestedPath, messages, statFile } = options;
  const { files, directories } = collectTranscriptFileCandidates(messages, requestedPath);
  const relative = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const tiers = [
    files.map((path) => [dirnameOf(path), basenameOf(path)] as const),
    directories.map((directory) => [directory, relative] as const),
  ];

  for (const tier of tiers) {
    const found = await Promise.all(tier.map(([cwd, path]) => statFile(cwd, path).catch(() => null)));
    const hits = [...new Set(found.filter((path): path is string => Boolean(path)))];
    if (hits.length === 1) return { status: 'resolved', cwd: dirnameOf(hits[0]), path: hits[0] };
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        matches: hits.map((path) => ({ cwd: dirnameOf(path), path, relativePath: path })),
      };
    }
  }
  return { status: 'not-found' };
}

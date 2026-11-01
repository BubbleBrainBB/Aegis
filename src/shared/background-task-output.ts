/**
 * What the background task peek shows: a command's output tail and the links
 * found in it. Pure, shared by the main process (where the output file is
 * read) and the renderer (which picks lines and links), and unit-testable.
 */

export interface BackgroundTaskOutput {
  /** The end of the output, terminal escapes removed. */
  text: string;
  /** The file holds more than `text`. */
  truncated: boolean;
  /** The session's GitHub repo (owner/repo) from its origin remote, if any. */
  repo?: string;
}

export interface BackgroundTaskLink {
  url: string;
  label: string;
  detail: string;
  /** github: GitHub; local: a dev server on this machine; web: anything else. */
  kind: 'github' | 'local' | 'web';
}

/** Bytes read from the end of an output file. */
export const BACKGROUND_OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * The output file a backgrounded Bash call writes to, from its tool result:
 * "Command running in background with ID: b1. Output is being written to:
 * /private/tmp/claude-501/…/tasks/b1.output. You will be notified …"
 */
export function parseBackgroundOutputPath(text: string): string | null {
  const match = /Output is being written to: (\S+?\.output)(?=[.\s]|$)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Where the CLI keeps a background task's output: an absolute, normalized
 * path ending in tasks/<task id>.output.
 */
export function isTaskOutputPath(path: string, taskId: string): boolean {
  if (!/^[\w-]+$/.test(taskId) || !path.startsWith('/')) return false;
  if (path.split('/').some((part) => part === '.' || part === '..') || path.includes('//')) return false;
  return path.endsWith(`/tasks/${taskId}.output`);
}

// CSI (colors, cursor moves), OSC (titles, hyperlinks) and lone ESC sequences.
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Output as a terminal would leave it: escapes removed, and a line redrawn
 * with carriage returns (progress bars, spinners) keeps only its last draw.
 */
export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(TERMINAL_ESCAPES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const draws = line.split('\r');
      for (let index = draws.length - 1; index >= 0; index -= 1) if (draws[index]) return draws[index];
      return '';
    })
    .join('\n');
}

/** The last `count` lines, a trailing newline not counting as an empty line. */
export function outputTailLines(text: string, count: number): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  return lines.slice(-count);
}

const URL_PATTERN = /https?:\/\/[^\s"'<>`|\\]+/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

function trimUrl(url: string): string {
  let trimmed = url.replace(/[.,;:!?]+$/, '');
  // A closing bracket the URL never opened belongs to the text around it.
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (trimmed.endsWith(close) && trimmed.split(open).length < trimmed.split(close).length) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function describe(raw: string): BackgroundTaskLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname === 'github.com') {
    const [owner, repo, section, id, run] = url.pathname.split('/').filter(Boolean);
    if (owner && repo && section === 'actions' && id === 'runs' && run && /^\d+$/.test(run)) {
      return githubRunLink(`${owner}/${repo}`, run);
    }
    if (owner && repo && section === 'pull' && id && /^\d+$/.test(id)) {
      return {
        url: `https://github.com/${owner}/${repo}/pull/${id}`,
        label: `Open PR #${id} on GitHub`,
        detail: `${owner}/${repo}`,
        kind: 'github',
      };
    }
  }
  if (LOCAL_HOSTS.has(url.hostname)) {
    // A server bound to every interface is reached on localhost.
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
    return {
      url: url.toString(),
      label: `Open ${url.host}`,
      detail: 'in the browser tab',
      kind: 'local',
    };
  }
  const path = `${url.pathname}${url.search}`;
  return {
    url: url.toString(),
    label: `Open ${url.host}`,
    detail: path === '/' ? '' : path,
    kind: 'web',
  };
}

function githubRunLink(repo: string, run: string): BackgroundTaskLink {
  return {
    url: `https://github.com/${repo}/actions/runs/${run}`,
    label: 'Open CI run on GitHub',
    detail: `${repo} · run ${run}`,
    kind: 'github',
  };
}

/**
 * `gh run watch|view|rerun <id>` prints no URL, so its run link comes from
 * the id and the repo (its -R flag, else the session's origin remote).
 */
function ghRunFromCommand(command: string, repo: string | undefined): BackgroundTaskLink | null {
  const run = /\bgh\s+run\s+(?:watch|view|rerun)\b[^\n;&|]*?\s(\d{5,})\b/.exec(command);
  if (!run) return null;
  const flag = /(?:^|\s)(?:-R|--repo)(?:\s+|=)(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)/.exec(command);
  const target = flag?.[1] ?? repo;
  return target ? githubRunLink(target.replace(/\.git$/, ''), run[1]) : null;
}

/**
 * Links worth opening from a task, newest first: URLs in its output (latest
 * line first), then in its command. Job URLs of one GitHub Actions run fold
 * into that run; a `gh run` command with no run URL in sight leads with the
 * run it names.
 */
export function backgroundTaskLinks(
  { command, output, repo }: { command?: string; output?: string; repo?: string },
  limit = 2
): BackgroundTaskLink[] {
  const found: BackgroundTaskLink[] = [];
  const seen = new Set<string>();
  const add = (link: BackgroundTaskLink | null) => {
    if (!link || seen.has(link.url)) return;
    seen.add(link.url);
    found.push(link);
  };
  for (const text of [output ?? '', command ?? '']) {
    const urls = [...text.matchAll(URL_PATTERN)].map((match) => trimUrl(match[0]));
    for (let index = urls.length - 1; index >= 0; index -= 1) add(describe(urls[index]));
  }
  const run = ghRunFromCommand(command ?? '', repo);
  if (run && !seen.has(run.url)) found.unshift(run);
  return found.slice(0, limit);
}

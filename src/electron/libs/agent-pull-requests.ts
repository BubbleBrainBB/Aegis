import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StreamMessage } from '../../shared/types';
import * as sessions from './session-store';
import { parseGitHubRepoFromRemote, parseGitHubPullRequestUrl, pullRequestExtras, sameGitHubRepo, samePullRequest } from './git-pull-requests';

const exec = promisify(execFile);

// gh run as a command (start, after a shell operator, or as `zsh -lc`'s
// script), not the words inside a grep pattern or commit message.
const PR_CREATE_COMMAND = /(?:^|(?<!\\)[;&|(\n]|\s-\w*c\s+['"]?)\s*gh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)/gi;

/** `gh pr create` calls still waiting for their output, by tool_use id. */
const pendingCreates = new Map<string, string>();

function commandOf(input: Record<string, unknown>): string {
  for (const value of [input.command, input.cmd, input.shellCommand, input.shell_command]) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter(part => typeof part === 'string').join(' ');
  }
  return '';
}

/**
 * The PR URL an agent's `gh pr create` printed, once its output arrives.
 * Only the output of that command counts: a URL the agent merely read
 * (`gh pr view`, a file, a web page) does not tie the PR to the session.
 */
export function pullRequestCreatedBy(sessionId: string, message: StreamMessage): string | null {
  if ((message.type !== 'assistant' && message.type !== 'user') || !Array.isArray(message.message.content)) return null;
  let created: string | null = null;
  for (const block of message.message.content) {
    if (block.type === 'tool_use' && PR_CREATE_COMMAND.test(commandOf(block.input ?? {}))) {
      pendingCreates.set(block.id, sessionId);
    } else if (block.type === 'tool_result' && pendingCreates.get(block.tool_use_id) === sessionId) {
      pendingCreates.delete(block.tool_use_id);
      // gh prints the new PR last; "already exists" errors name the branch's PR.
      const urls = typeof block.content === 'string' ? [...block.content.matchAll(PR_URL)] : [];
      if (urls.length) created = urls[urls.length - 1][0];
    }
  }
  return created;
}

async function git(cwd: string, args: string[]) {
  return (await exec('git', args, { cwd, timeout: 5000 })).stdout.trim();
}

/**
 * Ties a PR the agent created to its session, the way the Create PR button
 * does. The PR must belong to one of the workspace's GitHub remotes and is
 * re-read from GitHub, so a stray URL in the output cannot attach anything.
 * Resolves true when a new association was stored.
 */
export async function attachAgentPullRequest(sessionId: string, url: string): Promise<boolean> {
  const session = sessions.getSession(sessionId);
  if (!session || session.hidden_from_threads || session.conversation_scope === 'dm') return false;
  const cwd = session.worktree_path || session.cwd || session.project_cwd;
  const prRepo = parseGitHubPullRequestUrl(url);
  if (!cwd || !prRepo) return false;

  const [repoRoot, remotes] = await Promise.all([git(cwd, ['rev-parse', '--show-toplevel']), git(cwd, ['remote', '-v'])]);
  const remoteRepos = remotes.split('\n').flatMap(line => parseGitHubRepoFromRemote(line.split(/\s+/)[1] ?? '') ?? []);
  const literal = (repo: { owner: string; repo: string }) =>
    `${repo.owner}/${repo.repo}`.toLowerCase() === `${prRepo.owner}/${prRepo.repo}`.toLowerCase();
  const ownsRepo = remoteRepos.some(literal) ||
    (await Promise.all(remoteRepos.map(repo => sameGitHubRepo(repo, prRepo)))).some(Boolean);
  if (!ownsRepo) return false;

  const { stdout } = await exec('gh', ['pr', 'view', url, '--json', 'number,title,state,url,headRefName,isDraft,additions,deletions'], {
    cwd, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  const pr = JSON.parse(stdout) as {
    number?: unknown; title?: unknown; state?: unknown; url?: unknown; headRefName?: unknown;
    isDraft?: unknown; additions?: unknown; deletions?: unknown;
  };
  const state = pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : null;
  if (typeof pr.number !== 'number' || typeof pr.title !== 'string' || typeof pr.url !== 'string' ||
      !state || !(await samePullRequest(pr.url, url))) return false;

  return sessions.attachSessionPullRequest(sessionId, {
    number: pr.number,
    title: pr.title,
    state,
    url: pr.url,
    ...pullRequestExtras(pr),
    repoRoot,
    headBranch: typeof pr.headRefName === 'string' ? pr.headRefName : '',
    attachedAt: Date.now(),
  });
}

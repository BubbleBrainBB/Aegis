import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitPullRequestLookupStatus, GitPullRequestSummary } from '../../shared/types';
const execFileAsync = promisify(execFile);

export function parseGitHubRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const normalized = remoteUrl.trim();
  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/** Draft flag and line counts from `gh pr view --json`, when present. */
export function pullRequestExtras(parsed: { isDraft?: unknown; additions?: unknown; deletions?: unknown }) {
  const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
  return {
    ...(typeof parsed.isDraft === 'boolean' ? { isDraft: parsed.isDraft } : {}),
    ...(count(parsed.additions) !== undefined ? { additions: count(parsed.additions) } : {}),
    ...(count(parsed.deletions) !== undefined ? { deletions: count(parsed.deletions) } : {}),
  };
}

export async function getGitPullRequestInfo(input: {
  cwd: string | undefined;
  branch: string | null;
  originRepo: { owner: string; repo: string } | null;
}): Promise<{
  status: GitPullRequestLookupStatus;
  pr: GitPullRequestSummary | null;
}> {
  if (!input.branch || input.branch === 'HEAD' || !input.originRepo) {
    return { status: 'not_found', pr: null };
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        input.branch,
        '--repo',
        `${input.originRepo.owner}/${input.originRepo.repo}`,
        '--json',
        'number,title,state,url,isDraft,additions,deletions',
      ],
      {
        cwd: input.cwd,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }
    );

    const parsed = JSON.parse(stdout) as {
      number?: number;
      title?: string;
      state?: string;
      url?: string;
      isDraft?: unknown;
      additions?: unknown;
      deletions?: unknown;
    };

    if (
      typeof parsed.number === 'number' && Number.isSafeInteger(parsed.number) && parsed.number > 0 &&
      typeof parsed.title === 'string' &&
      typeof parsed.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(parsed.url) &&
      (parsed.state === 'OPEN' || parsed.state === 'CLOSED' || parsed.state === 'MERGED')
    ) {
      return {
        status: 'found',
        pr: {
          number: parsed.number,
          title: parsed.title,
          state:
            parsed.state === 'OPEN' ? 'open' : parsed.state === 'MERGED' ? 'merged' : 'closed',
          url: parsed.url,
          ...pullRequestExtras(parsed),
        },
      };
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    if (/no pull requests? found/i.test(combined) || /could not resolve to a pullrequest/i.test(combined)) {
      return { status: 'not_found', pr: null };
    }
    return { status: 'unknown', pr: null };
  }

  return { status: 'unknown', pr: null };
}

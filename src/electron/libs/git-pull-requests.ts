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

type GitHubRepo = { owner: string; repo: string };

const REPO_NAME_TTL_MS = 10 * 60_000;
const repoNames = new Map<string, { name: Promise<string | null>; at: number }>();

function repoKey(repo: GitHubRepo) {
  return `${repo.owner}/${repo.repo}`.toLowerCase();
}

/**
 * owner/repo, lowercased, as GitHub names the repository now. A renamed owner,
 * a transferred or a renamed repository keeps answering at its old name
 * (GitHub redirects), so remotes and stored PR URLs can go on using it while
 * gh reports the new one. Null when GitHub cannot be asked.
 */
function currentGitHubRepoName(repo: GitHubRepo): Promise<string | null> {
  const key = repoKey(repo);
  const cached = repoNames.get(key);
  if (cached && Date.now() - cached.at < REPO_NAME_TTL_MS) return cached.name;
  // A full URL pins github.com; a bare owner/repo goes to GH_HOST or gh's default host.
  const name = execFileAsync('gh', ['repo', 'view', `https://github.com/${key}`, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    timeout: 10000,
  }).then(({ stdout }) => stdout.trim().toLowerCase() || null, () => null);
  repoNames.set(key, { name, at: Date.now() });
  // Offline or signed out: ask again next time rather than for the whole TTL.
  void name.then(found => { if (!found && repoNames.get(key)?.name === name) repoNames.delete(key); });
  return name;
}

/** Whether two github.com owner/repo names are the same repository today. */
export async function sameGitHubRepo(a: GitHubRepo, b: GitHubRepo): Promise<boolean> {
  if (repoKey(a) === repoKey(b)) return true;
  const [nameA, nameB] = await Promise.all([currentGitHubRepoName(a), currentGitHubRepoName(b)]);
  return (nameA ?? repoKey(a)) === (nameB ?? repoKey(b));
}

export function parseGitHubPullRequestUrl(url: string): (GitHubRepo & { number: number }) | null {
  const match = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/i);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

/** Whether two PR URLs name the same PR, across owner and repository renames. */
export async function samePullRequest(a: string, b: string): Promise<boolean> {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const prA = parseGitHubPullRequestUrl(a);
  const prB = parseGitHubPullRequestUrl(b);
  return !!prA && !!prB && prA.number === prB.number && sameGitHubRepo(prA, prB);
}

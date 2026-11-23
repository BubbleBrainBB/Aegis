// How Aegis reads GitHub for the main bot's waits: with the machine's `gh`
// CLI, so with the person's own login and nothing kept here. One request per
// look: a pull request with its checks, reviews and comments in one GraphQL
// query, a run from the REST API. Only github.com.

import { GhCliError, rollupChecks, runGh } from '../github-cli';
import { WaitProbeError, type PullRequestSnapshot, type RunSnapshot, type WaitNote, type WaitProbes } from './waits';

type Json = Record<string, unknown>;
type RunGh = (args: string[]) => Promise<string>;

/** Reviews and comments read per look: the latest ones, where anything new is. */
const NOTES_READ = 50;

const PULL_REQUEST_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url state isDraft mergeable headRefOid reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      reviews(last: ${NOTES_READ}) { nodes { id state body submittedAt url author { login __typename } comments(first: 3) { nodes { body path } } } }
      comments(last: ${NOTES_READ}) { nodes { id body createdAt url author { login __typename } } }
    }
  }
}`.replace(/\s+/g, ' ').trim();

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === 'object') : []);
const nodes = (value: unknown): Json[] => list(object(value).nodes);

function probeError(failure: unknown): WaitProbeError {
  if (failure instanceof WaitProbeError) return failure;
  const message = failure instanceof Error ? failure.message : String(failure);
  if (failure instanceof GhCliError && failure.kind !== 'command_failed') return new WaitProbeError(message, failure.kind);
  if (/rate limit|HTTP 429|abuse detection/i.test(message)) return new WaitProbeError(message, 'rate_limited');
  if (/HTTP 404|Not Found|Could not resolve to a/i.test(message)) return new WaitProbeError(message, 'not_found');
  return new WaitProbeError(message, 'failed');
}

function author(value: unknown): { login: string; bot: boolean } {
  const who = object(value);
  const login = text(who.login);
  return { login, bot: text(who.__typename) === 'Bot' || /\[bot\]$/i.test(login) };
}

/** What a review says: its own text, or else the first lines it left on the code. */
function reviewBody(review: Json): string {
  const body = text(review.body).trim();
  if (body) return body;
  return nodes(review.comments)
    .map((comment) => `${text(comment.path) ? `${text(comment.path)}: ` : ''}${text(comment.body).trim()}`)
    .filter((line) => line.trim())
    .join('\n');
}

export function pullRequestSnapshot(repo: string, data: unknown): PullRequestSnapshot {
  const pull = object(object(object(object(data).data).repository).pullRequest);
  if (typeof pull.number !== 'number') throw new WaitProbeError(`GitHub shows no pull request there (${repo}).`, 'not_found');
  const commit = object(nodes(pull.commits)[0]?.commit);
  const contexts = nodes(object(commit.statusCheckRollup).contexts).map((context) => ({
    ...context,
    workflowName: text(object(object(object(context.checkSuite).workflowRun).workflow).name) || undefined,
  }));
  const checks = rollupChecks(contexts);
  const notes: WaitNote[] = [
    ...nodes(pull.reviews).map((review): WaitNote => {
      const by = author(review.author);
      return { id: text(review.id), kind: 'review', author: by.login, bot: by.bot, at: Date.parse(text(review.submittedAt)) || 0, state: text(review.state), body: reviewBody(review), url: text(review.url) || undefined };
    }),
    ...nodes(pull.comments).map((comment): WaitNote => {
      const by = author(comment.author);
      return { id: text(comment.id), kind: 'comment', author: by.login, bot: by.bot, at: Date.parse(text(comment.createdAt)) || 0, body: text(comment.body), url: text(comment.url) || undefined };
    }),
  ].filter((note) => note.id);
  const state = text(pull.state).toUpperCase();
  const mergeable = text(pull.mergeable).toUpperCase();
  return {
    repo,
    number: pull.number,
    title: text(pull.title),
    url: text(pull.url) || `https://github.com/${repo}/pull/${pull.number}`,
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    draft: pull.isDraft === true,
    headSha: text(pull.headRefOid),
    mergeable: mergeable === 'CONFLICTING' ? 'conflicting' : mergeable === 'MERGEABLE' ? 'mergeable' : 'unknown',
    reviewDecision: text(pull.reviewDecision) || null,
    checks: { state: checks.state, summary: checks.summary, failing: checks.items.filter((item) => item.state === 'failed').map((item) => item.name), total: checks.items.length },
    notes,
  };
}

export function runSnapshot(repo: string, runId: string, data: unknown, failedJobs: string[] = []): RunSnapshot {
  const run = object(data);
  if (run.id === undefined) throw new WaitProbeError(`GitHub shows no run ${runId} in ${repo}.`, 'not_found');
  return {
    repo,
    runId,
    name: text(run.name) || text(run.path).split('/').pop() || '',
    title: text(run.display_title),
    url: text(run.html_url) || `https://github.com/${repo}/actions/runs/${runId}`,
    status: text(run.status) || 'unknown',
    conclusion: text(run.conclusion) || null,
    attempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
    branch: text(run.head_branch),
    headSha: text(run.head_sha),
    failedJobs,
  };
}

/** The probes the app uses. `gh` can be swapped for a test's. */
export function ghWaitProbes(gh: RunGh = runGh): WaitProbes {
  const api = async (args: string[]): Promise<unknown> => {
    try {
      return JSON.parse(await gh(['api', '--hostname', 'github.com', ...args])) as unknown;
    } catch (failure) {
      throw probeError(failure);
    }
  };
  return {
    async pullRequest(repo, number) {
      const [owner, name] = repo.split('/');
      const data = await api(['graphql', '-f', `query=${PULL_REQUEST_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`]);
      return pullRequestSnapshot(repo, data);
    },
    async run(repo, runId) {
      const data = await api([`repos/${repo}/actions/runs/${runId}`]);
      const snapshot = runSnapshot(repo, runId, data);
      if (snapshot.status.toLowerCase() !== 'completed' || snapshot.conclusion === 'success') return snapshot;
      // Which jobs did not make it: worth one more request once, when it has ended badly. Not worth failing the look for.
      const jobs = await api([`repos/${repo}/actions/runs/${runId}/attempts/${snapshot.attempt}/jobs?per_page=100`]).catch(() => null);
      const failed = list(object(jobs).jobs)
        .filter((job) => !['success', 'skipped', 'neutral', ''].includes(text(job.conclusion)))
        .map((job) => text(job.name))
        .filter(Boolean);
      return { ...snapshot, failedJobs: failed };
    },
    async login() {
      try {
        const user = object(await api(['user']));
        return text(user.login) || null;
      } catch {
        return null;
      }
    },
  };
}

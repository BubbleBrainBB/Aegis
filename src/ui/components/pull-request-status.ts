import type { GitPullRequestSummary } from '../../shared/types';
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from './icons';

export type PullRequestStatus = 'open' | 'draft' | 'merged' | 'closed';

/** One glyph and color per PR state, shared by the sidebar and the environment card. */
export const PULL_REQUEST_STATUS: Record<PullRequestStatus, { label: string; className: string; Icon: typeof GitPullRequest }> = {
  open: { label: 'Open', className: 'text-[var(--success)]', Icon: GitPullRequest },
  draft: { label: 'Draft', className: 'text-[var(--text-muted)]', Icon: GitPullRequestDraft },
  merged: { label: 'Merged', className: 'text-[#8b5cf6]', Icon: GitMerge },
  closed: { label: 'Closed', className: 'text-[var(--text-muted)]', Icon: GitPullRequestClosed },
};

export function pullRequestStatus(pr: GitPullRequestSummary): PullRequestStatus {
  return pr.state === 'open' && pr.isDraft ? 'draft' : pr.state;
}

export function pullRequestRepo(url: string): string {
  return url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//i)?.[1] ?? '';
}

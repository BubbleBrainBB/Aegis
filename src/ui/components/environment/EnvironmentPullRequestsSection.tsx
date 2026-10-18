import { toast } from 'sonner';
import { MoreHorizontal } from '../icons';
import * as DropdownMenu from '../ui/dropdown-menu';
import { PULL_REQUEST_STATUS, pullRequestRepo, pullRequestStatus } from '../pull-request-status';
import type { SessionPullRequestsState } from './useSessionPullRequests';

export function EnvironmentPullRequestsSection({ prs }: { prs: SessionPullRequestsState }) {
  if (!prs.items.length && !prs.error) return null;
  return <section className="environment-summary-section px-1.5">
    <div className="px-2 py-1 text-[12px] font-medium text-[var(--text-secondary)]">Pull requests</div>
    {prs.error ? <button className="environment-summary-row" onClick={() => void prs.refresh()}>{prs.error} Retry</button> : null}
    {prs.items.map(pr => {
      // The glyph's color carries the state; lookup problems only show up in the tooltip.
      const meta = PULL_REQUEST_STATUS[pullRequestStatus(pr)];
      const missing = pr.lookupStatus === 'not_found';
      const status = pr.lookupStatus === 'unknown' ? `${meta.label} · status unavailable` : missing ? 'Not found' :
        `${meta.label}${pr.lookupStatus === 'cached' ? ' · saved' : ''}`;
      const repo = pullRequestRepo(pr.url).split('/')[1] ?? '';
      return <div key={pr.url} className="group/pr flex items-start">
        <button
          className="environment-summary-row min-w-0 flex-1 !items-start"
          title={`${pr.title}\n${status}\n${pr.url}\n${pr.headBranch}`}
          aria-label={`PR #${pr.number}: ${pr.title} (${status})`}
          onClick={() => {
            void window.electron.openExternalUrl(pr.url).then(result => { if (!result.ok) toast.error(result.message || 'Could not open pull request.'); });
          }}
        >
          <meta.Icon className={`mt-[3px] h-3.5 w-3.5 shrink-0 ${missing ? 'text-[var(--text-muted)]' : meta.className}`} aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{pr.title || `PR #${pr.number}`}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
              {repo ? <span className="min-w-0 truncate">{repo}</span> : null}
              <span className="shrink-0 tabular-nums">#{pr.number}</span>
              {pr.additions !== undefined && pr.deletions !== undefined ? <span className="shrink-0 tabular-nums">
                <span className="text-[var(--success)]">+{pr.additions}</span>{' '}
                <span className="text-[var(--error)]">−{pr.deletions}</span>
              </span> : null}
            </span>
          </span>
        </button>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild><button aria-label={`PR #${pr.number} options`} className="mt-0.5 inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 hover:bg-[var(--sidebar-item-hover)] focus-visible:opacity-100 group-hover/pr:opacity-100 data-[popup-open]:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content data-environment-hub-layer align="end" sideOffset={4}>
            <DropdownMenu.Item onSelect={() => void prs.refresh()}>Refresh status</DropdownMenu.Item>
            <DropdownMenu.Item disabled={prs.busy} onSelect={() => void prs.detach(pr)}>Remove from task</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>;
    })}
  </section>;
}

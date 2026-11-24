import { useState } from 'react';
import './SidebarUsageMenu.css';
import { usePlanUsage } from '../../hooks/usePlanUsage';
import { prefetchAgentUsageReport, useAgentUsageReports } from '../../hooks/useAgentUsageReport';
import { useAppStore } from '../../store/useAppStore';
import type { AgentProvider } from '../../types';
import { PROVIDERS } from '../../utils/provider';
import {
  claudePlan, codexPlan, deepseekPlan, formatReset, formatTokens, grokPlan, qoderPlan, reportTokens, usageTone,
  type UsageBalance, type UsagePlan, type UsageWindow,
} from '../../utils/usage-menu-model';
import { ProviderIcon } from '../AgentModelPicker';
import { AlertTriangle, ChevronRight } from '../icons';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';

// DeepSeek Harness has no plan; its row is the API account's balance.
const PLAN_PROVIDERS = ['claude', 'codex', 'grok', 'qoder', 'deepseek'] as const;
type PlanProvider = (typeof PLAN_PROVIDERS)[number];
/** Marks drawn in black or white, following the theme. */
const MONOCHROME = new Set<AgentProvider>(['claude', 'codex', 'kimi', 'grok', 'pi', 'bubble']);
const SKELETON_TOKEN_ROWS = [104, 64, 84];

function providerLabel(provider: AgentProvider): string {
  return provider === 'codex' ? 'Codex CLI' : PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
}

function savedAt(fetchedAt: number | undefined): string | null {
  return fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

function staleStatus(error: string | null, fetchedAt: number | undefined): string | null {
  if (!error) return null;
  const saved = savedAt(fetchedAt);
  return saved ? `Update failed · Saved ${saved}` : 'Could not update usage';
}

const USAGE_MENU_CLASS = 'usage-menu relative flex max-h-[min(580px,var(--available-height))] w-[336px] max-w-[calc(100vw-16px)] flex-col';

const RING_RADIUS = 9;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The usage ring at the foot of the icon rail, above the profile avatar: it
 * opens the usage menu. The ring is the open task's agent: the share left of
 * its tightest plan limit, from what the menu last loaded. Loading a plan
 * starts that agent's CLI, so the ring never loads one itself: it is a plain
 * track until the menu has been opened, and for an agent without plan limits.
 */
export function SidebarUsageButton() {
  const [open, setOpen] = useState(false);
  const provider = useAppStore((state) => {
    const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
    return state.activeWorkspace === 'chat' && !state.showNewSession ? session?.provider ?? null : null;
  });
  const claude = usePlanUsage('claude', false);
  const codex = usePlanUsage('codex', false);
  const grok = usePlanUsage('grok', false);
  const qoder = usePlanUsage('qoder', false);
  const deepseek = usePlanUsage('deepseek', false);
  const plans: Record<PlanProvider, UsagePlan | null> = {
    claude: claudePlan(claude.report),
    codex: codexPlan(codex.report),
    grok: grokPlan(grok.report),
    qoder: qoderPlan(qoder.report),
    deepseek: deepseekPlan(deepseek.report),
  };
  const planProvider = PLAN_PROVIDERS.find((entry) => entry === provider);
  const tightest = planProvider ? tightestLimit(plans[planProvider]) : null;
  const label = planProvider && tightest
    ? `Usage · ${providerLabel(planProvider)} ${tightest.label}: ${tightest.remaining}% left`
    : 'Usage';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-rail-usage
          data-usage-tone={tightest ? usageTone(tightest.remaining) : undefined}
          className="usage-ring-button no-drag relative inline-flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-muted)] outline-none transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:scale-95 data-[popup-open]:bg-[var(--sidebar-item-hover)] data-[popup-open]:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
            <circle className="usage-ring-track" cx="12" cy="12" r={RING_RADIUS} fill="none" strokeWidth="2" />
            {tightest && tightest.remaining > 0 ? (
              <circle
                className="usage-ring-left"
                cx="12"
                cy="12"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - tightest.remaining / 100)}
              />
            ) : null}
            <circle cx="12" cy="12" r="2.25" fill="currentColor" opacity="0.55" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className={USAGE_MENU_CLASS}>
        <UsageMenuBody open={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A plan's window or balance with the least left; null when the plan is not loaded or has neither. */
function tightestLimit(plan: UsagePlan | null): { label: string; remaining: number } | null {
  const limits = [
    ...(plan?.windows ?? []).map((window) => ({ label: window.label, remaining: window.remaining })),
    ...(plan?.balances ?? []).flatMap((balance) => balance.remaining === null ? [] : [{ label: balance.label, remaining: balance.remaining }]),
  ];
  return limits.reduce<{ label: string; remaining: number } | null>(
    (tightest, limit) => (!tightest || limit.remaining < tightest.remaining ? limit : tightest),
    null,
  );
}

/** Load usage details while the ring menu is open. */
function UsageMenuBody({ open }: { open: boolean }) {
  const selectedProvider = useAppStore((state) => state.usageSettingsProvider);
  // The page "Usage details" opens on: one agent's year, or every agent's for the overview.
  useAgentUsageReports(
    PROVIDERS.map((entry) => ({ provider: entry.id, enabled: open && (selectedProvider === 'all' || selectedProvider === entry.id) })),
    365,
  );
  const claude = usePlanUsage('claude', open);
  const codex = usePlanUsage('codex', open);
  const grok = usePlanUsage('grok', open);
  const qoder = usePlanUsage('qoder', open);
  const deepseek = usePlanUsage('deepseek', open);
  const planSnapshots = { claude, codex, grok, qoder, deepseek };
  const plans: Record<PlanProvider, UsagePlan | null> = {
    claude: claudePlan(claude.report),
    codex: codexPlan(codex.report),
    grok: grokPlan(grok.report),
    qoder: qoderPlan(qoder.report),
    deepseek: deepseekPlan(deepseek.report),
  };
  // A plan provider without plan limits (API key, not signed in, no balance to
  // show) is counted by its tokens like any other provider.
  const planState = (provider: PlanProvider) => plans[provider] ? 'plan'
    : planSnapshots[provider].loading && !planSnapshots[provider].report ? 'loading' : 'tokens';
  const planRows = PLAN_PROVIDERS.filter((provider) => planState(provider) !== 'tokens');
  const tokenCandidates = PROVIDERS.map((entry) => entry.id)
    .filter((provider) => !(PLAN_PROVIDERS as readonly AgentProvider[]).includes(provider) || planState(provider as PlanProvider) === 'tokens');
  const recent = useAgentUsageReports(
    PROVIDERS.map((entry) => ({ provider: entry.id, enabled: open && tokenCandidates.includes(entry.id) })),
    30,
  );
  const recentFor = (provider: AgentProvider) => recent[PROVIDERS.findIndex((entry) => entry.id === provider)];

  // Ledger rows wait until every candidate has answered, so they never reorder.
  const settled = PLAN_PROVIDERS.every((provider) => planState(provider) !== 'loading')
    && tokenCandidates.every((provider) => { const snapshot = recentFor(provider); return snapshot.report || !snapshot.loading; });
  const ledger = tokenCandidates
    .map((provider) => {
      const snapshot = recentFor(provider);
      return { provider, snapshot, ...reportTokens(snapshot.report?.usage ?? null) };
    })
    .filter((row) => row.tokens > 0 || row.sessions > 0 || (row.snapshot.error && !row.snapshot.report))
    .sort((a, b) => b.tokens - a.tokens);
  const idle = tokenCandidates.filter((provider) => !ledger.some((row) => row.provider === provider));
  const refreshing = PLAN_PROVIDERS.some((provider) => planSnapshots[provider].loading && planSnapshots[provider].report)
    || tokenCandidates.some((provider) => { const snapshot = recentFor(provider); return snapshot.loading && snapshot.report; });

  const openUsage = (provider?: AgentProvider) => {
    const store = useAppStore.getState();
    if (provider) store.setUsageSettingsProvider(provider);
    store.setActiveSettingsTab('usage');
    store.setShowSettings(true);
  };
  const prefetch = (provider: AgentProvider) => () => { void prefetchAgentUsageReport(provider); };
  const now = Date.now();

  return (
    <>
        {/* Last values stay put while they update; this line is the only sign. */}
        {refreshing ? <div className="usage-refresh-line" role="status" aria-label="Updating usage"><i /></div> : null}
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {planRows.length ? (
            <section className="usage-section" aria-label="Plan limits">
              <div className="usage-section-label">Plan limits</div>
              {planRows.map((provider) => (
                <PlanRow
                  key={provider}
                  provider={provider}
                  plan={plans[provider]}
                  status={staleStatus(planSnapshots[provider].error, planSnapshots[provider].report?.fetchedAt)}
                  now={now}
                  onSelect={() => openUsage(provider)}
                  onPrefetch={prefetch(provider)}
                />
              ))}
            </section>
          ) : null}
          {/* Inside the scroller: the separator's default bleed would add a horizontal scrollbar. */}
          {planRows.length ? <DropdownMenuSeparator className="mx-2" /> : null}
          <section className="usage-section" aria-label="Tokens, last 30 days">
            <div className="usage-section-label">Tokens · last 30 days</div>
            {settled ? <>
              {ledger.map(({ provider, snapshot, tokens }) => {
                const unavailable = !snapshot.report;
                const status = unavailable ? snapshot.error || 'Usage unavailable' : staleStatus(snapshot.error, snapshot.report?.fetchedAt);
                const value = unavailable || tokens <= 0 ? '—' : formatTokens(tokens);
                return (
                  <DropdownMenuItem
                    key={provider}
                    data-usage-provider={provider}
                    onSelect={() => openUsage(provider)}
                    onMouseEnter={prefetch(provider)}
                    onFocus={prefetch(provider)}
                    title={[providerLabel(provider), tokens > 0 ? `${formatTokens(tokens)} tokens` : unavailable ? null : 'Tokens not reported', status].filter(Boolean).join('\n')}
                    className="usage-ledger-row gap-2 px-2 py-1.5 text-[13px] leading-[18px]"
                  >
                    <ProviderMark provider={provider} />
                    <span className="usage-name">{providerLabel(provider)}</span>
                    <StatusSlot status={status} />
                    <span className="usage-ledger-value">{value}</span>
                  </DropdownMenuItem>
                );
              })}
              {idle.length ? (
                <div className="usage-idle">
                  <span>No usage</span>
                  <span className="usage-idle-logos">
                    {idle.map((provider) => (
                      <DropdownMenuItem
                        key={provider}
                        data-usage-provider={provider}
                        onSelect={() => openUsage(provider)}
                        onMouseEnter={prefetch(provider)}
                        onFocus={prefetch(provider)}
                        aria-label={providerLabel(provider)}
                        title={providerLabel(provider)}
                        className="usage-idle-logo h-6 w-6 justify-center rounded-md p-0"
                      >
                        <ProviderMark provider={provider} />
                      </DropdownMenuItem>
                    ))}
                  </span>
                </div>
              ) : null}
            </> : SKELETON_TOKEN_ROWS.map((width) => (
              <div key={width} className="usage-ledger-row flex items-center gap-2 px-2 py-1.5 text-[13px] leading-[18px]" aria-hidden="true">
                <span className="usage-skeleton usage-skeleton-logo" />
                <span className="usage-name"><span className="usage-skeleton" style={{ width }} /></span>
                <span className="usage-skeleton" style={{ width: 38 }} />
              </div>
            ))}
          </section>
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuItem onSelect={() => openUsage()} className="shrink-0 gap-2 px-2.5 text-[13px] text-[var(--text-secondary)]">
          Usage details <ChevronRight className="ml-auto h-3.5 w-3.5 text-[var(--text-muted)]" />
        </DropdownMenuItem>
    </>
  );
}

function ProviderMark({ provider }: { provider: AgentProvider }) {
  return (
    <span className={`usage-mark ${MONOCHROME.has(provider) ? 'sidebar-usage-monochrome' : ''}`}>
      <ProviderIcon provider={provider} />
    </span>
  );
}

/** A fixed slot, so an update failure never shifts the row. */
function StatusSlot({ status }: { status: string | null }) {
  return (
    <span className="usage-status" title={status || undefined}>
      {status ? <>
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">{status}</span>
      </> : null}
    </span>
  );
}

function PlanRow({ provider, plan, status, now, onSelect, onPrefetch }: {
  provider: PlanProvider;
  plan: UsagePlan | null;
  status: string | null;
  now: number;
  onSelect: () => void;
  onPrefetch: () => void;
}) {
  const title = plan
    ? [
        [providerLabel(provider), plan.tier].filter(Boolean).join(' · '),
        ...plan.windows.map((window) => `${window.label}: ${window.remaining}% left${window.resetsAt ? `, resets ${formatReset(window.resetsAt, now)}` : ''}`),
        ...(plan.balances ?? []).flatMap((balance) => [
          `Balance: ${balance.value}${balance.detail ? ` (${balance.detail})` : ''}`,
          balance.remaining !== null && balance.reference ? `${balance.remaining}% left of ${balance.reference}, the balance after its last top-up` : null,
          balance.available ? null : 'No balance available for API calls',
        ]),
        status,
      ].filter(Boolean).join('\n')
    : `${providerLabel(provider)}\nLoading usage…`;
  return (
    <DropdownMenuItem
      data-usage-provider={provider}
      onSelect={onSelect}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      title={title}
      className="usage-plan-row flex-col items-stretch gap-[5px] px-2 py-[7px]"
    >
      <span className="usage-plan-head">
        <ProviderMark provider={provider} />
        <span className="usage-name usage-plan-name">{providerLabel(provider)}</span>
        {plan ? (plan.tier ? <span className="usage-tier" data-provider={provider}>{plan.tier}</span> : null)
          : <span className="usage-skeleton usage-skeleton-tier" aria-hidden="true" />}
        <StatusSlot status={status} />
      </span>
      {plan?.balances?.map((balance) => <BalanceRow key={balance.value} balance={balance} />)}
      {plan ? plan.windows.map((window) => <WindowRow key={window.label} window={window} now={now} />) : (
        <span className="usage-window" aria-hidden="true">
          <span className="usage-skeleton" style={{ width: 34 }} />
          <span className="usage-meter" />
          <span className="usage-skeleton usage-skeleton-end" style={{ width: 26 }} />
          <span className="usage-skeleton usage-skeleton-end" style={{ width: 46 }} />
        </span>
      )}
    </DropdownMenuItem>
  );
}

/** A balance on a window's line: the share left since its last top-up, then the amount where a reset would be. */
function BalanceRow({ balance }: { balance: UsageBalance }) {
  return (
    <span className="usage-window usage-balance" data-usage-balance={balance.available ? 'available' : 'unavailable'}>
      <span className="usage-window-label">{balance.label}</span>
      <span className="usage-meter">
        {balance.remaining !== null ? (
          <i data-tone={balance.available ? usageTone(balance.remaining) : 'low'} style={{ width: `${balance.remaining}%` }} />
        ) : null}
      </span>
      <span className="usage-window-pct">{balance.remaining !== null ? `${balance.remaining}%` : ''}</span>
      <span className="usage-balance-value">{balance.amount}</span>
    </span>
  );
}

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  return (
    <span className="usage-window" data-usage-window={window.label}>
      <span className="usage-window-label">{window.label}</span>
      <span className="usage-meter">
        <i data-tone={usageTone(window.remaining)} style={{ width: `${window.remaining}%` }} />
      </span>
      <span className="usage-window-pct">{window.remaining}%</span>
      <span className="usage-window-reset">{formatReset(window.resetsAt, now) ?? ''}</span>
    </span>
  );
}

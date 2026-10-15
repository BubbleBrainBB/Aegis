import { Fragment, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AgentProviderLogo } from '../AgentProviderLogo';
import { ExternalLink, Loader2 } from '../icons';
import type { AgentProvider, AgentRuntimeDirectoryReport, AgentRuntimeEntry } from '../../types';
import { DeepseekKeyPanel } from './DeepseekProviderSettings';

type OpenPanel = { provider: AgentProvider; kind: 'key' | 'sign-in' | 'install-error' };

const ATTENTION_STATES = new Set<AgentRuntimeEntry['state']>(['login_required', 'not_installed', 'error']);

/**
 * Status grid for every agent runtime, shown first on the Providers tab. Each
 * cell carries the one action that agent needs: install it, sign in, or (for
 * DeepSeek Harness) edit its API key. Panels open full-width under the row of
 * the cell that opened them.
 */
export function AgentRuntimeSettings() {
  const [report, setReport] = useState<AgentRuntimeDirectoryReport | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [installing, setInstalling] = useState<AgentProvider | null>(null);
  const [installError, setInstallError] = useState<{ provider: AgentProvider; message: string } | null>(null);

  const load = useCallback(async (force: boolean) => {
    try {
      setReport(await window.electron.getAgentRuntimeDirectory(force));
    } catch {
      // Keep the last report; a failed probe shouldn't blank the grid.
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const togglePanel = (next: OpenPanel) =>
    setPanel((current) => (current?.provider === next.provider && current.kind === next.kind ? null : next));

  const install = async (entry: AgentRuntimeEntry) => {
    setInstalling(entry.provider);
    setInstallError(null);
    try {
      const result = await window.electron.installAgentRuntime(entry.provider);
      if (result.ok) {
        await load(true);
      } else {
        setInstallError({ provider: entry.provider, message: result.message });
        setPanel({ provider: entry.provider, kind: 'install-error' });
      }
    } catch (error) {
      setInstallError({ provider: entry.provider, message: error instanceof Error ? error.message : 'The install failed.' });
      setPanel({ provider: entry.provider, kind: 'install-error' });
    } finally {
      setInstalling(null);
    }
  };

  const entries = report?.entries ?? [];
  const panelIndex = panel ? entries.findIndex((entry) => entry.provider === panel.provider) : -1;
  // The panel spans both columns, so it goes after the second cell of its row.
  const panelAfter = panelIndex < 0 ? -1 : Math.min(panelIndex - (panelIndex % 2) + 1, entries.length - 1);

  const renderAction = (entry: AgentRuntimeEntry) => {
    if (entry.provider === 'deepseek' && entry.state !== 'not_installed') {
      return entry.state === 'ready'
        ? <ReadyStatus />
        : <button type="button" className="agent-cell-button" onClick={() => togglePanel({ provider: 'deepseek', kind: 'key' })}>Add key</button>;
    }
    if (entry.state === 'ready') return <ReadyStatus />;
    if (installing === entry.provider) {
      return <span className="agent-cell-status"><Loader2 className="h-3.5 w-3.5 animate-spin" />Installing…</span>;
    }
    if (entry.state === 'not_installed' && entry.canAutoInstall) {
      return <button type="button" className="agent-cell-button" onClick={() => void install(entry)}>Install</button>;
    }
    if (entry.state === 'login_required' && entry.provider === 'bubble') {
      return <button type="button" className="agent-cell-button" onClick={revealBubbleProviders}>Add key</button>;
    }
    if (entry.state === 'login_required' && entry.loginCommand) {
      return <button type="button" className="agent-cell-button is-primary" aria-expanded={panel?.provider === entry.provider} onClick={() => togglePanel({ provider: entry.provider, kind: 'sign-in' })}>Sign in</button>;
    }
    if (entry.state === 'not_installed' && entry.docsUrl) {
      return <button type="button" className="agent-cell-button" onClick={() => void window.electron.openExternalUrl(entry.docsUrl!)}>Setup guide<ExternalLink className="h-3 w-3" /></button>;
    }
    return <span className="agent-cell-status is-warn" title={entry.detail || entry.summary}>{entry.state === 'error' ? 'Check failed' : 'Not installed'}</span>;
  };

  const renderPanel = (entry: AgentRuntimeEntry) => {
    if (!panel) return null;
    if (panel.kind === 'key') {
      return <DeepseekKeyPanel onClose={() => setPanel(null)} onChanged={() => void load(true)} />;
    }
    if (panel.kind === 'sign-in' && entry.loginCommand) {
      return <div className="agent-panel"><CommandField command={entry.loginCommand} label={`${entry.title} sign-in command`} /></div>;
    }
    if (panel.kind === 'install-error' && installError?.provider === entry.provider) {
      return <div className="agent-panel">
        <p className="provider-inline-error">{installError.message}</p>
        {entry.installCommand && <CommandField command={entry.installCommand} label={`${entry.title} install command`} />}
      </div>;
    }
    return null;
  };

  return (
    <section className="provider-settings-section agent-runtime" aria-label="Agents" data-settings-label="Agents">
      <div className="provider-settings-section-head">
        <h2>Agents</h2>
      </div>
      <div className="provider-settings-card agent-grid">
        {!report && <div className="provider-load-message" role="status">Checking agents…</div>}
        {entries.map((entry, index) => (
          <Fragment key={entry.provider}>
            <div
              className={`agent-cell${index % 2 === 1 ? ' is-right' : ''}${ATTENTION_STATES.has(entry.state) ? ' is-attention' : ''}${entry.provider === 'deepseek' ? ' is-clickable' : ''}`}
              data-settings-id={`Agents:${entry.title}`}
              onClick={entry.provider === 'deepseek' ? () => togglePanel({ provider: 'deepseek', kind: 'key' }) : undefined}
            >
              <span className="agent-cell-logo"><AgentProviderLogo provider={entry.provider} className="h-5 w-5" /></span>
              <span className="agent-cell-name">{entry.title}</span>
              <span className="agent-cell-action" onClick={(event) => event.stopPropagation()}>{renderAction(entry)}</span>
            </div>
            {index === panelAfter && panel && <div className="agent-panel-row">{renderPanel(entries[panelIndex])}</div>}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function ReadyStatus() {
  return <span className="agent-cell-status is-ready"><span className="agent-dot" />Ready</span>;
}

function revealBubbleProviders() {
  document.querySelector('[data-settings-label="Bubble model providers"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function CommandField({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Failed to copy.');
    }
  };
  return (
    <div className="agent-command">
      <code>{command}</code>
      <button type="button" className="provider-secondary-button" onClick={() => void copy()} aria-label={`Copy ${label}`}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

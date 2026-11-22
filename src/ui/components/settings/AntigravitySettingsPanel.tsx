import { useCallback, useEffect, useState } from 'react';
import { ANTIGRAVITY_USAGE_NOTES } from '../../../shared/human-driven-providers';
import { refreshAntigravityModelConfig } from '../../hooks/useAntigravityModelConfig';
import type { AntigravityModelConfig, AntigravityRuntimeStatus } from '../../types';
import { ExternalLink, Loader2 } from '../icons';
import { AgentCommandField } from './AgentCommandField';

/** `code` spans in the usage notes are written with backticks. */
function renderNote(note: string) {
  return note.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part
  );
}

function names(entries: Array<{ label: string }>): string {
  return entries.map((entry) => entry.label).join(', ');
}

/**
 * Antigravity setup under its cell on the Agents grid: where agy is, how to
 * install it and sign in (both in the user's own terminal), an executable
 * override, what agy offers over ACP, and what Aegis does and does not do
 * with it.
 */
export function AntigravitySettingsPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<AntigravityRuntimeStatus | null>(null);
  const [catalog, setCatalog] = useState<AntigravityModelConfig | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((next: AntigravityRuntimeStatus) => {
    setStatus(next);
    setPathDraft(next.cliPathOverride ?? '');
  }, []);

  const loadCatalog = useCallback(async (ready: boolean) => {
    if (!ready) {
      setCatalog(null);
      return;
    }
    try {
      setCatalog(await window.electron.getAntigravityModelConfig());
    } catch {
      setCatalog(null);
    }
  }, []);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const next = await window.electron.getAntigravityRuntimeStatus(refresh);
      adopt(next);
      await loadCatalog(next.ready && next.authState === 'ready');
      if (refresh) {
        refreshAntigravityModelConfig();
        onChanged();
      }
    } catch {
      // Keep what is shown; a failed check must not blank the panel.
    } finally {
      setBusy(false);
    }
  }, [adopt, loadCatalog, onChanged]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const savePath = async (value: string) => {
    setBusy(true);
    setPathError(null);
    try {
      const result = await window.electron.setAntigravityCliPath(value.trim() || null);
      if (!result.ok) {
        setPathError(result.message);
        return;
      }
      adopt(result.status);
      await loadCatalog(result.status.ready && result.status.authState === 'ready');
      refreshAntigravityModelConfig();
      onChanged();
    } catch (error) {
      setPathError(error instanceof Error ? error.message : 'Could not save the path.');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="agent-panel"><div className="provider-load-message" role="status">Checking Antigravity…</div></div>;
  }

  const pathChanged = pathDraft.trim() !== (status.cliPathOverride ?? '');
  const needsSignIn = status.cliAvailable && status.acpAvailable && status.authState === 'login_required';

  return (
    <div className="agent-panel antigravity-panel" data-testid="antigravity-settings-panel">
      <div className="agent-panel-status">
        <span data-testid="antigravity-summary">{status.summary}</span>
        {status.cliVersion && <span className="agent-panel-meta">agy {status.cliVersion}</span>}
        <button type="button" className="provider-secondary-button" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Check again'}
        </button>
      </div>
      {/* Not found or signed out: the blocks below say what to do. */}
      {status.detail && status.cliAvailable && !needsSignIn && <p className="agent-panel-note">{renderNote(status.detail)}</p>}

      {!status.cliAvailable && (
        <div className="agent-panel-block">
          <div className="agent-panel-label">Install</div>
          <p className="agent-panel-note">Run Google&rsquo;s installer in your terminal, then check again.</p>
          <AgentCommandField command={status.installCommand} label="Antigravity install command" />
          <button type="button" className="agent-panel-link" onClick={() => void window.electron.openExternalUrl(status.docsUrl)}>
            Antigravity CLI guide <ExternalLink className="inline h-3 w-3" />
          </button>
        </div>
      )}

      {needsSignIn && status.loginCommand && (
        <div className="agent-panel-block">
          <div className="agent-panel-label">Sign in</div>
          <p className="agent-panel-note">
            Run this in your terminal. agy opens your browser, signs you in with Google and keeps the credentials itself. Then check again.
          </p>
          <AgentCommandField command={status.loginCommand} label="Antigravity sign-in command" />
        </div>
      )}

      <div className="agent-panel-block">
        <label className="agent-panel-label" htmlFor="antigravity-cli-path">Executable</label>
        <p className="agent-panel-note">
          {status.cliPathOverride
            ? renderNote('Aegis runs this file as is, with `acp`.')
            : status.cliPath
              ? `Detected at ${status.cliPath}. Set a path only to use another agy.`
              : 'Leave empty to detect agy, or set the full path of the agy executable.'}
        </p>
        <div className="agent-command">
          <input
            id="antigravity-cli-path"
            className="agent-path-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={status.cliPath || '/path/to/agy'}
            value={pathDraft}
            onChange={(event) => {
              setPathDraft(event.target.value);
              setPathError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && pathChanged && !busy) void savePath(pathDraft);
            }}
          />
          <button type="button" className="provider-secondary-button" onClick={() => void savePath(pathDraft)} disabled={busy || !pathChanged}>Save</button>
          {status.cliPathOverride && (
            <button type="button" className="provider-secondary-button" onClick={() => void savePath('')} disabled={busy}>Detect</button>
          )}
        </div>
        {pathError && <p className="provider-inline-error" role="alert">{pathError}</p>}
      </div>

      {catalog && (catalog.availableModels.length > 0 || catalog.modes.length > 0) && (
        <div className="agent-panel-block" data-testid="antigravity-offers">
          <div className="agent-panel-label">What agy offers this account</div>
          <dl className="agent-panel-facts">
            {catalog.availableModels.length > 0 && <><dt>Models</dt><dd>{names(catalog.availableModels)}</dd></>}
            {catalog.modes.length > 0 && <><dt>Modes</dt><dd>{names(catalog.modes)}</dd></>}
            {catalog.authMethods.length > 0 && <><dt>Sign-in</dt><dd>{names(catalog.authMethods)}</dd></>}
            <dt>Images</dt><dd>{catalog.imagePrompts ? 'Accepted in messages' : 'Not accepted'}</dd>
          </dl>
          <p className="agent-panel-note">Read from agy over ACP. The composer lists exactly these.</p>
        </div>
      )}

      <div className="agent-panel-block">
        <div className="agent-panel-label">How Aegis uses Antigravity</div>
        <ul className="agent-panel-notes" data-testid="antigravity-usage-notes">
          {ANTIGRAVITY_USAGE_NOTES.map((note) => <li key={note}>{renderNote(note)}</li>)}
        </ul>
      </div>
    </div>
  );
}

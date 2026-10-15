import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DeepseekKeyStatus } from '../../types';
import { ProviderKeyEditor } from './ProviderSettingsPrimitives';

/**
 * API-key editor for the DeepSeek Harness agent, opened from its cell in the
 * agents grid. The effective key may come from a locally saved key, the env
 * var, or the installed dsh CLI's credential file (read-only import); saving
 * pins it into the Aegis store.
 */
export function DeepseekKeyPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<DeepseekKeyStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyEdited = useRef(false);

  useEffect(() => {
    let cancelled = false;
    window.electron.getDeepseekKeyStatus().then((next) => {
      if (!cancelled) setStatus(next);
    }).catch(() => {});
    // Prefill with the effective key so the user sees it masked and can
    // reveal it; the bulk status never carries keys.
    window.electron.getDeepseekApiKey().then((key) => {
      if (!cancelled && !keyEdited.current && key) setKeyDraft(key);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    setBusy(true);
    try {
      setStatus(await window.electron.setDeepseekApiKey(keyDraft));
      toast.success('Saved DeepSeek API key.');
      onChanged();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the key.');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      setStatus(await window.electron.clearDeepseekApiKey());
      toast.success('Removed the Aegis-stored DeepSeek API key.');
      onChanged();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove the key.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="agent-panel">
    <ProviderKeyEditor label="DeepSeek API key for DeepSeek Harness" value={keyDraft} onChange={value => { keyEdited.current = true; setKeyDraft(value); }} showKey={showKey} onToggleVisibility={() => setShowKey(value => !value)} busy={busy} onSave={() => void saveKey()} onCancel={onClose} />
    {status?.keySource === 'aegis' && <button type="button" className="agent-panel-link is-danger" onClick={() => void clearKey()} disabled={busy}>Remove saved key</button>}
  </div>;
}

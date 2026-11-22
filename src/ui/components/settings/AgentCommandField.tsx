import { useState } from 'react';
import { toast } from 'sonner';

/** A command the user runs in their own terminal, with a copy button. */
export function AgentCommandField({ command, label }: { command: string; label: string }) {
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

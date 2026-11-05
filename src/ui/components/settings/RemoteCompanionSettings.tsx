import { useEffect, useRef, useState } from 'react';
import * as Dialog from '../ui/dialog';
import { ChevronDown, Copy, Monitor, X } from '../icons';
import { SettingsToggle } from './SettingsPrimitives';
import type { RemoteEnvironment } from '../../../shared/remote/protocol';
import './remote-companion-settings.css';

interface Status {
  status: string;
  enabled: boolean;
  environment: RemoteEnvironment;
  relay: string;
  /** The public Aegis relay, used unless a custom relay is set. */
  defaultRelay?: string;
  relayError?: string;
  projects: { id: string; name: string }[];
  devices: { peerId: string; name: string; kind?: 'desktop'; push?: unknown }[];
}
interface Pairing { url: string; qr: string; expiresAt: number }
interface ControlledDevice {
  id: string;
  name: string;
  status: 'connecting' | 'confirming' | 'connected' | 'offline' | 'revoked' | 'rejected';
  transport?: 'relay' | 'direct';
}
const statusLabels: Record<string, string> = {
  disabled: 'Off', connecting: 'Connecting…', waiting: 'Ready to connect',
  connected: 'Connected', offline: 'Reconnecting…', rejected: 'Relay refused this Mac',
};

function controlledStatus(device: ControlledDevice) {
  switch (device.status) {
    case 'connected': return `Connected · ${device.transport === 'direct' ? 'Direct' : 'Relay'}`;
    case 'connecting': return 'Connecting…';
    case 'confirming': return `Waiting for approval on ${device.name}`;
    case 'revoked': return 'Access was removed on this device';
    case 'rejected': return 'Not allowed';
    default: return 'Offline';
  }
}

/** Other Macs this one controls: their sessions join the list, and stay on those Macs. */
function DevicesYouControl() {
  const [devices, setDevices] = useState<ControlledDevice[]>();
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairingId, setPairingId] = useState<string>();

  const refresh = async () => {
    try { setDevices(await window.electron.remoteHosts('list')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, []);
  const pairing = devices?.find(device => device.id === pairingId);
  useEffect(() => {
    if (pairing?.status === 'connected') { setAdding(false); setPairingId(undefined); setLink(''); }
  }, [pairing?.status]);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const added = await window.electron.remoteHosts('add', { link: link.trim() });
      setDeviceId(added.deviceId);
      setPairingId(added.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError('');
    try { await window.electron.remoteHosts('remove', { id }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const close = () => {
    setAdding(false); setLink(''); setError('');
    // Closing while the other Mac is still asking drops the attempt.
    if (pairingId && pairing?.status !== 'connected') void remove(pairingId);
    setPairingId(undefined);
  };

  return <section aria-labelledby="connections-controlled-title">
    <div className="connections-section-heading">
      <h2 id="connections-controlled-title">Devices you control</h2>
      <button className="settings-button connections-outlined-button" onClick={() => { setError(''); setAdding(true); }}>Add device</button>
    </div>
    {error && !adding && <p className="connections-error" role="alert">{error}</p>}
    {devices?.length ? <div className="connections-device-list">
      {devices.map(device => <div className="connections-row" key={device.id} data-controlled-device={device.id}>
        <div className="connections-device"><Monitor aria-hidden="true" /><div><h3>{device.name}</h3><p className="connections-controlled-status"><i className="connections-dot" data-online={device.status === 'connected'} />{controlledStatus(device)}</p></div></div>
        <button className="settings-button connections-outlined-button" onClick={() => void remove(device.id)}>Remove</button>
      </div>)}
    </div> : devices ? <p className="connections-note">Add another Mac with Aegis to manage its sessions from here.</p> : null}
    <Dialog.Root open={adding} onOpenChange={open => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Content className="connections-dialog">
          <div className="connections-dialog-header"><Dialog.Title>Add a device</Dialog.Title><button className="settings-button" aria-label="Close" onClick={close}><X className="h-4 w-4" /></button></div>
          <Dialog.Description className="connections-dialog-description">On the other Mac, open Settings → Connections and choose Pair a device. Copy its pairing link here.</Dialog.Description>
          {error && <p role="alert" className="connections-error">{error}</p>}
          <form onSubmit={event => { event.preventDefault(); if (link.trim() && !pairing) void add(); }}>
            <label className="connections-field">Pairing link<input className="settings-control" data-pairing-link autoFocus value={link} onChange={event => setLink(event.target.value)} disabled={busy || !!pairing} spellCheck={false} /></label>
            {pairing && <>
              <p className="connections-note">{pairing.status === 'rejected' ? `${pairing.name} didn’t allow this Mac. Try again with a new link.` : `Confirm on ${pairing.name}. Its screen should show this device ID:`}</p>
              {pairing.status !== 'rejected' && <p className="connections-device-id">{deviceId}</p>}
            </>}
            <div className="connections-dialog-actions"><button type="button" className="settings-button" onClick={close}>Cancel</button>{!pairing && <button className="settings-primary-button" disabled={busy || !link.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>}</div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}

export function RemoteCompanionSettings() {
  const [status, setStatus] = useState<Status>();
  const [relay, setRelay] = useState('');
  const [token, setToken] = useState('');
  const [pair, setPair] = useState<Pairing>();
  const [dialog, setDialog] = useState<'setup' | 'pair' | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  const mutating = useRef(false);
  const alive = useRef(true);
  const pairedDevices = useRef<string[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; };
  }, []);
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || mutating.current) return;
      loading = true;
      const version = revision.current;
      try {
        const next: Status = await window.electron.remoteCompanion('status');
        if (active && version === revision.current) {
          setStatus(next);
          setLoadError('');
        }
      } catch (e) {
        if (active && version === revision.current) setLoadError(e instanceof Error ? e.message : String(e));
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(load, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [retry]);
  useEffect(() => {
    if (!pair) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair]);
  useEffect(() => {
    if (pair && status?.devices.some(device => !pairedDevices.current.includes(device.peerId))) {
      setPair(undefined);
      setDialog(null);
    }
  }, [pair, status]);

  const act = async (action: string, payload?: unknown) => {
    if (mutating.current) return;
    mutating.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      const result = await window.electron.remoteCompanion(action, payload);
      if (!alive.current) return;
      if (action === 'pair') {
        pairedDevices.current = status?.devices.map(device => device.peerId) ?? [];
        setPair(result);
        setCopied(false);
        setDialog('pair');
      } else {
        setStatus(result);
        setPair(undefined);
        setToken('');
        setDialog(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      revision.current++;
      mutating.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const openSetup = () => {
    setRelay(status?.relay && status.relay !== status.defaultRelay ? status.relay : '');
    setToken(''); setError(''); setDialog('setup');
  };
  const closeDialog = () => {
    if (busy) return;
    setDialog(null); setPair(undefined); setToken(''); setError(''); setCopied(false);
  };
  const ready = !!status?.enabled && ['waiting', 'connected'].includes(status.status) && !loadError;
  const seconds = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  const copyLink = async () => {
    if (!pair || Date.now() >= pair.expiresAt) return;
    try { await navigator.clipboard.writeText(pair.url); setCopied(true); }
    catch { setError('Could not copy the pairing link. Try again.'); }
  };

  return <div className="connections-settings">
    <DevicesYouControl />
    <section aria-labelledby="connections-devices-title">
      <div className="connections-section-heading">
        <h2 id="connections-devices-title">Devices that can access this Mac</h2>
        {!!status?.devices.length && <button className="settings-button connections-outlined-button" disabled={busy || !ready} onClick={() => void act('pair')}>Pair a device</button>}
      </div>
      {loadError && <div className="connections-error" role="alert">Could not refresh connections. {loadError} <button className="settings-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {error && !dialog && <p className="connections-error" role="alert">{error}</p>}
      {!status ? <p className="connections-empty" role="status">{loadError ? 'Connection status unavailable' : 'Loading connections…'}</p>
        : status.devices.length ? <div className="connections-device-list">
          {status.devices.map(device => <div className="connections-row" key={device.peerId}>
            <div className="connections-device">{device.kind === 'desktop' ? <Monitor aria-hidden="true" /> : <span className="connections-phone" aria-hidden="true" />}<div><h3>{device.name}</h3><p>{status.enabled ? (device.push ? 'Authorized device · Notifications on' : 'Authorized device') : 'Remote access is off'}</p></div></div>
            <button className="settings-button connections-outlined-button" disabled={busy || !!loadError} onClick={() => void act('revoke', { peerId: device.peerId })}>Revoke access</button>
          </div>)}
        </div> : <div className="connections-empty">
          <div className="connections-device-illustration" aria-hidden="true"><Monitor /><span className="connections-phone" /></div>
          <p>Control this Mac from your iPhone or another Mac.</p>
          <button className="settings-primary-button" disabled={busy || !!loadError || (status.enabled && !ready)} onClick={() => status.enabled ? void act('pair') : openSetup()}>{busy ? 'Please wait…' : status.enabled ? 'Pair a device' : 'Set up'}</button>
        </div>}
      <p className="connections-note">Paired devices can view conversations, send tasks, and respond to approvals.</p>
    </section>

    <section aria-labelledby="connections-access-title">
      <h2 id="connections-access-title">Remote access</h2>
      <div className="connections-row">
        <div><h3>Allow connections to this Mac</h3><p>Keep Aegis open and your Mac awake to connect.</p></div>
        <SettingsToggle checked={status?.enabled ?? false} disabled={!status || busy || !!loadError} ariaLabel="Allow connections to this Mac" onChange={enabled => enabled ? openSetup() : void act('disable')} />
      </div>
      <div className="connections-row connections-status-row"><span>Status</span><span className="connections-status" role="status"><i data-online={!loadError && ready} />{loadError ? 'Unavailable' : status ? statusLabels[status.status] ?? 'Unavailable' : 'Loading…'}</span></div>
      {status && <details className="settings-disclosure connections-details">
        <summary><ChevronDown />Connection details</summary>
        <dl>
          <div><dt>Data source</dt><dd>{status.environment === 'development' ? 'Aegis Dev' : 'Aegis'}</dd></div>
          <div><dt>Relay server</dt><dd>{status.relay || status.defaultRelay || 'Not configured'}{status.relayError ? ` · ${status.relayError}` : ''}</dd></div>
        </dl>
        {!status.enabled && !!status.devices.length && <p className="connections-note">Setting up again replaces the previous connection. You’ll need to pair your devices again.</p>}
      </details>}
    </section>

    <Dialog.Root open={dialog !== null} onOpenChange={open => { if (!open) closeDialog(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Content className="connections-dialog">
          <div className="connections-dialog-header"><Dialog.Title>{dialog === 'setup' ? 'Set up remote access' : 'Pair a device'}</Dialog.Title><button className="settings-button" aria-label="Close pairing" disabled={busy} onClick={closeDialog}><X className="h-4 w-4" /></button></div>
          <Dialog.Description className="connections-dialog-description">{dialog === 'setup' ? 'Devices you allow will see all your projects and conversations.' : 'Scan with your iPhone, or copy the link to another Mac. Then approve the connection on this Mac.'}</Dialog.Description>
          {error && <p role="alert" className="connections-error">{error}</p>}
          {dialog === 'setup' && <form onSubmit={event => { event.preventDefault(); void act('configure', { relay: relay.trim(), token: token.trim() }); }}>
            <details className="settings-disclosure connections-details" open={!!relay}>
              <summary><ChevronDown />Custom relay</summary>
              <p className="connections-note">Leave empty to use the Aegis relay. It only forwards end-to-end encrypted data.</p>
              <label className="connections-field">Relay server<input className="settings-control" type="url" placeholder={status?.defaultRelay ?? 'wss://relay.example.com'} value={relay} onChange={event => setRelay(event.target.value)} disabled={busy} /></label>
              <label className="connections-field">Registration token (optional)<input className="settings-control" type="password" autoComplete="off" minLength={32} maxLength={128} value={token} onChange={event => setToken(event.target.value)} disabled={busy || !relay.trim()} /></label>
            </details>
            {!!status?.devices.length && <p className="connections-note">This replaces your previous connection. Existing devices will need to pair again.</p>}
            <div className="connections-dialog-actions"><button type="button" className="settings-button" disabled={busy} onClick={closeDialog}>Cancel</button><button className="settings-primary-button" disabled={busy || (!!token.trim() && token.trim().length < 32)}>{busy ? 'Connecting…' : 'Enable access'}</button></div>
          </form>}
          {dialog === 'pair' && pair && <>
            <div className="connections-qr">{seconds > 0 ? <img src={pair.qr} width={220} height={220} alt="Scan to pair a device" /> : <div className="connections-expired"><Monitor /><p>Pairing code expired</p><button className="settings-primary-button" disabled={busy || !ready} onClick={() => void act('pair')}>Generate new code</button></div>}</div>
            <p className="connections-pair-expiry">{seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · Single use` : 'Generate a new code to continue.'}</p>
            <div className="connections-dialog-actions"><button className="settings-button" disabled={!seconds || busy} onClick={() => void copyLink()}><Copy className="h-3.5 w-3.5" />{copied ? 'Copied' : 'Copy pairing link'}</button><button className="settings-primary-button" onClick={closeDialog}>Done</button></div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}

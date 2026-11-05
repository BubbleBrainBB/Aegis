import { useEffect, useState } from 'react';
import { parseRemoteProjectPath } from '../../shared/remote/remote-path';
import type { RemoteAgentEntry } from '../../shared/remote/agent-catalog';

export interface RemoteHostProject {
  path: string;
  name: string;
  isRepo?: boolean;
}
export interface RemoteHost {
  id: string;
  name: string;
  status: string;
  projects: RemoteHostProject[];
}

/** Other Macs this one controls, refreshed while something shows them. */
export function useRemoteHosts() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      window.electron.remoteHosts('list').then((next: RemoteHost[]) => {
        if (active) setHosts(next);
      }).catch(() => { /* Local projects still work. */ });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return hosts;
}

/** When `cwd` is a project on another Mac: that Mac, the project and the agents it has. */
export function useRemoteTarget(cwd: string | null | undefined) {
  const parsed = parseRemoteProjectPath(cwd);
  const hostId = parsed?.hostId;
  const hosts = useRemoteHosts();
  const [catalog, setCatalog] = useState<RemoteAgentEntry[]>([]);
  useEffect(() => {
    setCatalog([]);
    if (!hostId) return;
    let active = true;
    window.electron.remoteHosts('agents', { id: hostId }).then((next: RemoteAgentEntry[]) => {
      if (active) setCatalog(next);
    }).catch(() => { /* The picker stays empty and the start reports what's wrong. */ });
    return () => { active = false; };
  }, [hostId]);
  if (!parsed) return null;
  const host = hosts.find((entry) => entry.id === parsed.hostId);
  return {
    hostId: parsed.hostId,
    hostName: host?.name ?? '',
    project: host?.projects.find((project) => project.path === cwd),
    catalog,
  };
}

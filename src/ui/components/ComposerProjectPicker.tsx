import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { useRemoteHosts } from '../hooks/useRemoteHosts';
import { parseRemoteProjectPath } from '../../shared/remote/remote-path';
import { Folder, Plus, Search, X } from './icons';

export function ComposerProjectPicker({ cwd, onSelect, onSelectNoProject, disabled = false, variant = 'control', projectName: label }: {
  cwd: string;
  onSelect: (cwd: string) => void;
  /** Offers "No project": the conversation becomes a chat with a folder of its own. */
  onSelectNoProject?: () => void;
  disabled?: boolean;
  variant?: 'hero' | 'control';
  projectName?: string;
}) {
  const sessions = useAppStore((state) => state.sessions);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    window.electron.getRecentCwds(50).then((dirs) => {
      if (active) setRecentCwds(dirs);
    }).catch(() => { /* Session projects remain available offline. */ });
    return () => { active = false; };
  }, [open]);

  const hosts = useRemoteHosts();
  const projects = useMemo(() => Array.from(new Set([
    parseRemoteProjectPath(cwd) ? '' : cwd,
    ...Object.values(sessions)
      .filter((session) => !session.hiddenFromThreads && session.scope !== 'dm' && !session.isChat)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => session.projectCwd || session.cwd || ''),
    ...recentCwds,
  ].map((dir) => dir.trim()).filter((dir) => dir && !parseRemoteProjectPath(dir)))), [cwd, sessions, recentCwds]);
  const search = query.trim().toLowerCase();
  const filteredProjects = projects.filter((dir) => dir.toLowerCase().includes(search));
  const remote = parseRemoteProjectPath(cwd);
  const remoteHostName = remote ? hosts.find((host) => host.id === remote.hostId)?.name : undefined;
  const projectName = label || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  const pillName = remoteHostName ? `${remoteHostName} / ${projectName}` : projectName;

  const selectProject = (dir: string) => {
    setOpen(false);
    if (!disabled && dir !== cwd) onSelect(dir);
  };
  const selectNoProject = () => {
    setOpen(false);
    if (!disabled && cwd) onSelectNoProject?.();
  };
  const noProject = !cwd && Boolean(onSelectNoProject);
  const browse = async () => {
    setOpen(false);
    try {
      const dir = await window.electron.selectDirectory();
      if (dir) selectProject(dir);
    } catch {
      toast.error('Could not open the project folder.');
    }
  };

  return (
    <>
      <Popover.Root open={open && !disabled} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setQuery('');
      }}>
        <Popover.Trigger
          disabled={disabled}
          aria-label={variant === 'hero' ? `Switch project: ${projectName}` : 'Project folder'}
          title={cwd || (noProject ? 'No project' : 'Choose project')}
          className={variant === 'hero' ? 'aegis-new-thread-project-link' : 'aegis-composer-context-pill aegis-composer-project-control'}
        >
          {variant === 'hero' ? `${projectName}?` : <>
            <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{noProject ? 'No project' : pillName || 'Choose project'}</span>
          </>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={8} className="z-[9999]">
            <Popover.Popup initialFocus={searchRef} aria-label="Switch project" className="popover-surface aegis-composer-project-menu w-[264px] max-w-[calc(100vw-32px)] p-1 text-left font-normal tracking-normal">
              <Command shouldFilter={false} label="Projects" defaultValue={noProject ? '__no_project__' : undefined}>
                <div className="flex items-center gap-2 border-b border-[var(--border)] px-2.5 pb-2 pt-1.5">
                  <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <Command.Input ref={searchRef} value={query} onValueChange={setQuery} aria-label="Search projects" placeholder="Search projects" className="min-w-0 w-full bg-transparent text-[12.5px] leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
                </div>
                <Command.List>
                  {/* Only the projects scroll; the actions stay pinned below them. */}
                  <div className="max-h-[min(232px,45vh)] overflow-y-auto py-1">
                    {hosts.length > 0 && <div className="px-2 pb-1 pt-1.5 text-[12px] text-[var(--text-muted)]">This Mac</div>}
                    {filteredProjects.length === 0 && <div className="px-2 py-2 text-[12.5px] leading-[18px] text-[var(--text-muted)]">No projects found</div>}
                    {filteredProjects.map((dir) => {
                      const current = dir === cwd;
                      return (
                        <Command.Item key={dir} value={dir} onSelect={() => selectProject(dir)} title={dir} data-current={current || undefined} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] text-[12.5px] leading-[18px] text-[var(--text-primary)] data-[current]:bg-[var(--bg-tertiary)] data-[selected=true]:bg-[var(--bg-tertiary)]">
                          {current
                            ? <Folder aria-label="Current project" className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                            : <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />}
                          <span className="min-w-0 flex-1 truncate">{dir.split(/[\\/]/).filter(Boolean).pop() || dir}</span>
                        </Command.Item>
                      );
                    })}
                    {hosts.map((host) => {
                      const connected = host.status === 'connected';
                      const listed = host.projects.filter((project) => project.name.toLowerCase().includes(search));
                      if (search && listed.length === 0) return null;
                      return (
                        <div key={host.id} data-remote-host-projects={host.id}>
                          <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[12px] text-[var(--text-muted)]">
                            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'}`} aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{host.name}</span>
                            {connected ? null : <span className="flex-shrink-0">Offline</span>}
                          </div>
                          {listed.map((project) => (
                            <Command.Item
                              key={project.path}
                              value={project.path}
                              disabled={!connected}
                              onSelect={() => selectProject(project.path)}
                              data-current={project.path === cwd || undefined}
                              className="flex cursor-pointer items-center gap-2 rounded-[var(--popover-item-radius,8px)] px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none data-[selected=true]:bg-[var(--bg-tertiary)] data-[disabled=true]:cursor-default data-[disabled=true]:text-[var(--text-muted)]"
                            >
                              <Folder aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${project.path === cwd ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} />
                              <span className="min-w-0 flex-1 truncate">{project.name}</span>
                            </Command.Item>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t border-[var(--border)] pt-1">
                    <Command.Item value="__browse_project__" onSelect={() => { void browse(); }} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] text-[12.5px] leading-[18px] text-[var(--text-secondary)] data-[selected=true]:bg-[var(--bg-tertiary)] data-[selected=true]:text-[var(--text-primary)]">
                      <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      New project
                    </Command.Item>
                    {onSelectNoProject ? (
                      <Command.Item value="__no_project__" onSelect={selectNoProject} data-current={noProject || undefined} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] text-[12.5px] leading-[18px] text-[var(--text-secondary)] data-[current]:bg-[var(--bg-tertiary)] data-[current]:text-[var(--text-primary)] data-[selected=true]:bg-[var(--bg-tertiary)] data-[selected=true]:text-[var(--text-primary)]">
                        <X className={`h-3.5 w-3.5 shrink-0 ${noProject ? 'text-[var(--accent)]' : ''}`} aria-hidden="true" />
                        Don't work in a project
                      </Command.Item>
                    ) : null}
                  </div>
                </Command.List>
              </Command>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

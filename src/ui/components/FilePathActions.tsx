import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BrandGithub, Check, ChevronDown, Copy } from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { OpenWithButton } from './OpenWithButton';

interface RepoBrief {
  root: string | null;
  fullName: string | null;
  branch: string | null;
  defaultBranch: string | null;
}

const slashes = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

/** `file` as seen from `root`, or null when it sits outside. */
export function pathRelativeTo(root: string | null | undefined, file: string): string | null {
  if (!root) return null;
  const base = slashes(root);
  const target = slashes(file);
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/** The file on github.com, on the branch that is checked out. */
export function githubFileUrl(brief: RepoBrief | null, file: string): string | null {
  const relative = pathRelativeTo(brief?.root, file);
  const branch = brief?.branch || brief?.defaultBranch;
  if (!brief?.fullName || !relative || !branch) return null;
  const encode = (value: string) => value.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${brief.fullName}/blob/${encode(branch)}/${encode(relative)}`;
}

async function readRepoBrief(cwd: string): Promise<RepoBrief | null> {
  const read = window.electron.getGitRepoBrief;
  if (typeof read !== 'function') return null;
  try {
    const res = await read(cwd);
    return res.ok
      ? { root: res.root ?? null, fullName: res.fullName, branch: res.branch, defaultBranch: res.defaultBranch }
      : null;
  } catch {
    return null;
  }
}

function useRepoBrief(cwd: string | null): RepoBrief | null {
  const [state, setState] = useState<{ cwd: string; brief: RepoBrief | null } | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void readRepoBrief(cwd).then((brief) => {
      if (!cancelled) setState({ cwd, brief });
    });
    return () => { cancelled = true; };
  }, [cwd]);
  return state && state.cwd === cwd ? state.brief : null;
}

const pill = 'inline-flex h-7 items-stretch overflow-hidden rounded-full border border-[var(--border)] bg-[var(--bg-primary)]';
const pillButton = 'inline-flex items-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]';

/**
 * "Copy path", with the other forms of the path one menu away. A file with
 * no project around it (a task attachment) has only its absolute path, so
 * the menu goes away.
 */
export function CopyPathButton({ filePath, projectRoot, repoRoot }: {
  filePath: string;
  projectRoot?: string | null;
  repoRoot?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => setCopied(false), [filePath]);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => setCopied(true))
      .catch(() => toast.error('Unable to copy the path.'));
  }, []);

  const forms = [
    { label: 'Absolute path', value: filePath },
    { label: 'Relative to project', value: pathRelativeTo(projectRoot, filePath) },
    { label: 'Relative to repo', value: pathRelativeTo(repoRoot, filePath) },
  ].filter((form): form is { label: string; value: string } => Boolean(form.value));

  return (
    <div className={pill}>
      <button
        type="button"
        onClick={() => copy(filePath)}
        className={`${pillButton} ${forms.length > 1 ? 'pl-2 pr-1' : 'px-[6px]'}`}
        title={copied ? 'Copied' : 'Copy path'}
        aria-label="Copy path"
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      {forms.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={`${pillButton} pl-1 pr-2`} title="Copy path as…" aria-label="Copy path as…">
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[10.5rem] p-1">
            {forms.map((form) => (
              <DropdownMenuItem key={form.label} onSelect={() => copy(form.value)} className="rounded-md px-2 py-1.5 text-[13px]">
                {form.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** Header actions of a project file: copy its path, see it on GitHub, open it elsewhere. */
export function ProjectFileActions({ cwd, filePath }: { cwd: string | null; filePath: string }) {
  const brief = useRepoBrief(cwd);
  const onGitHub = Boolean(githubFileUrl(brief, filePath));

  // The branch may have changed since the header mounted; read it again on click.
  const openInGitHub = useCallback(async () => {
    const url = githubFileUrl(cwd ? await readRepoBrief(cwd) : null, filePath);
    if (!url) {
      toast.error('This file is not in a GitHub repository.');
      return;
    }
    const res = await window.electron.openExternalUrl(url);
    if (res && !res.ok) toast.error(res.message || 'Unable to open GitHub.');
  }, [cwd, filePath]);

  return (
    <>
      <CopyPathButton filePath={filePath} projectRoot={cwd} repoRoot={brief?.root} />
      {onGitHub ? (
        <button
          type="button"
          onClick={() => void openInGitHub()}
          className={`${pillButton} h-7 w-7 justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)]`}
          title="Open in GitHub"
          aria-label="Open in GitHub"
        >
          <BrandGithub className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <OpenWithButton cwd={cwd} filePath={filePath} onOpenInGitHub={onGitHub ? () => void openInGitHub() : undefined} />
    </>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { BrandGithub, ChevronDown, Download, FolderClosed, FolderOpen } from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface OpenWithApp {
  name: string;
  appPath: string;
  iconDataUrl: string | null;
}

/** "Save as…": the system dialog picks where the copy goes. */
export async function saveFileCopyAs(cwd: string | null, filePath: string): Promise<void> {
  const save = window.electron.saveFileCopy;
  if (!cwd || typeof save !== 'function') return;
  try {
    const res = await save(cwd, filePath);
    if (!res.ok) toast.error(res.message || 'The file could not be saved.');
    else if (res.filePath) toast.success(`Saved ${res.filePath.split(/[\\/]/).pop()}`);
  } catch {
    toast.error('The file could not be saved.');
  }
}

/** Dropdown shows at most this many apps (default first) — no scrolling list. */
const OPEN_WITH_MAX_APPS = 5;

// Session-lived cache of Launch Services results so re-selecting a file (or
// re-rendering the header) doesn't re-spawn osascript. Keyed per file.
const openWithAppsCache = new Map<string, OpenWithApp[]>();

// Header "Open ∨" split-button. The primary side shows the DEFAULT app's icon
// and opens the file with it; the chevron opens a short menu — the top apps
// that can open the file (Launch Services order, capped) plus
// "Show in Finder". The app list (and thus the default-app icon) is fetched
// eagerly when the file is selected. On non-macOS, or when Launch Services
// fails or knows no app, the list settles empty and the control hides.
export function OpenWithButton({
  cwd,
  filePath,
  fallback = null,
  onOpenInGitHub,
}: {
  cwd: string | null;
  filePath: string;
  /** Adds "Open in GitHub" when the file has a page there. */
  onOpenInGitHub?: () => void;
  /** Shown once the app list settles empty (other platforms, no known app). */
  fallback?: ReactNode;
}) {
  const [apps, setApps] = useState<OpenWithApp[] | null>(null);
  const requestKeyRef = useRef<string>('');

  useEffect(() => {
    if (!cwd || !filePath) {
      setApps(null);
      return;
    }
    const key = `${cwd} ${filePath}`;
    requestKeyRef.current = key;

    const cached = openWithAppsCache.get(key);
    if (cached) {
      setApps(cached);
      return;
    }

    setApps(null);
    const lister = window.electron.listOpenWithApps;
    if (typeof lister !== 'function') {
      setApps([]);
      return;
    }
    lister(cwd, filePath)
      .then((res) => {
        const list = res && res.ok && Array.isArray(res.apps) ? res.apps : [];
        if (openWithAppsCache.size > 100) openWithAppsCache.clear();
        openWithAppsCache.set(key, list);
        // Ignore a response for a file that is no longer selected.
        if (requestKeyRef.current !== key) return;
        setApps(list);
      })
      .catch(() => {
        if (requestKeyRef.current === key) setApps([]);
      });
  }, [cwd, filePath]);

  const openWith = useCallback(
    async (appPath: string) => {
      if (!cwd) return;
      const opener = window.electron.openFileWithApp;
      if (typeof opener !== 'function') return;
      const res = await opener(cwd, filePath, appPath);
      if (res && !res.ok) toast.error(res.message || 'Failed to open the file.');
    },
    [cwd, filePath]
  );

  const revealFolder = useCallback(() => {
    void window.electron.revealPath?.(filePath);
  }, [filePath]);

  // Hidden until the list resolves; the fallback takes over when it settles empty.
  if (!cwd || !apps) return null;
  if (apps.length === 0) return <>{fallback}</>;

  const defaultApp = apps[0];
  const menuApps = apps.slice(0, OPEN_WITH_MAX_APPS);

  return (
    <div className="inline-flex h-7 items-stretch overflow-hidden rounded-full border border-[var(--border)] bg-[var(--bg-primary)]">
      <button
        type="button"
        onClick={() => void openWith(defaultApp.appPath)}
        className="inline-flex items-center gap-1.5 pl-2 pr-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
        title={`Open with ${defaultApp.name}`}
        aria-label={`Open with ${defaultApp.name}`}
      >
        {defaultApp.iconDataUrl ? (
          <img
            src={defaultApp.iconDataUrl}
            alt=""
            className="h-4 w-4 flex-shrink-0"
            aria-hidden="true"
          />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        )}
        <span>Open</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center pl-1 pr-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Open with…"
            aria-label="Open with…"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[10.5rem] p-1">
          {menuApps.map((appItem) => (
            <DropdownMenuItem
              key={appItem.appPath}
              onSelect={() => void openWith(appItem.appPath)}
              className="rounded-md px-2 py-1.5 text-[13px]"
            >
              {appItem.iconDataUrl ? (
                <img
                  src={appItem.iconDataUrl}
                  alt=""
                  className="mr-2.5 h-4 w-4 flex-shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <span className="mr-2.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{appItem.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={revealFolder} className="rounded-md px-2 py-1.5 text-[13px]">
            <FolderClosed className="mr-2.5 h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <span>Show in Finder</span>
          </DropdownMenuItem>
          {onOpenInGitHub ? (
            <DropdownMenuItem onSelect={onOpenInGitHub} className="rounded-md px-2 py-1.5 text-[13px]">
              <BrandGithub className="mr-2.5 h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
              <span>Open in GitHub</span>
            </DropdownMenuItem>
          ) : null}
          {typeof window.electron.saveFileCopy === 'function' ? (
            <DropdownMenuItem onSelect={() => void saveFileCopyAs(cwd, filePath)} className="rounded-md px-2 py-1.5 text-[13px]">
              <Download className="mr-2.5 h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
              <span>Save as…</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ProjectTreeNode } from '../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import type { SessionView } from '../../types';
import { FileTypeIcon } from '../FileTypeIcon';
import { ChevronRight } from '../icons';

function outputFiles(node: ProjectTreeNode | null): ProjectTreeNode[] {
  if (!node?.children) return [];
  return node.children
    .flatMap((child) => (child.kind === 'dir' ? outputFiles(child) : [child]))
    .filter((file) => !file.name.startsWith('.'));
}

/** The files the agent saved to the chat's outputs/, read again whenever a turn ends. */
function useChatOutputs(cwd: string | null, open: boolean, status: SessionView['status'] | undefined) {
  const [files, setFiles] = useState<ProjectTreeNode[] | null>(null);
  useEffect(() => {
    if (!open || !cwd || status === 'running') return;
    let active = true;
    window.electron.getProjectTree(`${cwd.replace(/[\\/]+$/, '')}/outputs`)
      .then((tree) => { if (active) setFiles(outputFiles(tree).sort((a, b) => a.name.localeCompare(b.name))); })
      .catch(() => { if (active) setFiles([]); });
    return () => { active = false; };
  }, [cwd, open, status]);
  return files;
}

/**
 * What a chat without a project has instead of Git: the files the agent saved
 * to outputs/, and the Sources you attached.
 */
export function EnvironmentChatSection({ session, open, onOpenSources, onNavigate }: {
  session: SessionView;
  open: boolean;
  onOpenSources?: (path: string | null) => void;
  onNavigate: () => void;
}) {
  const cwd = session.cwd?.trim() || null;
  const files = useChatOutputs(cwd, open, session.status);
  const openFile = (file: ProjectTreeNode) => {
    if (!cwd) return;
    void window.electron.getProjectTree(cwd)
      .then((tree) => { if (tree) useAppStore.getState().setProjectTree(cwd, tree); })
      .catch(() => { /* The file still opens without a fresh tree. */ })
      .finally(() => {
        useAppStore.getState().openProjectFileInRightPanel({ cwd, path: file.path });
        onNavigate();
      });
  };

  return (
    <>
      <section className="environment-summary-section" aria-label="Outputs">
        <div className="px-2 pb-0.5 text-[12px] font-medium text-[var(--text-secondary)]">Outputs</div>
        {files === null ? (
          <div role="status" className="px-2 py-1 text-[12px] text-[var(--text-muted)]">Loading…</div>
        ) : files.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-[var(--text-muted)]">Nothing saved yet</div>
        ) : files.map((file) => (
          <button key={file.path} type="button" className="environment-summary-row" title={file.path} onClick={() => openFile(file)}>
            <FileTypeIcon name={file.name} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
          </button>
        ))}
      </section>
      {onOpenSources ? (
        <section className="environment-summary-section" aria-label="Sources">
          <button type="button" className="environment-summary-row text-[var(--text-secondary)]" onClick={() => { onOpenSources(null); onNavigate(); }}>
            <span>Sources</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          </button>
        </section>
      ) : null}
    </>
  );
}

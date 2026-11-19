import { useEffect, useState } from 'react';
import type { Attachment } from '../types';
import type { SessionSourcePreview } from '../../shared/session-sources';
import { FileTypeIcon } from './FileTypeIcon';
import { ChevronRight } from './icons';
import { CopyPathButton } from './FilePathActions';
import { OpenWithButton } from './OpenWithButton';
import { ProjectVideoPreview } from './ProjectVideoPreview';
import { previewSessionSource } from '../utils/session-source-client';

export function SourceRow({ source, onClick }: { source: Attachment; onClick: () => void }) {
  return <button type="button" className="environment-summary-row w-full text-left" title={source.path} onClick={onClick}>
    <FileTypeIcon name={source.name} className="h-3.5 w-3.5 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{source.name || source.path.split('/').pop()}</span>
  </button>;
}

export function SessionSourcesPanel({ sessionId, sources, loading, error, onRetry, selectedPath, onSelect }: {
  sessionId: string;
  sources: Attachment[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const selected = sources.find(source => source.path === selectedPath);
  const [result, setResult] = useState<{ path: string; sessionId: string; preview: SessionSourcePreview } | null>(null);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setResult(null);
    void previewSessionSource(sessionId, selected, window.electron).then(preview => {
      if (!cancelled) setResult({ sessionId, path: selected.path, preview });
    }).catch(error => {
      console.error('[Sources] Attachment preview request failed.', { sessionId, error: String(error).replaceAll(selected.path, '[attachment]') });
      if (!cancelled) setResult({ sessionId, path: selected.path, preview: { kind: 'error', message: 'Unable to open this attachment.' } });
    });
    return () => { cancelled = true; };
  }, [sessionId, selected?.path]);
  const preview = result?.sessionId === sessionId && result.path === selected?.path ? result.preview : null;

  // The stored copy sits alone in its own folder, which is all "Open with" needs.
  const selectedFolder = selected ? selected.path.replace(/[\\/][^\\/]*$/, '') : null;

  return <section aria-label="Task sources" className={`h-full text-[var(--text-primary)] ${selected ? 'flex min-h-0 flex-col' : 'overflow-auto p-4'}`}>
    {selected ? <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-1 text-[13px] leading-[22px]" title={selected.path}>
          <button type="button" onClick={() => onSelect(null)} aria-label="All sources" className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">Sources</button>
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-70" />
          <span className="truncate font-medium">{selected.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CopyPathButton filePath={selected.path} />
          <OpenWithButton cwd={selectedFolder} filePath={selected.path} />
        </div>
      </div>
      <div className={`min-h-0 flex-1 px-4 ${preview?.kind === 'video' ? 'pb-2' : 'overflow-auto pb-4'}`}>
        {!preview ? <p role="status" className="text-sm text-[var(--text-muted)]">Loading preview…</p> :
          preview.kind === 'image' ? <img src={preview.url} alt={selected.name} className="max-w-full rounded-md object-contain" /> :
          preview.kind === 'video' ? <ProjectVideoPreview key={selected.path} src={preview.url} name={selected.name} active file={{ cwd: selectedFolder, path: selected.path }} /> :
          preview.kind === 'audio' ? <audio src={preview.url} controls className="w-full" /> :
          preview.kind === 'pdf' ? <iframe title={selected.name} src={preview.url} className="h-full min-h-[500px] w-full border-0" /> :
          preview.kind === 'text' ? <pre className="whitespace-pre-wrap break-words text-sm">{preview.text}</pre> :
          <p role={preview.kind === 'error' ? 'alert' : undefined} className="text-sm text-[var(--text-muted)]">{preview.kind === 'error' ? preview.message : 'Preview is unavailable for this file. Open it in the default app.'}</p>}
      </div>
    </> : <>
      <h2 className="mb-3 text-sm font-medium">Sources <span className="text-[var(--text-muted)]">{sources.length}</span></h2>
      {sources.map(source => <div key={source.path} className="mb-2">
        <SourceRow source={source} onClick={() => onSelect(source.path)} />
        <p className="px-2 text-[11px] text-[var(--text-muted)]">Attached to this task</p>
      </div>)}
      {loading ? <p role="status" className="text-sm text-[var(--text-muted)]">Loading sources…</p> : null}
      {!loading && !error && !sources.length ? <p className="text-sm text-[var(--text-muted)]">Attachments sent in this task will appear here.</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--text-muted)]">{error} <button type="button" onClick={onRetry} className="underline">Retry</button></p> : null}
    </>}
  </section>;
}

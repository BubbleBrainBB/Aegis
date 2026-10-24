import { useEffect, useState, type RefObject } from 'react';
import { MDContent } from '../render/markdown';
import type { ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { Eye, Pencil } from './icons';

export interface ComposerMarkdownPreviewState {
  active: boolean;
  canPreview: boolean;
  toggle: () => void;
}

/**
 * Write/Preview toggle for a composer draft. Clearing the draft (e.g. after
 * sending) or changing `resetKey` returns to editing.
 */
export function useComposerMarkdownPreview(
  value: string,
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
  resetKey?: unknown
): ComposerMarkdownPreviewState {
  const [active, setActive] = useState(false);
  const canPreview = value.trim().length > 0;

  useEffect(() => {
    if (!canPreview) setActive(false);
  }, [canPreview]);
  useEffect(() => setActive(false), [resetKey]);

  const toggle = () => {
    if (!active) return setActive(canPreview);
    setActive(false);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  };

  return { active, canPreview, toggle };
}

export function ComposerMarkdownPreviewToggle({ preview }: { preview: ComposerMarkdownPreviewState }) {
  const label = preview.active ? 'Back to editing' : 'Preview Markdown';
  return (
    <button
      type="button"
      onClick={preview.toggle}
      disabled={!preview.active && !preview.canPreview}
      aria-pressed={preview.active}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${
        preview.active ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
      }`}
      title={label}
      aria-label={label}
    >
      {preview.active ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

export function ComposerMarkdownPreview({ value, preview }: { value: string; preview: ComposerMarkdownPreviewState }) {
  if (!preview.active) return null;
  return (
    <div
      className="aegis-composer-markdown-preview min-h-[56px] max-h-[200px] overflow-y-auto overscroll-contain px-4 pt-3 pb-1 text-[14px] [overflow-wrap:anywhere] [&_.markdown-content>:first-child]:mt-0 [&_.markdown-content>:last-child]:mb-0"
      aria-label="Markdown preview"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          preview.toggle();
        }
      }}
    >
      <MDContent content={value} />
    </div>
  );
}

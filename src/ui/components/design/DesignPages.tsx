import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MoreHorizontal, Plus, X } from '../icons';
import { DesignActionMenu } from './DesignChrome';
import type { DesignPage } from '../../../shared/design-types';
import { isImeComposing } from '../../utils/ime';

/** Page management is versioned; the active page and its camera are viewer state. */
export function DesignPages({ pages, activeId, editable, onSelect, onCreate, onRename, onDelete, counts }: {
  pages: DesignPage[]; activeId: string; editable: boolean;
  onSelect(id: string): void; onCreate(): void;
  onRename(id: string, name: string): void; onDelete(id: string): void;
  counts(id: string): { boards: number; marks: number };
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; id: string; name: string }>();
  const editor = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (dialog) { editor.current?.focus(); editor.current?.select(); if (!editor.current) dialogRef.current?.focus(); } }, [dialog?.id, dialog?.kind]);
  const close = () => { setDialog(undefined); trigger.current?.focus(); };
  const current = pages.find(page => page.id === activeId) ?? pages[0];
  const count = dialog ? counts(dialog.id) : undefined;
  return <>
    <button ref={trigger} className="design-pages-trigger" aria-label="Pages" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}><span>{current.name}</span><ChevronDown size={14} /></button>
    {open && <DesignActionMenu trigger={trigger} onClose={() => setOpen(false)} label="Pages" align="start" className="design-pages-menu">
      {pages.map(page => <div key={page.id} className="design-page-row">
        <button role="menuitemradio" aria-checked={activeId === page.id} onClick={() => { onSelect(page.id); setOpen(false); }}>
          <Check size={14} style={{ opacity: activeId === page.id ? 1 : 0 }} /><span>{page.name}</span>
        </button>
        <button aria-label={`Actions for ${page.name}`} disabled={!editable} onClick={() => setActions(actions === page.id ? undefined : page.id)}><MoreHorizontal size={14} /></button>
        {actions === page.id && <div className="design-page-actions">
          <button role="menuitem" onClick={() => { setOpen(false); setDialog({ kind: 'rename', ...page }); }}>Rename</button>
          <button role="menuitem" disabled={pages.length <= 1} title={pages.length <= 1 ? 'Keep at least one page' : undefined}
            onClick={() => { setOpen(false); setDialog({ kind: 'delete', ...page }); }}>Delete page…</button>
        </div>}
      </div>)}
      <div className="design-menu-divider" />
      <button role="menuitem" disabled={!editable || pages.length >= 40} onClick={() => { setOpen(false); onCreate(); }}><Plus size={14} />New page</button>
    </DesignActionMenu>}
    {dialog && createPortal(<div className="design-surface design-page-dialog-backdrop" data-canvas-ui onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialogRef} className="design-page-dialog" role="dialog" aria-modal="true" aria-label={dialog.kind === 'rename' ? 'Rename page' : 'Delete page'} tabIndex={-1}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Escape' && !isImeComposing(e)) close();
          if (e.key === 'Tab') {
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input')];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && index <= 0) { e.preventDefault(); items.at(-1)?.focus(); }
            else if (!e.shiftKey && index === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
          }
        }}>
        <div className="design-page-dialog-title"><strong>{dialog.kind === 'rename' ? 'Rename page' : `Delete ${dialog.name}?`}</strong><button aria-label="Close" onClick={close}><X size={16} /></button></div>
        {dialog.kind === 'rename' ? <form onSubmit={e => { e.preventDefault(); if (dialog.name.trim()) { onRename(dialog.id, dialog.name.trim()); close(); } }}>
          <input ref={editor} aria-label="Page name" maxLength={120} value={dialog.name} onChange={e => setDialog({ ...dialog, name: e.target.value })} />
          <div className="design-page-dialog-actions"><button type="button" onClick={close}>Cancel</button><button type="submit" disabled={!editable || !dialog.name.trim()}>Save</button></div>
        </form> : <>
          <p>This removes {count?.boards} board{count?.boards === 1 ? '' : 's'} and {count?.marks} canvas annotation{count?.marks === 1 ? '' : 's'}. You can undo this change.</p>
          <div className="design-page-dialog-actions"><button onClick={close}>Cancel</button><button disabled={!editable || pages.length <= 1} onClick={() => { onDelete(dialog.id); close(); }}>Delete page</button></div>
        </>}
      </div>
    </div>, document.body)}
  </>;
}

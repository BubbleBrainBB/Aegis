import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { shortcutLabel } from '../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../store/useAppPreferences';
import { ExpandDiagonal, Plus } from './icons';

export type NewTabMode = 'split' | 'full';

const CLOSE_DELAY_MS = 120;

function NewTabIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/**
 * The title bar's entry to the right pane while it has no tabs, Codex-style: a
 * click opens a New tab, hovering offers the two ways to open one. Not a
 * dropdown-menu: that always takes focus when it opens, and a pointer passing
 * over the title bar must leave focus in the composer.
 */
export function NewTabMenuButton({ onNewTab }: { onNewTab: (mode: NewTabMode) => void }) {
  const [open, setOpen] = useState(false);
  const shortcuts = useAppPreferences((state) => state.keyboardShortcuts);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      if (menuRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const select = (mode: NewTabMode) => {
    cancelClose();
    setOpen(false);
    onNewTab(mode);
  };

  const focusItem = (index: number) => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items?.length) items[(index + items.length) % items.length].focus();
  };

  return (
    <div
      className="no-drag relative"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelClose();
        closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && menuRef.current?.contains(event.target)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-new-tab-button
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
        // A click with the mouse leaves focus where it was.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => select('split')}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          flushSync(() => setOpen(true));
          focusItem(event.key === 'ArrowDown' ? 0 : -1);
        }}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
          open ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        <NewTabIcon />
      </button>
      {open ? (
        // The padding carries the pointer across the gap below the button.
        <div className="absolute right-0 top-full z-[90] pt-1.5">
          <div
            ref={menuRef}
            role="menu"
            data-hover-menu
            aria-label="New tab"
            className="popover-surface w-[240px] p-1"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
              focusItem(items.indexOf(document.activeElement as Element) + (event.key === 'ArrowDown' ? 1 : -1));
            }}
          >
            <NewTabMenuItem
              icon={<Plus className="h-[15px] w-[15px]" aria-hidden="true" />}
              label="New tab"
              shortcut={shortcutLabel('rightPanel', shortcuts)}
              onSelect={() => select('split')}
            />
            <NewTabMenuItem
              icon={<ExpandDiagonal className="h-[14px] w-[14px]" aria-hidden="true" />}
              label="New tab in full view"
              shortcut={shortcutLabel('rightPanelFullView', shortcuts)}
              onSelect={() => select('full')}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewTabMenuItem({
  icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  shortcut: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className="flex h-[30px] w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)] focus-visible:bg-[var(--bg-tertiary)]"
    >
      <span className="flex w-4 shrink-0 justify-center text-[var(--text-secondary)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? <span className="shrink-0 pl-4 text-[11.5px] text-[var(--text-muted)]">{shortcut}</span> : null}
    </button>
  );
}

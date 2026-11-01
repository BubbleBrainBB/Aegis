import { useEffect, useState } from 'react';
import * as DropdownMenu from './ui/dropdown-menu';
import { Check, ShieldCheck } from './icons';
import { FullAccessPermissionIcon } from './FullAccessPermissionIcon';

import type { PermissionModeOption } from '../utils/permission-modes';
export * from '../utils/permission-modes';

export function PermissionModePicker<M extends string>({
  value,
  options,
  onChange,
  disabled,
  menuSide = 'top',
}: {
  value: M;
  options: ReadonlyArray<PermissionModeOption<M>>;
  onChange: (mode: M) => void;
  disabled?: boolean;
  /** Bottom-anchored composers open upward; other surfaces can override. */
  menuSide?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const current = options.find((option) => option.mode === value);
  const tone = current?.tone;

  return (
    <DropdownMenu.Root open={open && !(disabled)} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Permission mode: ${current?.label ?? value}`}
        title={`Permission mode: ${current?.label ?? value}`}
        data-composer-control="permission"
        data-tone={tone}
        className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          tone === 'full-access'
            ? 'text-[var(--warning)] hover:text-[var(--warning)]'
            : tone === 'danger'
              ? 'text-[var(--error)] hover:text-[var(--error)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
        {tone === 'full-access' ? (
          <FullAccessPermissionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : <ShieldCheck className="aegis-composer-compact-icon h-4 w-4 shrink-0" aria-hidden="true" />}
        <span className="aegis-composer-responsive-label">{current?.label ?? value}</span>
      </button>

      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={menuSide} align="start" sideOffset={8}
          className="flex w-[272px] max-w-[calc(100vw-32px)] flex-col p-1.5">
          <div className="px-2.5 pb-1 pt-1 text-[12px] font-medium text-[var(--text-muted)]">
            Permissions
          </div>
          {options.filter((option) => !option.hidden).map((option) => (
            <PermissionModeOptionRow key={option.mode} option={option}
              active={option.mode === value} onSelect={(mode) => { if (!disabled) onChange(mode); }} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PermissionModeOptionRow<M extends string>({
  option,
  active,
  onSelect,
}: {
  option: PermissionModeOption<M>;
  active: boolean;
  onSelect: (mode: M) => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={() => onSelect(option.mode)}
      className="flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${
          option.tone === 'full-access'
            ? 'text-[var(--warning)]'
            : option.tone === 'danger'
              ? 'text-[var(--error)]'
              : 'text-[var(--text-primary)]'
        }`}>
          {option.label}
        </span>
        {option.description ? (
          <span className="block truncate text-[12px] text-[var(--text-muted)]">{option.description}</span>
        ) : null}
      </span>
      {active ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      ) : null}
    </DropdownMenu.Item>
  );
}

// ── Per-provider mode maps ──────────────────────────────────────────────────
// The single source for what each provider's picker offers. Ordered least →
// most permissive, mirroring each provider's own mode union.


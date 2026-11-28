import { useEffect, useState } from 'react';
import * as DropdownMenu from './ui/dropdown-menu';
import { Check, Hand } from './icons';
import { AutoPermissionIcon, FullAccessPermissionIcon } from './FullAccessPermissionIcon';
import { FullAccessConfirmDialog } from './FullAccessConfirmDialog';
import { PROVIDERS } from '../utils/provider';
import type { AgentProvider } from '../types';

import type { PermissionModeOption } from '../utils/permission-modes';
export * from '../utils/permission-modes';

function isElevatedTone(tone: PermissionModeOption<string>['tone']): boolean {
  return tone === 'full-access' || tone === 'danger';
}

export function PermissionModePicker<M extends string>({
  value,
  options,
  onChange,
  disabled,
  menuSide = 'top',
  provider,
  isRemote = false,
}: {
  value: M;
  options: ReadonlyArray<PermissionModeOption<M>>;
  onChange: (mode: M) => void;
  disabled?: boolean;
  /** Bottom-anchored composers open upward; other surfaces can override. */
  menuSide?: 'top' | 'bottom';
  /** Active agent provider id, used to personalize the Full Access confirmation dialog. */
  provider?: AgentProvider | string;
  /** Whether the session executes on a paired remote machine. */
  isRemote?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pendingConfirmOption, setPendingConfirmOption] = useState<PermissionModeOption<M> | null>(null);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setPendingConfirmOption(null);
    }
  }, [disabled]);
  const current = options.find((option) => option.mode === value);
  const tone = current?.tone;
  const isAutoMode = value === 'auto' || value === 'smart';
  const agentLabel = provider
    ? PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider
    : 'The agent';

  const handleSelectOption = (option: PermissionModeOption<M>) => {
    if (disabled || option.mode === value) return;
    if (isElevatedTone(option.tone)) {
      setPendingConfirmOption(option);
      return;
    }
    onChange(option.mode);
  };

  return (
    <>
    <DropdownMenu.Root open={open && !(disabled)} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Permission mode: ${current?.label ?? value}`}
        title={`Permission mode: ${current?.label ?? value}`}
        data-composer-control="permission"
        data-tone={tone}
        className={`inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-1.5 text-[12px] leading-[18px] font-normal transition-colors hover:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          tone === 'full-access'
            ? 'text-[var(--permission-warning)] hover:text-[var(--permission-warning)]'
            : tone === 'danger'
              ? 'text-[var(--error)] hover:text-[var(--error)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] data-[popup-open]:text-[var(--text-secondary)]'
        }`}
      >
        {tone === 'full-access' || tone === 'danger' ? (
          <FullAccessPermissionIcon className="aegis-composer-compact-icon h-4 w-4 shrink-0" aria-hidden="true" />
        ) : isAutoMode ? (
          <AutoPermissionIcon className="aegis-composer-compact-icon h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Hand stroke={1.65} className="aegis-composer-compact-icon h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="aegis-composer-responsive-label max-w-40">{current?.label ?? value}</span>
      </button>

      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={menuSide} align="start" sideOffset={6}
          className="flex w-[280px] max-w-[calc(100vw-16px)] flex-col p-1 [--popover-radius:16px]">
          <div className="px-2.5 py-1.5 text-[12px] leading-4 font-normal text-[var(--text-muted)]">
            Permissions
          </div>
          {options.filter((option) => !option.hidden).map((option) => (
            <PermissionModeOptionRow key={option.mode} option={option}
              active={option.mode === value} onSelect={() => handleSelectOption(option)} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <FullAccessConfirmDialog
      request={
        pendingConfirmOption
          ? {
              modeLabel: pendingConfirmOption.label,
              agentLabel,
              isRemote,
            }
          : null
      }
      onCancel={() => setPendingConfirmOption(null)}
      onConfirm={() => {
        const confirmed = pendingConfirmOption;
        setPendingConfirmOption(null);
        if (!disabled && confirmed) {
          onChange(confirmed.mode);
        }
      }}
    />
    </>
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
  const toneColorClass =
    option.tone === 'full-access'
      ? 'text-[var(--permission-warning)]'
      : option.tone === 'danger'
        ? 'text-[var(--error)]'
        : null;

  return (
    <DropdownMenu.Item
      onSelect={() => onSelect(option.mode)}
      className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
    >
      <span className="min-w-0 flex-1">
        <span className={`block whitespace-normal text-[12px] leading-4 font-normal ${
          toneColorClass ?? 'text-[var(--text-primary)]'
        }`}>
          {option.label}
        </span>
        {option.description ? (
          <span className={`mt-0.5 block whitespace-normal text-[11px] leading-[1.35] ${
            toneColorClass ?? 'text-[var(--text-muted)]'
          }`}>
            {option.description}
          </span>
        ) : null}
      </span>
      {active ? (
        <Check
          stroke={2}
          className={`h-3.5 w-3.5 shrink-0 ${
            toneColorClass ?? 'text-[var(--text-primary)]'
          }`}
          aria-hidden="true"
        />
      ) : null}
    </DropdownMenu.Item>
  );
}

// ── Per-provider mode maps ──────────────────────────────────────────────────
// The single source for what each provider's picker offers. Ordered least →
// most permissive, mirroring each provider's own mode union.


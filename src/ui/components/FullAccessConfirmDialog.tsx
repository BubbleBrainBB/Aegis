import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from './icons';
import * as Dialog from './ui/dialog';

export interface FullAccessConfirmRequest {
  modeLabel: string;
  agentLabel: string;
  isRemote?: boolean;
}

function FilesSpotIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0"
      aria-hidden="true"
    >
      <path
        fill="#2E9EFF"
        d="M22 9v4H2V7c0-2.35 1.65-4 4-4h2.64c2.98 0 2.75 2 4.61 2H18c2.35 0 4 1.65 4 4Z"
      />
      <path
        fill="#68C4FF"
        d="M18 21c2.35 0 4-1.65 4-4v-5a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v5c0 2.35 1.65 4 4 4h12Z"
      />
    </svg>
  );
}

function TerminalSpotIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        className="fill-[#4D4D4D] dark:fill-[#6E6E77]"
      />
      <path
        d="M7.65 9.65 10.1 12l-2.45 2.35"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.6 14.35h3.5"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function InternetSpotIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-6 w-6 shrink-0"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" className="fill-[#CDF3FF] dark:fill-[#243B45]" />
      <path
        fill="#41CEF9"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2Zm-2.83 11c.15 4.48 1.29 7 2.83 7 1.54 0 2.68-2.52 2.83-7H9.17Zm-5.11 0a8 8 0 0 0 4.32 6.13C7.69 17.62 7.26 15.55 7.17 13H4.06Zm12.77 0c-.09 2.55-.52 4.62-1.21 6.13A8 8 0 0 0 19.94 13h-3.11ZM8.38 4.87A8 8 0 0 0 4.06 11h3.11c.09-2.55.52-4.62 1.21-6.13ZM12 4c-1.54 0-2.68 2.52-2.83 7h5.66C14.68 6.52 13.54 4 12 4Zm3.62.87c.69 1.51 1.12 3.58 1.21 6.13h3.11a8 8 0 0 0-4.32-6.13Z"
      />
    </svg>
  );
}

function CapabilityItemRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      {icon}
      <div className="min-w-0">
        <div className="text-[13px] leading-[18px] font-semibold text-[var(--text-primary)]">
          {title}
        </div>
        <div className="text-[12px] leading-[16px] text-[color-mix(in_srgb,var(--text-secondary)_70%,var(--text-muted))]">
          {description}
        </div>
      </div>
    </div>
  );
}

export function FullAccessConfirmDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: FullAccessConfirmRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Retain the last request during the exit transition so copy doesn't blank mid-fade.
  const [rendered, setRendered] = useState<FullAccessConfirmRequest | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request) setRendered(request);
  }, [request]);

  const open = request !== null;
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      confirmButtonRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const active = request ?? rendered;
  if (!active) return null;

  const computerTarget = active.isRemote ? 'the remote computer' : 'this computer';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/20 dark:bg-black/50 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Content
          data-testid="full-access-confirm-dialog"
          className="fixed left-1/2 top-1/2 z-[201] w-[472px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-5 shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            <Dialog.Title className="flex items-center gap-2 text-[17px] leading-6 font-semibold tracking-[-0.015em] text-[var(--text-primary)]">
              <AlertTriangle
                stroke={1.75}
                className="h-[18px] w-[18px] shrink-0 text-[var(--text-primary)]"
                aria-hidden="true"
              />
              <span>Turn on {active.modeLabel}?</span>
            </Dialog.Title>

            <Dialog.Description className="mt-3 text-[13px] leading-[1.45] font-normal text-[color-mix(in_srgb,var(--text-secondary)_78%,var(--text-muted))] text-pretty">
              {active.agentLabel} will be able to run commands, use the internet, and create and edit files anywhere on {computerTarget} without your permission. This includes but is not limited to:
            </Dialog.Description>

            <div className="mt-3.5 rounded-2xl bg-[color-mix(in_srgb,var(--text-primary)_4.5%,transparent)] dark:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] px-4 py-3">
              <CapabilityItemRow
                icon={<FilesSpotIcon />}
                title="Files and folders"
                description={`Read, create, modify, upload, or delete files anywhere on ${computerTarget}`}
              />
              <CapabilityItemRow
                icon={<TerminalSpotIcon />}
                title="Terminal commands"
                description="Run commands, install software, and change system settings"
              />
              <CapabilityItemRow
                icon={<InternetSpotIcon />}
                title="Internet and connected apps"
                description="Access websites, send data, and use enabled plugins"
              />
            </div>

            <p className="mt-3.5 text-[13px] leading-[1.45] text-[color-mix(in_srgb,var(--text-secondary)_78%,var(--text-muted))] text-pretty">
              This comes with risks like loss or exposure of sensitive data and prompt injection. You can turn this off anytime.
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="cancel-full-access"
                onClick={onCancel}
                className="inline-flex h-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] px-4 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)]"
              >
                Cancel
              </button>
              <button
                ref={confirmButtonRef}
                type="submit"
                autoFocus
                data-testid="confirm-full-access"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-4 text-[13px] font-medium text-[var(--error)] transition-colors hover:bg-[color-mix(in_srgb,var(--error)_18%,transparent)]"
              >
                <AlertTriangle stroke={1.85} className="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
                <span>Confirm</span>
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

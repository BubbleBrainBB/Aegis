import { shortcutLabel } from '../../../shared/keyboard-shortcuts';
import { useUserProfile } from '../../hooks/useUserProfile';
import { useAppPreferences } from '../../store/useAppPreferences';
import { avatarColorFor, initialsOf } from '../../utils/user-avatar';
import { Settings } from '../icons';
import { SidebarScreenshotMenu } from './SidebarScreenshotMenu';
import { SidebarUsageMenu } from './SidebarUsageMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function SidebarProfileMenu({
  onOpenSettings,
  variant = 'row',
}: {
  onOpenSettings: () => void;
  /** `rail`: avatar-only trigger at the foot of the icon rail. */
  variant?: 'row' | 'rail';
}) {
  const profile = useUserProfile();
  const displayName = profile?.displayName || 'Profile';
  const shortcuts = useAppPreferences((state) => state.keyboardShortcuts);
  const avatar = (compact = false) => (
    <span
      aria-hidden="true"
      className={`sidebar-profile-avatar flex shrink-0 items-center justify-center rounded-full font-medium text-white ${compact ? 'h-5 w-5 text-[8px]' : 'h-6 w-6 text-[9px]'}`}
      style={{ backgroundColor: avatarColorFor(displayName) }}
    >
      {initialsOf(displayName)}
    </span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'rail' ? (
          <button
            type="button"
            aria-label={`Profile menu: ${displayName}`}
            title={displayName}
            className="no-drag flex h-8 w-8 items-center justify-center rounded-full outline-none transition-transform duration-150 active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {avatar()}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Profile menu: ${displayName}`}
            title={displayName}
            className="no-drag flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[popup-open]:bg-[var(--sidebar-item-hover)]"
          >
            {avatar(true)}
            <span className="sidebar-profile-name min-w-0 truncate text-[12px] font-normal">{displayName}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={variant === 'rail' ? 'right' : 'top'}
        align={variant === 'rail' ? 'end' : 'start'}
        sideOffset={8}
        className={variant === 'rail' ? 'min-w-[220px]' : 'w-[var(--anchor-width)] min-w-[200px]'}
      >
        <div className="flex min-w-0 items-center gap-2 px-2 py-2">
          {avatar()}
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--text-primary)]" title={displayName}>{displayName}</div>
            {profile?.handle ? <div className="truncate text-[11px] text-[var(--text-muted)]">@{profile.handle}</div> : null}
          </div>
        </div>
        <DropdownMenuSeparator />
        <SidebarUsageMenu />
        <SidebarScreenshotMenu />
        <DropdownMenuItem onSelect={onOpenSettings} className="gap-2 px-2 text-[13px] text-[var(--text-secondary)]">
          <Settings className="h-4 w-4 text-[var(--text-muted)]" />
          <span>Settings</span>
          <DropdownMenuShortcut>{shortcutLabel('settings', shortcuts)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

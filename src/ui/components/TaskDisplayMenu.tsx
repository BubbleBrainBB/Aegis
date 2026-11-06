import { Popover } from '@base-ui-components/react/popover';
import type { ReactNode } from 'react';
import { shortcutLabel } from '../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../store/useAppPreferences';
import { useSidebarViewStore } from '../store/useSidebarViewStore';
import {
  isDefaultSidebarView,
  boardGroupBy,
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_ACTIVITY_LABELS,
  SIDEBAR_GROUP_LABELS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_STATUS_LABELS,
  TASK_PROPERTY_LABELS,
  type SidebarGroupBy,
  type TaskLayout,
  type TaskProperty,
} from '../utils/sidebar-view';
import { Check, ChevronDown, Columns2, List, SlidersHorizontal } from './icons';
import { SettingsToggle } from './settings/SettingsPrimitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const LAYOUTS: ReadonlyArray<{ id: TaskLayout; label: string; icon: ReactNode }> = [
  { id: 'list', label: 'List', icon: <List className="h-3.5 w-3.5" /> },
  { id: 'board', label: 'Board', icon: <Columns2 className="h-3.5 w-3.5" /> },
];

function entries<T extends string>(labels: Record<T, string>): { value: T; label: string }[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="text-[13px] text-[var(--text-secondary)]">{label}</span>
      {children}
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label}>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              aria-label={label}
              className="inline-flex h-7 w-[136px] flex-shrink-0 items-center justify-between gap-1 rounded-md border border-[var(--border)] pl-2.5 pr-1.5 text-[13px] text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-[var(--sidebar-item-hover)]"
            />
          }
        >
          <span className="min-w-0 truncate">{options.find((option) => option.value === value)?.label}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-[168px]">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]"
              role="menuitemradio"
              aria-checked={option.value === value}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Row>
  );
}

/** How My Tasks is drawn: list or board, how it groups, what each task shows. */
export function TaskDisplayMenu() {
  const view = useSidebarViewStore();
  const shortcuts = useAppPreferences((state) => state.keyboardShortcuts);
  const changed = !isDefaultSidebarView(view);
  const stateShortcut = shortcutLabel('activity', shortcuts);
  const isBoard = view.layout === 'board';
  const groupBy = isBoard ? boardGroupBy(view.groupBy) : view.groupBy;
  const subGroupBy = view.subGroupBy === groupBy ? 'none' : view.subGroupBy;
  const allGroups = entries(SIDEBAR_GROUP_LABELS);
  const toggleProperty = (property: TaskProperty) => {
    view.setOption(
      'properties',
      view.properties.includes(property)
        ? view.properties.filter((entry) => entry !== property)
        : DEFAULT_SIDEBAR_VIEW.properties.filter((entry) => entry === property || view.properties.includes(entry))
    );
  };

  return (
    <Popover.Root>
      <Popover.Trigger
        className={`no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 data-[popup-open]:bg-[var(--sidebar-item-active)] ${
          changed
            ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[popup-open]:text-[var(--text-primary)]'
        }`}
        aria-label={changed ? 'Display options (customized)' : 'Display options'}
        title={stateShortcut ? `Display options · ${stateShortcut} toggles Group by State` : 'Display options'}
      >
        <SlidersHorizontal className="h-4 w-4" strokeWidth={1.4} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-[9998]">
          <Popover.Popup aria-label="Display options" className="popover-surface w-[316px] text-left" data-task-display-menu>
            <div className="grid grid-cols-2 gap-1.5 p-2.5" role="group" aria-label="Layout">
              {LAYOUTS.map((layout) => (
                <button
                  key={layout.id}
                  type="button"
                  aria-pressed={view.layout === layout.id}
                  onClick={() => view.setOption('layout', layout.id)}
                  className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-full border text-[13px] transition-colors duration-150 ${
                    view.layout === layout.id
                      ? 'border-transparent bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {layout.icon}
                  {layout.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-3 py-2.5">
              <Select<SidebarGroupBy>
                label={isBoard ? 'Columns' : 'Grouping'}
                value={groupBy}
                options={isBoard ? allGroups.filter((option) => option.value !== 'none') : allGroups}
                onChange={(value) => view.setOption('groupBy', value)}
              />
              <Select<SidebarGroupBy>
                label="Sub-grouping"
                value={subGroupBy}
                options={allGroups.filter((option) => option.value !== groupBy)}
                onChange={(value) => view.setOption('subGroupBy', value)}
                disabled={groupBy === 'none'}
              />
              <Select
                label="Ordering"
                value={view.sortBy}
                options={entries(SIDEBAR_SORT_LABELS)}
                onChange={(value) => view.setOption('sortBy', value)}
              />
            </div>

            <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-3 py-2.5">
              <Select
                label="Completed tasks"
                value={view.activity}
                options={entries(SIDEBAR_ACTIVITY_LABELS)}
                onChange={(value) => view.setOption('activity', value)}
              />
              <Select
                label="Status"
                value={view.status}
                options={entries(SIDEBAR_STATUS_LABELS)}
                onChange={(value) => view.setOption('status', value)}
              />
              <Row label="Show sub-sessions">
                <SettingsToggle
                  ariaLabel="Show sub-sessions"
                  checked={view.showSubSessions}
                  onChange={(value) => view.setOption('showSubSessions', value)}
                />
              </Row>
              {groupBy === 'state' ? (
                <Row label={isBoard ? 'Show empty columns' : 'Show empty groups'}>
                  <SettingsToggle
                    ariaLabel="Show empty groups"
                    checked={view.showEmptyGroups}
                    onChange={(value) => view.setOption('showEmptyGroups', value)}
                  />
                </Row>
              ) : null}
            </div>

            <div className="border-t border-[var(--border)] px-3 py-2.5">
              <p className="pb-2 text-[13px] text-[var(--text-secondary)]">Display properties</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Display properties">
                {entries(TASK_PROPERTY_LABELS).map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view.properties.includes(value)}
                    onClick={() => toggleProperty(value)}
                    className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] transition-colors duration-150 ${
                      view.properties.includes(value)
                        ? 'border-transparent bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {changed ? (
              <div className="border-t border-[var(--border)] px-3 py-2">
                <button
                  type="button"
                  onClick={view.reset}
                  className="text-[13px] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)]"
                >
                  Reset to default
                </button>
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

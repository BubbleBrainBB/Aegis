import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createLauncherTabId,
  getRightUtilityTabKind,
  replaceLauncherTab,
  resolveRightUtilityTabOpen,
} from '../../src/ui/utils/right-utility-tabs';
import { resolveDockedRightPanelWidth } from '../../src/ui/utils/right-panel-width';

async function main() {
  assert.equal(
    resolveDockedRightPanelWidth(820, 560),
    320,
    'a desktop-sized panel must remain docked at the right of the minimum window'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 692),
    340,
    'compact windows must preserve a visible conversation pane'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 1600),
    820,
    'wide windows must preserve the saved panel width'
  );
  assert.equal(
    resolveDockedRightPanelWidth(1500, 2000),
    1500,
    'large windows can use more than 58 percent without crowding the conversation'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 280),
    280,
    'a host narrower than the panel minimum must not overflow'
  );

  const first = resolveRightUtilityTabOpen([], 'files', { newTab: true });
  assert.equal(first.tabs.length, 1);
  assert.equal(first.activeTab, first.tabs[0]);
  assert.match(first.activeTab, /^files:/);

  const second = resolveRightUtilityTabOpen(first.tabs, 'files', { newTab: true });
  assert.equal(second.tabs.length, 2, 'Files from the plus menu must append another tab');
  assert.notEqual(second.activeTab, first.activeTab, 'the new Files tab must have its own identity');
  assert.equal(second.activeTab, second.tabs[1], 'the new Files tab must become active');

  const existing = resolveRightUtilityTabOpen(second.tabs, 'files');
  assert.deepEqual(existing.tabs, second.tabs, 'ordinary Files navigation should reuse a tab');
  assert.equal(existing.activeTab, first.activeTab);

  // Codex-style "New tab": each one is its own tab, and picking a tool in it
  // replaces that tab in place.
  const launcherA = createLauncherTabId();
  const launcherB = createLauncherTabId();
  assert.notEqual(launcherA, launcherB, 'several New tabs can be open at once');
  assert.equal(getRightUtilityTabKind(launcherA), 'launcher');
  // A chat's design library and each of its designs are design tabs.
  assert.equal(getRightUtilityTabKind('design'), 'design');
  assert.equal(getRightUtilityTabKind('design:des_1'), 'design');
  const withLaunchers = ['review', launcherA, 'terminal', launcherB] as const;
  const pickedFiles = resolveRightUtilityTabOpen([...withLaunchers], 'files', { newTab: true });
  assert.deepEqual(
    replaceLauncherTab([...withLaunchers], pickedFiles.tabs, pickedFiles.activeTab, launcherA),
    ['review', pickedFiles.activeTab, 'terminal', launcherB],
    'a new tool tab takes the New tab\'s place'
  );
  const pickedReview = resolveRightUtilityTabOpen([...withLaunchers], 'review');
  assert.deepEqual(
    replaceLauncherTab([...withLaunchers], pickedReview.tabs, pickedReview.activeTab, launcherB),
    ['review', launcherA, 'terminal'],
    'picking a tool that is already open just drops the New tab'
  );

  const appSource = await readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8');
  // Codex-style: "+" opens the new-tab page (the pane's tool launcher)
  // instead of a dropdown, and the page's tools open tabs on click.
  assert.match(
    appSource,
    /onClick=\{onOpenLauncher\}[\s\S]{0,600}aria-label="New tab"/,
    'the plus button must open the new-tab page'
  );
  // The launcher is an HTML surface in the pane, so the browser's native view
  // must be collapsed whenever another panel (the launcher included) shows.
  assert.match(
    appSource,
    /collapsed=\{activeUtilityPanel !== 'browser' \|\| activeRightUtilityTab !== tabId\}/,
    'a browser tab must collapse its native view while the launcher shows'
  );
  assert.match(
    appSource,
    /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/,
    'a newly active utility tab must be scrolled into view'
  );
  assert.match(
    appSource,
    /BrowserNativeOverlayContext\.Provider value=\{browserNativeOverlayContextValue\}/,
    'app-level overlays must publish shared native-view visibility to BrowserPanel'
  );

  const panelSource = await readFile(
    new URL('../../src/ui/components/browser/BrowserPanel.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    panelSource,
    // App dialogs draw in an overlay window above the page; the page view
    // hides only once that window is ready, so the dialog never flashes blank.
    /nativeViewHidden = collapsed \|\| pageOverlay !== null \|\| \(overlayOpen && overlayFrame\?\.ready === true\)/,
    'BrowserPanel must hide the WebContentsView while an HTML overlay is open'
  );
  assert.match(
    panelSource,
    /useLayoutEffect\(\(\) => \{\s*nativeViewActiveRef\.current = !nativeViewHidden;[\s\S]*?if \(nativeViewHidden\) hide\(\);[\s\S]*?\}, \[browserSessionId, nativeViewHidden\]\)/,
    'collapsing a browser tab must detach the native view before the next paint'
  );

  const attachmentPreviewSource = await readFile(
    new URL('../../src/ui/components/AttachmentPreviewGrid.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    attachmentPreviewSource,
    /useBrowserNativeOverlayRegistration\(lightboxOpen\)/,
    'the attachment lightbox must hide the native browser view while open'
  );

  console.log('right-utility-tabs tests passed');
}

void main();

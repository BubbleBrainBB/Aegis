// Fullscreen belongs to the right panel: opening, switching and closing tabs
// keep it (following the active tab when that kind has its own fullscreen
// view), and it only ends when the user leaves it or no tab can hold it.
import assert from 'node:assert/strict';
import { useAppStore } from '../../src/ui/store/useAppStore';

const store = () => useAppStore.getState();
const fs = () => store().rightPanelFullscreen;
store().createDraftSession('/p');
const start = (tab: string, kind: 'files' | 'browser' | 'review') =>
  useAppStore.setState({ rightUtilityTabs: [tab], activeRightUtilityTab: tab, rightUtilityPanelHidden: false, rightPanelFullscreen: kind });

// Opening a tab from the panel's + menu.
start('files:a', 'files');
store().openRightUtilityTab('browser', { newTab: true });
assert.equal(fs(), 'browser', 'a browser opened over a fullscreen file is fullscreen');
// What App does after any tab change (activateRightUtilityContent).
store().setProjectTreeCollapsed(true);
assert.equal(fs(), 'browser', 'activating the new tab keeps fullscreen');

start('browser', 'browser');
store().openRightUtilityTab('files', { newTab: true });
assert.equal(fs(), 'files', 'a Files tab opened over a fullscreen browser is fullscreen');

start('files:a', 'files');
store().openRightUtilityTab('terminal');
store().setProjectTreeCollapsed(true);
assert.equal(fs(), 'terminal', 'a terminal opened over a fullscreen file is fullscreen');
assert.equal(store().activeRightUtilityTab, 'terminal');

// A New tab from the strip's + keeps fullscreen, and so does the tool
// picked on it.
start('files:a', 'files');
store().openRightUtilityLauncherTab();
assert.equal(fs(), 'files', 'a New tab opened in a fullscreen panel is fullscreen');
const launcher = store().activeRightUtilityTab!;
store().openRightUtilityTab('browser', { newTab: true, replace: launcher });
assert.equal(fs(), 'browser', 'the tool picked on the New tab is fullscreen');
assert.equal(store().rightUtilityTabs.includes(launcher), false);

start('files:a', 'files');
store().openRightUtilityLauncherTab();
store().openRightUtilityTab('terminal:x', { replace: store().activeRightUtilityTab! });
assert.equal(fs(), 'terminal', 'a terminal picked on the New tab is fullscreen');

// A terminal can be fullscreen on its own, like a browser.
start('terminal:a', 'files');
store().setRightPanelFullscreen(null);
store().setRightPanelFullscreen('terminal');
assert.equal(fs(), 'terminal', 'a terminal goes fullscreen');
assert.equal(store().rightUtilityPanelHidden, false);

// Switching between tabs.
store().setActiveRightUtilityTab('files:a');
assert.equal(fs(), 'files');
useAppStore.setState({ rightUtilityTabs: ['files:a', 'browser'], activeRightUtilityTab: 'files:a', rightPanelFullscreen: 'files' });
store().setActiveRightUtilityTab('browser');
assert.equal(fs(), 'browser', 'switching tabs keeps fullscreen');

// Closing the fullscreen tab hands fullscreen to the next one.
useAppStore.setState({ rightUtilityTabs: ['files:a', 'browser'], activeRightUtilityTab: 'browser', rightPanelFullscreen: 'browser' });
store().closeRightUtilityTab('browser');
assert.equal(store().activeRightUtilityTab, 'files:a');
assert.equal(fs(), 'files', 'the tab that takes over stays fullscreen');

useAppStore.setState({ rightUtilityTabs: ['files:a', 'terminal'], activeRightUtilityTab: 'files:a', rightPanelFullscreen: 'files' });
store().closeRightUtilityTab('files:a');
assert.equal(fs(), 'terminal', 'a terminal left behind stays fullscreen');

useAppStore.setState({ rightUtilityTabs: ['files:a', 'sources:%2Fp%2Fa.png'], activeRightUtilityTab: 'files:a', rightPanelFullscreen: 'files' });
store().closeRightUtilityTab('files:a');
assert.equal(fs(), null, 'with no tab left that can be fullscreen, the panel docks');

useAppStore.setState({ rightUtilityTabs: ['files:a'], activeRightUtilityTab: 'files:a', rightPanelFullscreen: 'files' });
store().closeRightUtilityTab('files:a');
assert.equal(fs(), null, 'closing the last tab ends fullscreen');

// The user leaving fullscreen still works.
start('files:a', 'files');
store().setRightPanelFullscreen(null);
assert.equal(fs(), null);

// The main session is the fullscreen panel's first tab: showing it keeps
// fullscreen, and any panel tab taking focus switches back to that tab.
const chat = () => store().rightPanelFullscreenChat;
useAppStore.setState({ rightUtilityTabs: ['files:a', 'browser'], activeRightUtilityTab: 'browser', rightUtilityPanelHidden: false, rightPanelFullscreen: 'browser' });
store().setRightPanelFullscreenChat(true);
assert.equal(chat(), true);
assert.equal(fs(), 'browser', 'showing the chat tab keeps the panel fullscreen');
store().setActiveRightUtilityTab('browser');
assert.equal(chat(), false, 'clicking the tab that was active shows it again');
store().setRightPanelFullscreenChat(true);
store().openProjectFileInRightPanel({ cwd: '/p', filePath: '/p/a.md' });
assert.equal(chat(), false, 'a file link shows the file');
store().setRightPanelFullscreenChat(true);
store().openRightUtilityTab('terminal');
assert.equal(chat(), false, 'opening a panel tab shows it');
store().setRightPanelFullscreenChat(true);
store().closeRightUtilityTab('terminal');
assert.equal(chat(), true, 'closing a panel tab stays on the chat');
store().setRightPanelFullscreen(null);
assert.equal(chat(), false, 'leaving fullscreen drops the chat tab');
store().setRightPanelFullscreenChat(true);
store().setRightPanelFullscreen('files');
assert.equal(chat(), false, 'entering fullscreen shows the panel');
store().setRightPanelFullscreenChat(true);
store().closeRightUtilityPanels();
assert.equal(chat(), false, 'closing the panel drops the chat tab');

console.log('right-panel-fullscreen-tabs: fullscreen survives opening, switching and closing tabs');

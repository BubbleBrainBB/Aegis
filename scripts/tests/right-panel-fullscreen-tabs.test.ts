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
assert.equal(fs(), 'files', 'a terminal keeps the panel fullscreen');
assert.equal(store().activeRightUtilityTab, 'terminal');

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
assert.equal(fs(), null, 'with no tab left that can be fullscreen, the panel docks');

useAppStore.setState({ rightUtilityTabs: ['files:a'], activeRightUtilityTab: 'files:a', rightPanelFullscreen: 'files' });
store().closeRightUtilityTab('files:a');
assert.equal(fs(), null, 'closing the last tab ends fullscreen');

// The user leaving fullscreen still works.
start('files:a', 'files');
store().setRightPanelFullscreen(null);
assert.equal(fs(), null);

console.log('right-panel-fullscreen-tabs: fullscreen survives opening, switching and closing tabs');

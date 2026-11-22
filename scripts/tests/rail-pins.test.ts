import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PINNABLE_RAIL_SECTIONS,
  isPinnableRailSection,
  sanitizeRailPins,
  useRailPinsStore,
} from '../../src/ui/store/useRailPinsStore';

// The rail starts as it always looked: every pinnable section is pinned.
assert.deepEqual(useRailPinsStore.getState().pinned, [...PINNABLE_RAIL_SECTIONS]);
assert.deepEqual(sanitizeRailPins(undefined), [...PINNABLE_RAIL_SECTIONS], 'nothing saved means the defaults');

// A saved list keeps only sections that exist, once each, in menu order.
assert.deepEqual(sanitizeRailPins([]), [], 'an empty list is the user having unpinned everything');
assert.deepEqual(sanitizeRailPins(['prs', 'prs', 'gone', 7]), ['prs']);
assert.equal(isPinnableRailSection('prs'), true);
// Fixed sections and views outside the rail are never pinnable.
for (const fixed of ['chat', 'tasks', 'design', 'skills', 'automations', null, undefined]) {
  assert.equal(isPinnableRailSection(fixed), false, `${fixed} is not pinnable`);
}

// Unpinning and pinning again from the More menu.
useRailPinsStore.getState().togglePinned('prs');
assert.deepEqual(useRailPinsStore.getState().pinned, []);
useRailPinsStore.getState().togglePinned('prs');
assert.deepEqual(useRailPinsStore.getState().pinned, ['prs']);

// Every pinnable section has an entry in the rail, or the More menu would list a blank row.
const sidebar = readFileSync(new URL('../../src/ui/components/Sidebar.tsx', import.meta.url), 'utf8');
const railEntries = /const PINNABLE_SECTIONS:[^=]*= \{([\s\S]*?)\n\};/.exec(sidebar)?.[1] ?? '';
for (const section of PINNABLE_RAIL_SECTIONS) {
  assert.match(railEntries, new RegExp(`\\b${section}: \\{ label: '`), `the rail knows the ${section} section`);
}

console.log('rail pins: ok');

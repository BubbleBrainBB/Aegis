// Day dividers of the main bot's conversation: where a day starts and what it is called.
// Run: npx tsx scripts/tests/conversation-days.test.ts
import assert from 'node:assert/strict';
import { conversationDayLabel, dayStarts, startOfLocalDay } from '../../src/ui/utils/conversation-days';

// Local times, so the checks hold in any time zone.
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
const now = at(2026, 11, 20, 15);

// What a day is called.
assert.equal(conversationDayLabel(at(2026, 11, 20, 0, 1), now), 'Today');
assert.equal(conversationDayLabel(at(2026, 11, 19, 23, 59), now), 'Yesterday');
assert.equal(conversationDayLabel(at(2026, 11, 18), now), 'Wednesday');
assert.equal(conversationDayLabel(at(2026, 11, 14), now), 'Saturday', 'six days back is still a weekday');
assert.equal(conversationDayLabel(at(2026, 11, 13), now), 'Nov 13', 'a week back is a date: the weekday would read as today\'s');
assert.equal(conversationDayLabel(at(2026, 1, 2), now), 'Jan 2');
assert.equal(conversationDayLabel(at(2025, 12, 31), now), 'Dec 31, 2025', 'another year is named');
assert.equal(conversationDayLabel(at(2026, 11, 21), now), 'Today', 'a clock that runs ahead does not invent a day');
// Just after midnight, last night is yesterday.
assert.equal(conversationDayLabel(at(2026, 11, 19, 23, 59), at(2026, 11, 20, 0, 1)), 'Yesterday');
assert.equal(conversationDayLabel(at(2025, 12, 31, 23), at(2026, 1, 1, 1)), 'Yesterday', 'across the new year too');

// Where a day starts.
const wednesday = startOfLocalDay(at(2026, 11, 18));
const thursday = startOfLocalDay(at(2026, 11, 19));
const friday = startOfLocalDay(at(2026, 11, 20));
assert.deepEqual([...dayStarts([])], []);
assert.deepEqual([...dayStarts([at(2026, 11, 18, 9)])], [[0, wednesday]], 'the first row opens its day');
assert.deepEqual(
  [...dayStarts([at(2026, 11, 18, 9), at(2026, 11, 18, 23, 59), at(2026, 11, 19, 0, 0), at(2026, 11, 19, 8), at(2026, 11, 20, 1)])],
  [[0, wednesday], [2, thursday], [4, friday]],
  'one divider a day, at midnight local time'
);
// A row that draws nothing (no time given) never opens a day: the next drawn row does.
assert.deepEqual(
  [...dayStarts([undefined, at(2026, 11, 18, 9), null, undefined, at(2026, 11, 19, 8), Number.NaN, at(2026, 11, 20, 1)])],
  [[1, wednesday], [4, thursday], [6, friday]]
);
assert.deepEqual([...dayStarts([undefined, null])], []);
// A row stamped before the day already shown stays under it: the dates only move forward.
assert.deepEqual(
  [...dayStarts([at(2026, 11, 19, 8), at(2026, 11, 18, 23), at(2026, 11, 19, 9), at(2026, 11, 20, 1)])],
  [[0, thursday], [3, friday]]
);

console.log('conversation-days: ok');

// Live show_widget drafts: the HTML is read out of argument JSON that may stop
// anywhere, and the tracker emits throttled drafts for show_widget calls only.
import assert from 'node:assert/strict';
import { WidgetDraftTracker, readPartialJsonString } from '../../src/electron/libs/widget-draft';

// ── readPartialJsonString ──────────────────────────────────────────────────
const full = JSON.stringify({ title: 'Flow "A"', html: '<div class="a">\n\tx\\y é</div>' });
assert.equal(readPartialJsonString(full, 'html'), '<div class="a">\n\tx\\y é</div>');
assert.equal(readPartialJsonString(full, 'title'), 'Flow "A"');
assert.equal(readPartialJsonString('{"title":"x"', 'html'), undefined, 'field not started');
assert.equal(readPartialJsonString('{"html":"', 'html'), '', 'field just opened');
assert.equal(readPartialJsonString('{"html":"<p>he', 'html'), '<p>he', 'cut mid-string');
assert.equal(readPartialJsonString('{"html":"<p class=\\', 'html'), '<p class=', 'cut mid-escape');
assert.equal(readPartialJsonString('{"html":"a\\u00', 'html'), 'a', 'cut mid unicode escape');
assert.equal(readPartialJsonString('{"html" : "a\\"b"', 'html'), 'a"b', 'spacing and escaped quote');
// Every prefix of a real argument decodes to a prefix of the final markup.
const html = '<style>.k{color:var(--text-primary)}</style><div class="k">“quoted” \\ done</div><script>let a = "x";</script>';
const json = JSON.stringify({ title: 'T', html });
for (let cut = 0; cut <= json.length; cut += 1) {
  const value = readPartialJsonString(json.slice(0, cut), 'html');
  if (value !== undefined) assert(html.startsWith(value), `prefix at ${cut}: ${value}`);
}

// ── WidgetDraftTracker ─────────────────────────────────────────────────────
async function trackerChecks() {
  const sent: Array<{ toolUseId: string; html: string; title?: string }> = [];
  const tracker = new WidgetDraftTracker((draft) => sent.push(draft), 20);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Other tools are ignored, even when their deltas keep coming.
  tracker.begin('edit', 'Edit');
  tracker.append('edit', '{"html":"<p>not a widget</p>"}');
  tracker.append('unknown', '{"html":"x"}');
  assert.equal(tracker.isTracking('edit'), false);

  // A show_widget call (any MCP prefix): deltas coalesce, the end flushes the rest.
  tracker.append('w1', '', 'mcp__aegis-sessions__show_widget');
  assert(tracker.isTracking('w1'));
  tracker.append('w1', '{"title":"Plan","html":"<div>');
  tracker.append('w1', 'one');
  await wait(40);
  assert.deepEqual(sent, [{ type: 'widget_draft', toolUseId: 'w1', html: '<div>one', title: 'Plan' }]);
  tracker.append('w1', '</div>"}');
  tracker.end('w1');
  assert.equal(sent.length, 2, 'end flushes without waiting for the throttle');
  assert.equal(sent[1].html, '<div>one</div>');
  assert.equal(tracker.isTracking('w1'), false);
  await wait(40);
  assert.equal(sent.length, 2, 'nothing after the end');

  // Full-argument replacement (Bubble) and parsed fields (Pi).
  tracker.replace('w2', '{"html":"<b>', 'show_widget');
  tracker.replace('w2', '{"html":"<b>bold</b>"}', 'show_widget');
  tracker.end('w2');
  assert.equal(sent.at(-1)?.html, '<b>bold</b>');
  tracker.replaceFields('w3', { html: '<i>pi</i>', title: 'Pi' }, 'show_widget');
  tracker.end('w3');
  assert.deepEqual(sent.at(-1), { type: 'widget_draft', toolUseId: 'w3', html: '<i>pi</i>', title: 'Pi' });

  // Unchanged markup isn't sent twice; endAll flushes every open call; reset drops them.
  const before = sent.length;
  tracker.append('w4', '{"html":"same', 'show_widget');
  tracker.append('w5', '{"html":"other', 'show_widget');
  tracker.endAll();
  assert.deepEqual(sent.slice(before).map((draft) => draft.html), ['same', 'other']);
  tracker.append('w6', '{"html":"dropped', 'show_widget');
  tracker.reset();
  await wait(40);
  assert.equal(sent.length, before + 2, 'reset drops pending drafts');

}

void trackerChecks().then(() => {
  console.log('widget-draft: partial JSON decoding and throttled show_widget drafts passed');
}, (error) => {
  console.error(error);
  process.exitCode = 1;
});

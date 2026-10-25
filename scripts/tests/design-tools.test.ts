import assert from 'node:assert/strict';
import { designToolNameOf, isDesignWriteTool } from '../../src/shared/design-tools';
import { findPendingToolUse, sameToolInput } from '../../src/electron/libs/tool-caller-attribution';
import { designToolDisplay } from '../../src/ui/utils/design-tool-display';
import { designGuideText } from '../../src/electron/design/guide';
import { DESIGN_STARTER_KINDS, designStarter, designStarterText } from '../../src/electron/design/starters';
import { looksEscapedMarkup, sanitizeDesignHtml } from '../../src/shared/design-html';
import { readDesignLayers, type DesignLayer } from '../../src/shared/design-layers';
import type { StreamMessage } from '../../src/shared/types';

// Names: bare or namespaced by Aegis's own servers; another server's look-alike is not ours.
assert.equal(designToolNameOf('design_update'), 'design_update');
assert.equal(designToolNameOf('mcp__aegis-sessions__design_update'), 'design_update');
assert.equal(designToolNameOf('aegis-sessions_design_read'), 'design_read');
assert.equal(designToolNameOf('aegis-widgets.design_preview'), 'design_preview');
assert.equal(designToolNameOf('aegis-sessions/design_guide'), 'design_guide');
assert.equal(designToolNameOf('mcp__figma__design_update'), null);
assert.equal(designToolNameOf('my_design_update'), null);
assert.equal(designToolNameOf('design_updates'), null);
assert.equal(isDesignWriteTool('mcp__aegis-sessions__design_create'), true);
assert.equal(isDesignWriteTool('design_preview'), false);

// Input matching ignores key order and undefined keys.
assert.ok(sameToolInput({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined }));
assert.ok(!sameToolInput({ a: 1 }, { a: 2 }));
assert.ok(!sameToolInput([1, 2], [2, 1]));

const call = (id: string, input: unknown, name = 'design_read') =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) as unknown as StreamMessage;
const result = (id: string) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) as unknown as StreamMessage;
const sub = { ...call('sub-1', { documentId: 'd' }), parentToolUseId: 'task-1' } as unknown as StreamMessage;
const match = (name: unknown) => designToolNameOf(name) === 'design_read';
const history = [call('c1', { documentId: 'd' }), result('c1'), sub, call('c2', { documentId: 'd' }), call('c3', { documentId: 'e' })];
assert.equal(findPendingToolUse(history, match, { documentId: 'd' }), 'c2', 'the latest unanswered top-level call');
assert.equal(findPendingToolUse(history, match, { documentId: 'd' }, new Set(['c2'])), null, 'claimed calls are skipped');
assert.equal(findPendingToolUse(history, match, { documentId: 'x' }), null);
// Adapters annotate recorded inputs (Codex: a `title` argument gains __aegisDisplayTitle); the call sent no such key.
const createMatch = (name: unknown) => designToolNameOf(name) === 'design_create';
const annotated = [call('k1', { title: 'Atlas', operationId: 'op', __aegisDisplayTitle: 'Atlas' }, 'mcp__aegis-sessions__design_create')];
assert.equal(findPendingToolUse(annotated, createMatch, { title: 'Atlas', operationId: 'op' }), 'k1', 'Aegis annotations are not part of the call');
assert.equal(findPendingToolUse(annotated, createMatch, { title: 'Other', operationId: 'op' }), null);

// Trace wording.
assert.deepEqual(designToolDisplay('design_create', { title: 'Atlas website' }, 'success'), { verb: 'Created design', target: 'Atlas website' });
assert.deepEqual(designToolDisplay('design_update', { operations: [{ type: 'add', name: 'Pricing' }] }, 'pending'), { verb: 'Drawing', target: 'Pricing' });
assert.deepEqual(designToolDisplay('design_update', { operations: [{ type: 'content', boardId: 'b1' }, { type: 'content', boardId: 'b2' }] }, 'success'), { verb: 'Edited', target: '2 boards' });
assert.deepEqual(designToolDisplay('design_update', { summary: 'Calmer pricing', operations: [] }, 'success'), { verb: '', target: 'Calmer pricing' });
assert.equal(designToolDisplay('mcp__aegis-sessions__design_preview', {}, 'pending')?.verb, 'Checking');
assert.equal(designToolDisplay('read_session', {}, 'success'), null);

// Guide: topics narrow it; a picked style guide leads.
const all = designGuideText();
assert.match(all, /## Tokens first/);
assert.match(all, /## Check once with a preview/);
const some = designGuideText(['color']);
assert.match(some, /## Color and surfaces/);
assert.doesNotMatch(some, /## Tokens first/);
const styled = designGuideText(['type'], { name: 'Quiet Slate', text: '# Quiet Slate\nInk #2f3244 on #eff1f4.' });
assert.ok(styled.indexOf('Style guide: Quiet Slate') < styled.indexOf('## Typography'));
assert.match(all, /design_starter \(ios-phone, android-phone, browser-window, macos-window\)/);

// Starter frames: survive the board sanitizer whole, with locked chrome and a named content slot.
const flatten = (layers: DesignLayer[]): DesignLayer[] => layers.flatMap((l) => [l, ...flatten(l.children)]);
for (const kind of DESIGN_STARTER_KINDS) {
  for (const options of [{}, { theme: 'dark' as const }, { fullBleed: true, sidebar: 220 }]) {
    const s = designStarter(kind, options);
    const clean = sanitizeDesignHtml(`<!DOCTYPE html><html><head></head><body>${s.html}</body></html>`);
    const marks = (html: string) => (html.match(/data-aegis-starter="(frame|chrome|content)"/g) ?? []).length;
    assert.equal(marks(clean), marks(s.html), `${kind}: every starter mark is kept`);
    assert.equal((clean.match(/<svg/g) ?? []).length, (s.html.match(/<svg/g) ?? []).length, `${kind}: icons are kept`);
    const layers = flatten(readDesignLayers(clean));
    const slot = layers.find((l) => l.name === s.slot);
    assert.ok(slot, `${kind}: slot ${s.slot} is a layer`);
    assert.ok(!slot.locked, `${kind}: the slot stays editable`);
    assert.ok(layers.some((l) => l.locked && /Status bar|Browser toolbar|Title bar|Window controls/.test(l.name)), `${kind}: chrome is locked`);
    assert.ok(s.width > 0 && s.height > 0);
  }
}
assert.deepEqual([designStarter('ios-phone').width, designStarter('ios-phone').height], [414, 868]);
assert.deepEqual([designStarter('ios-phone', { width: 430, height: 932 }).width, designStarter('browser-window', { height: 600 }).height], [454, 652]);
assert.match(designStarter('macos-window', { sidebar: 240 }).html, /Sidebar content[\s\S]*Window content/);
assert.match(designStarter('ios-phone', { theme: 'dark' }).html, /background:#000000/);
const hostile = designStarter('browser-window', { url: '"><script>alert(1)</script>' }).html;
assert.ok(!hostile.includes('<script>') && hostile.includes('&lt;script&gt;'), 'address text is escaped');
assert.throws(() => designStarter('ios-phone', { width: 2000 }), /width must be a whole number from 320 to 440/);
assert.throws(() => designStarter('macos-window', { width: 480, sidebar: 300 }), /too little room/);
assert.throws(() => designStarter('tv' as never), /Unknown starter "tv"/);
const starterText = designStarterText('ios-phone');
assert.match(starterText, /Frame 414 × 868[\s\S]*board 510 × 964/);
assert.match(starterText, /inside the "Screen content" layer[\s\S]*```html\n<div data-aegis-layer-name="iPhone"/);
assert.deepEqual(designToolDisplay('design_starter', { kind: 'browser-window' }, 'pending'), { verb: 'Getting', target: 'the browser window frame' });
assert.deepEqual(designToolDisplay('design_starter', {}, 'success'), { verb: 'Got', target: 'the device frame' });

assert.doesNotMatch(designStarter('ios-phone').html, /data-aegis-starter="content"[^>]*display:flex/, 'the slot lets sections keep their size');

// Markup sent as entities would show on the board as code; text that only mentions a tag is fine.
assert.ok(looksEscapedMarkup('&lt;style&gt;:root{--bg:#EDEBE6}&lt;/style&gt;\n&lt;main class="app"&gt;&lt;h1&gt;Hi&lt;/h1&gt;&lt;/main&gt;'));
assert.ok(looksEscapedMarkup(designStarter('ios-phone').html.replace(/</g, '&lt;').replace(/>/g, '&gt;')));
assert.ok(!looksEscapedMarkup('<main><p>Use &lt;div&gt; and &lt;span&gt; and &lt;p&gt; for layout.</p></main>'), 'real tags win');
assert.ok(!looksEscapedMarkup('Wrap it in &lt;section&gt;'), 'one mention is text');
assert.ok(!looksEscapedMarkup('A &lt; B and C &gt; D'));
assert.ok(looksEscapedMarkup('&lt;style&gt;.m{}&lt;/style&gt;&lt;div class="m"&gt;胸 · <b>60 kg</b>&lt;/div&gt;&lt;div&gt;x&lt;/div&gt;'), 'escaped markup with a few real tags left in');
assert.ok(!looksEscapedMarkup('<main><h1>Docs</h1><pre><code>&lt;div&gt;&lt;span&gt;&lt;/span&gt;&lt;/div&gt;&lt;p&gt;&lt;/p&gt;</code></pre></main>'), 'a code sample on a real page');
assert.match(all, /never entities/);

// Color defaults: toned whites, not a grey page; oklch accents; consumer subjects may be bold.
assert.match(all, /subtly toned whites and blacks[\s\S]*oklch chroma 0\.02 or less/);
assert.match(all, /Accents: 0–2, defined in oklch with the same lightness and chroma/);
assert.match(all, /Consumer and brand products[\s\S]*Don't converge/);
assert.doesNotMatch(all, /A grey with a slight bias toward the accent/);
// Option sheets: one board per round, stable ids, atomic variations, real content; the avoid list exempts them.
const options = designGuideText(['options']);
assert.match(options, /## Option sheets/);
assert.match(options, /One board per round[\s\S]*stable id, round number plus letter \(1a, 1b, 1c…\)[\s\S]*atomic variation[\s\S]*product's real copy[\s\S]*recommended[\s\S]*next steps[\s\S]*Riffs on 1a/);
assert.doesNotMatch(options, /## Tokens first/);
assert.ok(all.indexOf('## Read the request first') < all.indexOf('## Option sheets') && all.indexOf('## Option sheets') < all.indexOf('## Structure that edits well'));
assert.match(all, /whole-page directions; a question about one part of a screen gets an option sheet/);
assert.match(all, /on an option sheet, matching cards and letter ids are its structure/);
assert.match(starterText, /Leave the board itself white/);
assert.doesNotMatch(starterText, /quiet backdrop|soft neutral/);

console.log('design-tools: names, attribution matching, trace wording, guide, starter frames and escaped markup passed');

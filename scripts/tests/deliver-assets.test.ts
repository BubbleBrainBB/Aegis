import assert from 'node:assert/strict';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { StreamMessage } from '../../src/ui/types';
import { extractDeliveredMedia, renderDeliverAssets } from '../../src/ui/utils/deliver-assets';
import { extractGeneratedMediaFromMessages } from '../../src/ui/utils/generated-media';

const none = () => false;
const all = () => true;

// A real `mcode acp` answer: the PNG is declared type="file".
const acpAnswer = `完成。目录最终状态：\`README.md\`、\`notes.md\`、\`out/red.png\`。

<deliver-assets>
<media type="file" src="/private/tmp/ws/out/red.png" name="red.png" caption="100x100 纯红 PNG" />
<media type="file" src="/private/tmp/ws/notes.md" name="notes.md" caption="生成记录" />
</deliver-assets>`;

assert.deepEqual(extractDeliveredMedia(acpAnswer), [{ path: '/private/tmp/ws/out/red.png', kind: 'image' }]);
assert.equal(
  renderDeliverAssets(acpAnswer, all),
  '完成。目录最终状态：`README.md`、`notes.md`、`out/red.png`。\n\n- [notes.md](</private/tmp/ws/notes.md>) — 生成记录'
);
// Outside the gallery the image stays reachable as a link.
assert.match(renderDeliverAssets(acpAnswer, none), /- \[red\.png\]\(<\/private\/tmp\/ws\/out\/red\.png>\) — 100x100 纯红 PNG/);

// A `mcode exec` answer: typed images with spaces and CJK in the path.
const execAnswer = `| 图片 | 颜色 |
| --- | --- |
| 授权卡片 | 蓝 |

<deliver-assets>
<media type="image" src="/Users/me/out/E2E 截图/1-授权卡片.png" name="1-授权卡片.png" />
<media type="file" src="/Users/me/ws/report.md" name="report.md" />
</deliver-assets>`;
assert.deepEqual(extractDeliveredMedia(execAnswer), [{ path: '/Users/me/out/E2E 截图/1-授权卡片.png', kind: 'image' }]);
const rendered = renderDeliverAssets(execAnswer, none);
assert.ok(!rendered.includes('<media') && !rendered.includes('deliver-assets'));
const nodes: Array<{ type: string; url: string }> = [];
visit(unified().use(remarkParse).parse(rendered), ['image', 'link'], (node) => {
  nodes.push({ type: node.type, url: (node as unknown as { url: string }).url });
});
assert.deepEqual(nodes, [
  { type: 'image', url: '/Users/me/out/E2E 截图/1-授权卡片.png' },
  { type: 'link', url: '/Users/me/ws/report.md' },
]);

// Attributes: entities, single quotes, the underscore tag, deleted files, labels with brackets.
assert.equal(
  renderDeliverAssets(`<deliver_assets>
<media src='/a/[draft] notes.md' caption="&quot;v2&quot; &amp; more" />
<media src="/a/old.txt" deleted="true" />
</deliver_assets>`, none),
  '- [\\[draft\\] notes.md](</a/[draft] notes.md>) — "v2" & more\n- ~~old.txt~~ (deleted)'
);
// Remote and deleted media never join the gallery.
assert.deepEqual(extractDeliveredMedia(`<deliver-assets>
<media src="https://cdn.example.com/a.png" />
<media src="/a/b.png" deleted="true" />
<media src="C:\\out\\c.mp4" />
</deliver-assets>`), [{ path: 'C:\\out\\c.mp4', kind: 'video' }]);

// Talking about the format is not a delivery: fenced code and mid-line tags stay as written.
const docs = 'Wrap files like `<deliver-assets>…</deliver-assets>`:\n\n```xml\n<deliver-assets>\n<media src="/x.png" />\n</deliver-assets>\n```';
assert.equal(renderDeliverAssets(docs, all), docs);
assert.deepEqual(extractDeliveredMedia(docs), []);
// Blank lines inside code are content and survive a delivery elsewhere in the answer.
const spaced = '```\na\n\n\n\nb\n```\n\n<deliver-assets>\n<media src="/a/n.md" />\n</deliver-assets>';
assert.equal(renderDeliverAssets(spaced, none), '```\na\n\n\n\nb\n```\n\n- [n.md](</a/n.md>)');

// While streaming, an unclosed block or a half-typed tag is hidden.
assert.equal(renderDeliverAssets('Done.\n\n<deliver-assets>\n<media src="/a/b.p', none), 'Done.');
assert.equal(renderDeliverAssets('Done.\n\n<deliver-a', none), 'Done.');
assert.equal(renderDeliverAssets('a < b', none), 'a < b');
assert.equal(renderDeliverAssets('Plain answer.', none), 'Plain answer.');

// The turn gallery picks delivered media up from the answer text.
const messages = [
  { type: 'assistant', message: { content: [{ type: 'text', text: acpAnswer }] } },
] as StreamMessage[];
assert.deepEqual(extractGeneratedMediaFromMessages(messages), [{ path: '/private/tmp/ws/out/red.png', kind: 'image' }]);

console.log('deliver-assets tests passed');

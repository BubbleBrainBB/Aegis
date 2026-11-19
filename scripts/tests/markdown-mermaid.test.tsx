// Chat markdown: a ```mermaid fence is marked once its closing fence is there,
// which is what lets it be drawn; a fence still being written stays source.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { markdownRemarkPlugins } from '../../src/ui/utils/markdown-math';
import {
  isClosedFence,
  isMermaidLanguage,
  mermaidSanitizeSchema,
  remarkMermaidFences,
} from '../../src/ui/utils/mermaid-fence';
import { mermaidThemeVariables, mixRgb, type MermaidPalette } from '../../src/ui/utils/mermaid-theme';

const plugins = [...markdownRemarkPlugins, remarkMermaidFences];
const render = (content: string, html = false) => renderToStaticMarkup(
  <ReactMarkdown
    remarkPlugins={plugins}
    rehypePlugins={html ? [rehypeRaw, [rehypeSanitize, mermaidSanitizeSchema]] : []}
  >
    {content}
  </ReactMarkdown>,
);
const CLOSED = 'data-mermaid-fence="closed"';
const closed = (content: string, html = false) => {
  const out = render(content, html);
  assert.match(out, /class="language-mermaid"/i, `a mermaid fence in: ${content}\n${out}`);
  assert.ok(out.includes(CLOSED), `closed: ${content}\n${out}`);
};
const open = (content: string) => {
  const out = render(content);
  assert.ok(!out.includes(CLOSED), `not closed: ${content}\n${out}`);
};

// The diagram a user reported as plain text.
const flowchart = [
  'flowchart TD',
  '  A[用户提问] --> B{需要工具?}',
  '  subgraph 检索阶段',
  '    B -->|是 / 相似度 ≥ 0.8| C[向量检索<br/>Top-K → 重排]',
  '  end',
  '  B -->|否| D[直接回答]',
].join('\n');

closed(`\`\`\`mermaid\n${flowchart}\n\`\`\``);
closed(`Before.\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n\nAfter.`);
closed(`~~~mermaid\n${flowchart}\n~~~`);
closed(`\`\`\`\`mermaid\n${flowchart}\n\`\`\`\`\``);
closed(`\`\`\`Mermaid\n${flowchart}\n\`\`\`  `);
closed(`  \`\`\`mermaid\n  ${flowchart}\n  \`\`\``);
closed(`- Step:\n\n  \`\`\`mermaid\n  flowchart TD\n    A --> B\n  \`\`\``);
closed(`> \`\`\`mermaid\n> flowchart TD\n>   A --> B\n> \`\`\``);
closed('```mermaid\n```');
// Markdown with HTML is sanitized, which must not drop the mark.
closed(`<details>\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n\n</details>`, true);

// Every state an answer passes through while the fence is being written.
const whole = `Here it is:\n\n\`\`\`mermaid\n${flowchart}\n\`\`\``;
for (let length = whole.indexOf('```mermaid') + '```mermaid'.length; length < whole.length; length += 1) {
  open(whole.slice(0, length));
}
open('```mermaid');
open('```mermaid\nflowchart TD\n  A --> B\n``');
open('```mermaid\nflowchart TD\n  A --> B\n~~~');
open('````mermaid\nflowchart TD\n  A --> B\n```');
open('- Step:\n\n  ```mermaid\n  flowchart TD\n    A --> B');

// Other languages are never marked, and the text of the diagram is kept as written.
assert.ok(!render('```ts\nconst a = 1;\n```').includes('data-mermaid-fence'));
assert.ok(!render('```\nflowchart TD\n```').includes('data-mermaid-fence'));
const kept = render(`\`\`\`mermaid\n${flowchart}\n\`\`\``);
assert.ok(kept.includes('C[向量检索&lt;br/&gt;Top-K → 重排]'), kept);
assert.ok(kept.includes('subgraph 检索阶段'), kept);
assert.ok(kept.includes('是 / 相似度 ≥ 0.8'), kept);

assert.equal(isClosedFence('```mermaid\nA\n```'), true);
assert.equal(isClosedFence('```mermaid\nA\n```\n'), false, 'the node ends at its fence');
assert.equal(isClosedFence('```mermaid'), false);
assert.equal(isMermaidLanguage('mermaid'), true);
assert.equal(isMermaidLanguage('MERMAID'), true);
assert.equal(isMermaidLanguage('mermaidx'), false);
assert.equal(isMermaidLanguage(undefined), false);

// Mermaid's color math reads hex only: no CSS variables, no color-mix().
const palette = (dark: boolean): MermaidPalette => ({
  dark,
  surface: dark ? [24, 24, 27] : [252, 252, 252],
  ink: dark ? [244, 244, 245] : [26, 26, 26],
  subdued: dark ? [161, 161, 170] : [82, 82, 82],
  accent: [79, 70, 229],
  success: [22, 163, 74],
  warning: [217, 119, 6],
  error: [220, 38, 38],
  fontFamily: 'Inter, sans-serif',
});
for (const dark of [false, true]) {
  const variables = mermaidThemeVariables(palette(dark));
  assert.equal(variables.darkMode, dark);
  assert.equal(variables.fontFamily, 'Inter, sans-serif');
  for (const [name, value] of Object.entries(variables)) {
    if (['darkMode', 'fontFamily', 'fontSize'].includes(name)) continue;
    assert.match(String(value), /^#[0-9a-f]{6}$/, `${name} is a hex color`);
  }
  assert.equal(variables.primaryColor, dark ? '#18181b' : '#fcfcfc');
  assert.equal(variables.primaryTextColor, dark ? '#f4f4f5' : '#1a1a1a');
  assert.notEqual(variables.primaryColor, variables.clusterBkg);
  assert.notEqual(variables.lineColor, variables.primaryColor);
}
assert.notEqual(
  JSON.stringify(mermaidThemeVariables(palette(false))),
  JSON.stringify(mermaidThemeVariables(palette(true))),
  'a theme change redraws',
);
assert.deepEqual(mixRgb([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
assert.deepEqual(mixRgb([10, 20, 30], [200, 100, 50], 0), [200, 100, 50]);

console.log('markdown mermaid checks passed');

// The Markdown outline lists real headings only: not frontmatter, and not a
// `# comment` inside a fenced code block (``` or ~~~, any length, indented up
// to three spaces), so the outline's ticks line up with the document.
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { collectOutlineItemsFromDoc } from '../../src/ui/components/markdown-outline';

const titles = (doc: string) => collectOutlineItemsFromDoc(EditorState.create({ doc })).map((item) => `${item.level}:${item.text}`);

assert.deepEqual(
  titles(['---', 'title: x', '# not a heading', '---', '# Top', '', '## **Bold** [link](u)'].join('\n')),
  ['1:Top', '2:Bold link'],
  'frontmatter is skipped and inline markup stripped'
);

assert.deepEqual(
  titles([
    '# One',
    '```bash',
    '# install deps',
    'npm install',
    '```',
    '## Two',
    '~~~~python',
    '# comment',
    '~~~',
    '# still code: a shorter fence does not close it',
    '~~~~',
    '### Three',
    '   ```',
    '# indented fence',
    '   ```',
    '#### Four',
  ].join('\n')),
  ['1:One', '2:Two', '3:Three', '4:Four'],
  'fenced code blocks are not headings'
);

assert.deepEqual(
  titles(['# A', '```', '# never closed', '## inside'].join('\n')),
  ['1:A'],
  'an unclosed fence runs to the end of the document'
);

assert.deepEqual(
  titles(['``` not `a fence`', '# Real'].join('\n')),
  ['1:Real'],
  'a backtick in the info string means it is not a fence'
);

console.log('markdown-outline: headings only, frontmatter and fenced code skipped');

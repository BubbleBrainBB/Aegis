import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { getProjectFileLink, isLocalFileUrl } from '../../src/ui/utils/markdown-file-links';

/**
 * The href each anchor receives when react-markdown renders `markdown` with
 * MDContent's URL transform. It percent-encodes first: C:\a reaches the
 * transform as C:%5Ca.
 */
function hrefs(markdown: string): string[] {
  const urls: string[] = [];
  renderToStaticMarkup(createElement(ReactMarkdown, {
    urlTransform: (url: string) => (isLocalFileUrl(url) ? url : defaultUrlTransform(url)),
    components: { a: ({ href }: { href?: string }) => (urls.push(href ?? ''), null) },
  }, markdown));
  return urls;
}

const mac = ['/Users/me/coworker', '/Users/me/main'];
const win = ['C:\\Users\\me\\proj'];

// macOS and Linux links keep resolving as before.
assert.deepEqual(getProjectFileLink('src/App.tsx:12', mac), { path: 'src/App.tsx', line: 12 });
assert.deepEqual(getProjectFileLink('/Users/me/coworker/src/App.tsx', mac), { path: 'src/App.tsx', line: undefined });
assert.deepEqual(getProjectFileLink('/Users/me/main/README.md', mac), { path: 'README.md', line: undefined });
assert.deepEqual(
  getProjectFileLink('/Users/me/Desktop/E2E 截图/1.png', mac),
  { path: '/Users/me/Desktop/E2E 截图/1.png', line: undefined, external: true }
);
assert.equal(getProjectFileLink('/Users/me/coworker', mac), null);
assert.equal(getProjectFileLink('/pricing', mac), null);
assert.equal(getProjectFileLink('https://example.com/a.png', mac), null);
assert.equal(getProjectFileLink('aegis://session/abc', mac), null);

// The drive letter is not a URL scheme: each Windows spelling survives the URL
// transform and opens, whether inside the project or outside it.
const answer = [
  '[a](C:\\Users\\me\\proj\\src\\App.tsx:7)',
  '[b](<C:\\Users\\me\\Desktop\\E2E 截图\\1-授权卡片.png>)',
  '[c](c:/users/me/proj/README.md)',
  '[d](file:///C:/Users/me/Desktop/d.png)',
  '[e](D:/work/report.md)',
].join(' ');
const links = hrefs(answer).map((href) => getProjectFileLink(href, win));
assert.deepEqual(links, [
  { path: 'src/App.tsx', line: 7 },
  { path: 'C:/Users/me/Desktop/E2E 截图/1-授权卡片.png', line: undefined, external: true },
  { path: 'README.md', line: undefined },
  { path: 'C:/Users/me/Desktop/d.png', line: undefined, external: true },
  { path: 'D:/work/report.md', line: undefined, external: true },
]);

// Only local file targets bypass the default transform.
assert.equal(isLocalFileUrl('C:\\a.png'), true);
assert.equal(isLocalFileUrl('file:///Users/me/a.png'), true);
assert.equal(isLocalFileUrl('javascript:alert(1)'), false);
assert.equal(isLocalFileUrl('vbscript:x'), false);
assert.deepEqual(hrefs('[x](javascript:alert(1)) [y](https://a.dev)'), ['', 'https://a.dev']);

console.log('markdown-file-links tests passed');

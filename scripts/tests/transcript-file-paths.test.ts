import assert from 'node:assert/strict';
import { collectTranscriptFileCandidates, resolveTranscriptFileReference } from '../../src/ui/utils/transcript-file-paths';
import type { StreamMessage } from '../../src/ui/types';

// A bare name no workspace holds is found through what the transcript says.
const said = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as StreamMessage;
const read = (file_path: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path } }] } }) as unknown as StreamMessage;
const output = (content: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } }) as unknown as StreamMessage;
const disk = (paths: string[]) => async (cwd: string, relative: string) => {
  const path = `${cwd}/${relative}`;
  return paths.includes(path) ? path : null;
};
const transcript = (messages: StreamMessage[], requestedPath: string, paths: string[]) =>
  resolveTranscriptFileReference({ requestedPath, messages, statFile: disk(paths) });

async function main() {
  assert.deepEqual(
    await transcript([read('/tmp/qa/after/shot.png')], 'shot.png', ['/tmp/qa/after/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/after', path: '/tmp/qa/after/shot.png' },
    'a file the agent read'
  );
  assert.deepEqual(
    await transcript([said('截图在 `/tmp/qa/after/`，`shot.png` 是悬停菜单。')], 'shot.png', ['/tmp/qa/after/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/after', path: '/tmp/qa/after/shot.png' },
    'a folder named in the answer, with Chinese punctuation around it'
  );
  assert.deepEqual(
    await transcript([read('/tmp/qa/after/other.png')], 'shot.png', ['/tmp/qa/after/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/after', path: '/tmp/qa/after/shot.png' },
    'beside a file the agent read'
  );
  assert.deepEqual(
    await transcript([read('/Users/me/Library/Application Support/x/a b.png')], 'a b.png', ['/Users/me/Library/Application Support/x/a b.png']),
    { status: 'resolved', cwd: '/Users/me/Library/Application Support/x', path: '/Users/me/Library/Application Support/x/a b.png' },
    'a tool input path with spaces'
  );
  assert.deepEqual(
    await transcript([said('/tmp/qa/after/ holds the screenshots')], 'shot.png', ['/tmp/qa/after/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/after', path: '/tmp/qa/after/shot.png' },
    'one line of text that starts with a path is not a path with spaces'
  );
  assert.deepEqual(
    await transcript([read('/opt/bin/python3 gen.py --out /tmp/qa/out/shot.png')], 'shot.png', ['/tmp/qa/out/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/out', path: '/tmp/qa/out/shot.png' },
    'a command that starts with a path still names the others'
  );
  assert.deepEqual(
    await transcript([output('/tmp/qa/deep/shot.png:12:matched')], 'shot.png', ['/tmp/qa/deep/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/deep', path: '/tmp/qa/deep/shot.png' },
    'grep-style output'
  );
  assert.deepEqual(
    collectTranscriptFileCandidates([said('see https://github.com/a/b for it')], 'shot.png').directories,
    [],
    'a URL names no folder'
  );
  assert.deepEqual(
    await transcript([output('wrote /tmp/qa/deep/shot.png')], 'shot.png', ['/tmp/qa/deep/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/deep', path: '/tmp/qa/deep/shot.png' },
    'a full path in tool output'
  );
  assert.deepEqual(
    await transcript([output('wrote /tmp/qa/deep/other.png')], 'shot.png', ['/tmp/qa/deep/shot.png']),
    { status: 'not-found' },
    'the folders of tool output are not hints'
  );
  assert.deepEqual(
    await transcript([read('/tmp/qa/gone/shot.png')], 'shot.png', []),
    { status: 'not-found' },
    'a named file that no longer exists stays not found'
  );
  assert.deepEqual(
    await transcript([said('in /tmp/qa/guess/'), read('/tmp/qa/named/shot.png')], 'shot.png', ['/tmp/qa/guess/shot.png', '/tmp/qa/named/shot.png']),
    { status: 'resolved', cwd: '/tmp/qa/named', path: '/tmp/qa/named/shot.png' },
    'a file named in full beats a folder guess'
  );
  const twoFiles = await transcript([read('/tmp/a/shot.png'), read('/tmp/b/shot.png')], 'shot.png', ['/tmp/a/shot.png', '/tmp/b/shot.png']);
  assert.equal(twoFiles.status, 'ambiguous', 'two real files with one name ask the user');
  assert.deepEqual(
    collectTranscriptFileCandidates([read('/tmp/old/shot.png'), read('/tmp/new/shot.png')], 'shot.png').files,
    ['/tmp/new/shot.png', '/tmp/old/shot.png'],
    'newest first'
  );

  console.log('transcript-file-paths tests passed');
}

void main();

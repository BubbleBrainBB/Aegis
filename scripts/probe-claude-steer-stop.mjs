#!/usr/bin/env node
// Live probe (needs a signed-in Claude Code; spends a few cents on haiku):
// drives the real Claude Agent SDK and feeds its frames to the runner's
// ClaudePromptLifecycle, checking the frame contract steer + Stop rely on.
// Run after `npm run transpile:electron`:  node scripts/probe-claude-steer-stop.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClaudePromptLifecycle } = require('../dist-electron/electron/libs/claude-prompt-lifecycle.js');
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const cwd = mkdtempSync(path.join(tmpdir(), 'aegis-steer-probe-'));

function session() {
  let wake;
  const buffer = [];
  const input = {
    [Symbol.asyncIterator]() {
      return { next: () => buffer.length ? Promise.resolve({ value: buffer.shift(), done: false })
        : new Promise((resolve) => { wake = (value) => resolve({ value, done: false }); }) };
    },
  };
  const q = query({ prompt: input, options: { model: 'haiku', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, cwd } });
  const lifecycle = new ClaudePromptLifecycle();
  const names = new Map();
  const log = [];
  const send = (tag, text) => {
    const uuid = randomUUID();
    names.set(uuid, tag);
    lifecycle.sent(uuid, true);
    const message = { type: 'user', uuid, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
    if (wake) { const w = wake; wake = undefined; w(message); } else buffer.push(message);
    return uuid;
  };
  const name = (uuid) => names.get(uuid) ?? uuid;
  return { q, lifecycle, send, name, log };
}

async function run(label, s, onMessage, done) {
  for await (const message of s.q) {
    const frame = s.lifecycle.observe(message);
    if (frame.withdrawn) s.log.push(`withdrawn ${s.name(frame.withdrawn)}`);
    if (frame.opened) s.log.push(`opened ${s.name(frame.opened)}`);
    if (frame.joined) s.log.push(`joined ${s.name(frame.joined.promptId)}<${s.name(frame.joined.openerId)}`);
    if (frame.interrupt) s.log.push('interrupt');
    if (message.type === 'result' && !message.parent_tool_use_id) s.log.push(`result ${(message.user_message_uuids ?? []).map(s.name).join('+')}`);
    await onMessage(message);
    if (done()) break;
  }
  s.q.close?.();
  console.log(`${label}: ${s.log.join(' | ')}`);
  return s.log;
}

// 1. Stop with a steer queued behind the running turn, then a follow-up.
{
  const s = session();
  s.send('A', 'Use the Bash tool to run exactly: sleep 10 && echo A. Then reply in one sentence.');
  let stopped = false;
  let results = 0;
  const log = await run('stop', s, async (message) => {
    if (!stopped && message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use')) {
      stopped = true;
      s.send('B', 'Steer: end with BANANA.');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (const uuid of s.lifecycle.beginStop()) void s.q.cancelAsyncMessage(uuid);
      const receipt = await s.q.interrupt();
      if (s.lifecycle.stopReceipt(receipt?.still_queued)) s.log.push('interrupt (receipt)');
      s.send('C', 'Reply with just: C-AFTER-STOP');
    }
    if (message.type === 'result' && !message.parent_tool_use_id) results += 1;
  }, () => results >= 2);
  assert(log.indexOf('withdrawn B') >= 0 && log.indexOf('withdrawn B') < log.indexOf('result A'), 'B withdrawn in stream order, before A\'s result');
  assert(log.includes('opened C') && log.includes('result C'), 'the follow-up ran');
  assert(!log.includes('interrupt') && !log.includes('interrupt (receipt)'), 'nothing left for a second interrupt');
}

// 2. Two prompts queued behind a turn: the CLI takes them as one batch.
{
  const s = session();
  s.send('A', 'Without using tools, write about 300 words on tides.');
  setTimeout(() => { s.send('B', 'Late B: say BEE.'); s.send('C', 'Late C: say SEA.'); }, 2500);
  let results = 0;
  const log = await run('batch', s, async (message) => {
    if (message.type === 'result' && !message.parent_tool_use_id) results += 1;
  }, () => results >= 2);
  assert.deepEqual(log.filter((e) => /^(opened|joined)/.test(e)), ['opened A', 'opened B', 'joined C<B']);
}

// 3. A steer sent while a tool runs folds into the turn: no turn of its own.
{
  const s = session();
  s.send('A', 'Use the Bash tool to run exactly: sleep 8 && echo A. Then run: sleep 2 && echo again. Then reply in one sentence.');
  let sent = false;
  let results = 0;
  const log = await run('fold', s, async (message) => {
    if (!sent && message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use')) {
      sent = true;
      s.send('B', 'Also end your reply with KIWI.');
    }
    if (message.type === 'result' && !message.parent_tool_use_id) results += 1;
  }, () => results >= 1);
  assert.deepEqual(log.filter((e) => /^(opened|joined)/.test(e)), ['opened A'], 'the steer never opens a turn');
  assert(log.includes('result A+B'), 'one result answers both');
}

console.log('probe-claude-steer-stop: frame contract holds');
process.exit(0);

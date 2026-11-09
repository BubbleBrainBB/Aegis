import assert from 'node:assert/strict';
import { generateTaskTitle } from '../../src/electron/libs/session-title-generator';
import { discardAcpSession } from '../../src/electron/libs/provider/acp-session-discard';

const request = '发现一个问题。为什么改动卡片不显示了';
const never = () => new Promise<string>(() => {});

void (async () => {
  // The live session names it: no conversation of its own is started.
  let oneShots = 0;
  assert.equal(
    await generateTaskTitle({ request, live: async () => '改动卡片丢失', oneShot: async () => { oneShots++; return ''; } }),
    '改动卡片丢失'
  );
  assert.equal(oneShots, 0);

  // A live session that cannot: the agent is asked once, and only the title is kept.
  let asked = '';
  assert.equal(
    await generateTaskTitle({
      request,
      live: async () => { throw new Error('Unsupported control request'); },
      oneShot: async (prompt) => { asked = prompt; return '<reasoning_effort>15</reasoning_effort>\n<title>改动卡片丢失</title>'; },
    }),
    '改动卡片丢失'
  );
  assert.ok(asked.includes(request), 'the request goes to the agent');

  // No live session at all.
  assert.equal(await generateTaskTitle({ request, oneShot: async () => 'Change card missing' }), 'Change card missing');

  // Failure, nothing usable, or too slow: the first sentence names it, and the one-shot is ended.
  assert.equal(await generateTaskTitle({ request, oneShot: async () => { throw new Error('offline'); } }), '发现一个问题');
  assert.equal(await generateTaskTitle({ request, oneShot: async () => '<title></title>' }), '发现一个问题');
  let signal: AbortSignal | undefined;
  const started = Date.now();
  assert.equal(
    await generateTaskTitle({ request, timeoutMs: 50, oneShot: (_prompt, s) => { signal = s; return never(); } }),
    '发现一个问题'
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal?.aborted, true, 'a late one-shot is stopped');
  assert.equal(await generateTaskTitle({ request: '  ', oneShot: async () => 'x' }), '', 'nothing to name');
  // A throwaway ACP session leaves the agent's history by the first way it accepts.
  const calls: string[] = [];
  const rpc = (accepts: string[]) => ({
    request: async (method: string, params?: Record<string, unknown>) => {
      calls.push(`${method} ${params?.sessionId}`);
      if (!accepts.includes(method)) throw new Error('Method not found');
      return {};
    },
  });
  assert.equal(await discardAcpSession(rpc(['x.ai/session/delete']), 's1', ['session/delete', 'x.ai/session/delete']), true);
  assert.deepEqual(calls, ['session/delete s1', 'x.ai/session/delete s1']);
  assert.equal(await discardAcpSession(rpc([]), 's2'), false, 'an agent that cannot delete keeps it');
  assert.equal(await discardAcpSession(rpc(['session/delete']), ''), false, 'no session, nothing to send');
  console.log('session-title-generator tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

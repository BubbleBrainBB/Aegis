// Optional paid acceptance test against the two synthetic document windows.
// The ordinary gateway and adapter are used. Only this fixture can be observed or edited.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyProviderTurn({ kind, gateway, app, first, second, cwd, lib }) {
  const providerClasses = {
    bubble: ['bubble-sdk', 'BubbleSdkAdapter'],
    deepseek: ['deepseek-sdk', 'DeepseekSdkAdapter'],
    pi: ['pi-sdk', 'PiSdkAdapter'],
    opencode: ['opencode-sdk', 'OpenCodeSdkAdapter'],
    qoder: ['qoder-sdk', 'QoderSdkAdapter'],
    devin: ['devin-acp', 'DevinAcpAdapter'],
    grok: ['grok-acp', 'GrokAcpAdapter'],
    mimo: ['mimo-acp', 'MimoAcpAdapter'],
    minimax: ['minimax-acp', 'MinimaxAcpAdapter'],
  };
  const threadId = randomUUID();
  const original = gateway.call.bind(gateway);
  const observed = [];
  const attempts = [];
  gateway.call = async (call) => {
    const { tool, args } = call;
    attempts.push(tool);
    if (
      call.sessionId !== threadId ||
      args.app !== app ||
      !['list_windows', 'get_app_state', 'set_value', 'verify_state'].includes(tool) ||
      (tool !== 'list_windows' && args.window_id !== second) ||
      (tool === 'set_value' && args.value !== 'accepted')
    ) {
      return { text: 'Use the exact test app and second window only.', images: [], isError: true };
    }
    const result = await original(call);
    if (!result.isError && (tool !== 'verify_state' || JSON.parse(result.text).status === 'satisfied')) {
      observed.push(tool);
    }
    return result;
  };
  const prompt =
    'Use only the aegis-computer-use tools for this isolated macOS test. App is "' +
    app +
    '". ' +
    'Read exact window_id ' +
    second +
    ' with get_app_state (include_screenshot false). Set its Document value field to "accepted" using set_value, then use verify_state with role AXTextField and value_equals "accepted". Supply app and window_id on every call. End once verified.';
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 120000);
  let adapter, entry;
  try {
    if (kind === 'claude') {
      const { getComputerUseMcpBridge } = lib('computer-use');
      entry = await getComputerUseMcpBridge().bindSession(threadId, { images: 'inline' });
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      for await (const msg of query({
        prompt,
        options: {
          cwd,
          model: 'haiku',
          tools: [],
          maxTurns: 9,
          abortController: abort,
          mcpServers: { 'aegis-computer-use': { type: 'http', url: entry.url, headers: entry.headers } },
          allowedTools: ['mcp__aegis-computer-use__*'],
        },
      })) {
        if (msg.type === 'result' && msg.is_error) throw Error(msg.result || msg.subtype);
      }
    } else {
      const [file, name] = providerClasses[kind];
      adapter = new (lib('provider/' + file + '-adapter.js')[name])();
      const done = new Promise((resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(Error('model turn timed out')), { once: true });
        adapter.events.on('event', (event) => {
          if (event.type === 'message' && event.message.type === 'assistant') {
            for (const block of event.message.message?.content || []) {
              if (block.type === 'tool_use') attempts.push(block.name);
            }
          }
          if (event.type === 'error') reject(Error(event.error?.message || 'provider error'));
          if (event.type === 'permission_request')
            void adapter.respondToRequest(threadId, event.requestId, {
              behavior: 'deny',
              message: 'Only the fixture gateway approves this test.',
            });
          if (event.type === 'message' && event.message.type === 'result') {
            if (event.message.subtype === 'success') resolve();
            else
              queueMicrotask(() =>
                reject(Error(event.message.result || 'Model turn ended with ' + event.message.subtype)),
              );
          }
        });
      });
      const toolHint =
        kind === 'opencode'
          ? ' Call the plain MCP tools mcp__aegis-computer-use__get_app_state, mcp__aegis-computer-use__set_value and mcp__aegis-computer-use__verify_state directly.'
          : '';
      await Promise.all([
        done,
        adapter.startSession({
          provider: kind,
          threadId,
          cwd,
          prompt: prompt + toolHint,
          model: process.env.LIVE_MODEL || undefined,
        }),
      ]);
    }
    for (const tool of ['get_app_state', 'set_value', 'verify_state']) {
      assert.ok(
        observed.includes(tool),
        'Missing ' +
          tool +
          ' in successful model calls: ' +
          observed.join(', ') +
          ' (attempted: ' +
          attempts.join(', ') +
          ')',
      );
    }
    gateway.finishTurn(threadId);
    for (const [window_id, expected] of [
      [first, 'original-0'],
      [second, 'accepted'],
    ]) {
      const call = (tool, args) =>
        original({ sessionId: 'check', toolUseId: randomUUID(), tool, args: { app, window_id, ...args } });
      assert.equal((await call('get_app_state', { include_screenshot: false })).isError, false);
      const result = await call('verify_state', { role: 'AXTextField', value_equals: expected });
      assert.equal(JSON.parse(result.text).status, 'satisfied', result.text);
    }
    console.log(kind + ': real model and driver verified ' + observed.join(', '));
  } finally {
    clearTimeout(timeout);
    gateway.call = original;
    entry?.dispose();
    await adapter?.stopSession(threadId).catch(() => {});
    await adapter?.stopAll?.().catch(() => {});
  }
}

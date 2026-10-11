// The SDK JSON-RPC wire carries only durable session events, so a step's text
// and reasoning would reach Aegis only once the step commits. The agent loop
// already publishes every model chunk in-process as `agent/assistant-stream`
// (the Harness Web and headless hosts render from it); forward the visible
// deltas as one Aegis notification on the same transport.

export const ASSISTANT_STREAM_METHOD = 'aegis.assistant.stream';

const PATCH_MARKER = Symbol.for('aegis.deepseek-sdk-jsonrpc-server.stream-shim');
const FORWARDED_CHUNKS = new Set(['text-delta', 'reasoning-delta']);
/** Aegis draws show_widget calls while they are written; other tool calls'
 * arguments (whole files for an edit) stay off the wire. Keyed session:call. */
const WIDGET_TOOL = /(^|[_./:-])show_widget$/i;
const widgetCalls = new Set();

/**
 * Map one live frame to its wire payload, or undefined when nothing visible
 * changed. Usage chunks and other tools' argument chunks stay off the wire:
 * the committed assistant/message and tool/call events carry them exactly once.
 */
export function assistantStreamNotification(agent, frame) {
  const sessionId = String(agent.session.id);
  const base = { sessionId, attemptId: String(frame.attemptId) };
  if (frame.type === 'chunk') {
    const { chunk } = frame;
    if (chunk.type === 'tool-call-delta') {
      const key = `${sessionId}:${chunk.id}`;
      if (typeof chunk.name === 'string' && WIDGET_TOOL.test(chunk.name)) widgetCalls.add(key);
      if (!widgetCalls.has(key)) return undefined;
      return { ...base, type: 'chunk', chunk: { type: 'tool-call-delta', id: String(chunk.id), name: chunk.name, argumentsDelta: String(chunk.argumentsDelta ?? '') } };
    }
    if (!FORWARDED_CHUNKS.has(chunk.type) || typeof chunk.text !== 'string' || chunk.text === '') return undefined;
    return { ...base, type: 'chunk', chunk: { type: chunk.type, text: chunk.text } };
  }
  if (frame.type === 'end') {
    for (const key of widgetCalls) if (key.startsWith(`${sessionId}:`)) widgetCalls.delete(key);
    return { ...base, type: 'end', outcome: frame.outcome.kind };
  }
  return { ...base, type: 'start' };
}

/** Patch the exported JSON-RPC server class before Cordis boots its plugin. */
export function installDeepseekSdkStreamShim({ HarnessSdkJsonRpcServer }) {
  const prototype = HarnessSdkJsonRpcServer.prototype;
  if (prototype[PATCH_MARKER]) return;
  Object.defineProperty(prototype, PATCH_MARKER, { value: true });

  // Listen once per server, from its first session onward: no model request
  // can run before a session exists. Server disposal releases the listener.
  const listening = new WeakSet();
  const createSession = prototype.createSession;
  prototype.createSession = function createSessionWithAssistantStream(sessionId) {
    if (!listening.has(this)) {
      listening.add(this);
      this.disposers.push(this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        const payload = assistantStreamNotification(agent, frame);
        if (payload) this.transport.notify(ASSISTANT_STREAM_METHOD, payload);
      }, { global: true }));
    }
    return createSession.call(this, sessionId);
  };
}

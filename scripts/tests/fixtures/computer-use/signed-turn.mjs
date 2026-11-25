// Real packaged main process, preload IPC and Claude runner. Only authorize writes to the test field.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySignedTurn({ executable, home, app, second, checkDocuments, provider = 'claude' }) {
  assert.ok(['claude', 'opencode'].includes(provider));
  const model = provider === 'opencode' ? process.env.LIVE_MODEL || 'deepseek/deepseek-flash' : 'haiku';
  const profile = path.join(home, 'signed-profile');
  const cwd = path.join(home, 'project');
  await mkdir(cwd);
  const env = {
    ...process.env,
    AEGIS_USER_DATA_DIR: profile,
    AEGIS_COMPUTER_USE_SETTINGS_PATH: path.join(home, 'signed-settings.json'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AEGIS_COMPUTER_USE_ENABLED;
  const proc = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(proc, 'exit');
  let debugPort;
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (data) => {
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(data);
    if (match) debugPort = Number(match[1]);
  });
  let socket;
  const wait = async (label, check, timeout = 90000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end && proc.exitCode === null && proc.signalCode === null) {
      const result = await check();
      if (result) return result;
      await delay(200);
    }
    throw Error('Timed out waiting for ' + label + ' (app exit ' + proc.exitCode + ')');
  };
  try {
    const port = await wait('QA debugging port', async () => {
      if (debugPort) return debugPort;
      const data = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      return Number(data.split('\n')[0]);
    });
    const page = await wait('packaged renderer', async () => {
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return pages.find((p) => p.type === 'page' && p.url.includes('app.asar/dist-react/'));
    });
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let seq = 0;
    const evaluate = (expression) => {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const receive = (e) => {
          const response = JSON.parse(e.data);
          if (response.id !== id) return;
          clearTimeout(deadline);
          socket.removeEventListener('message', receive);
          const error = response.error || response.result?.exceptionDetails;
          if (error) reject(Error(error.exception?.description || error.message || error.text));
          else resolve(response.result.result.value);
        };
        const deadline = setTimeout(() => {
          socket.removeEventListener('message', receive);
          reject(Error('Packaged renderer did not respond'));
        }, 30000);
        socket.addEventListener('message', receive);
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      });
    };
    const send = (type, payload) =>
      evaluate('window.electron.sendClientEvent(' + JSON.stringify({ type, payload }) + ')');
    const status = await wait('bundled driver', () => evaluate('window.electron?.getComputerUseSettings()'));
    assert.equal(status.driver.source, 'bundled');
    assert.equal(status.driver.state, 'ready', status.driver.message);
    assert.equal(status.enabled, false);
    assert.equal((await evaluate('window.electron.setComputerUseEnabled(true)')).enabled, true);
    await evaluate(`window.cuTest = {cards:[], status:{}, errors:[], stopped:[], grants:{}, calls:[], answer:"", gatewayStatus:null};
      window.electron.onServerEvent(({type,payload:p}) => {
        if (type === 'stream.message' && p.message?.type === 'mcp_status') {
          cuTest.gatewayStatus = p.message.servers.find(server => server.name === 'aegis-computer-use')?.status ?? 'missing';
        }
        if (type === 'stream.message' && p.message?.type === 'assistant') {
          for (const block of p.message.message?.content || []) {
            if (block.type === 'tool_use') cuTest.calls.push(block.name);
            if (block.type === 'text') cuTest.answer = block.text.slice(-350);
          }
        }
        if (type === 'permission.request') cuTest.cards.push(p);
        if (type === 'session.status') cuTest.status[p.sessionId] = p.status;
        if (type === 'computerUse.grants') cuTest.grants[p.sessionId] = p.grants;
        if (type === 'computerUse.stopped') cuTest.stopped.push(p.sessionId);
        if (type === 'runner.error') cuTest.errors.push(p.message);
      }); true`);
    const prompt =
      'Call the plain MCP tools mcp__aegis-computer-use__get_app_state and mcp__aegis-computer-use__set_value directly. Read app "' +
      app +
      '", window_id ' +
      second +
      ' with get_app_state using include_screenshot false. Set the Document value field to "accepted" with set_value. Pass app and window_id on both calls. If the tool asks for permission, wait for the decision. If denied or cancelled, end this turn with a short text answer. Only retry when I ask in a later message.';
    let sessionId;
    for (const action of ['disable', 'stop', 'allow', 'after-revoke']) {
      await evaluate('cuTest.cards = []; cuTest.calls = []; cuTest.answer = ""; cuTest.status = {}; true');
      if (!sessionId) {
        await send('session.start', {
          title: 'Computer Use acceptance',
          skipTitleGeneration: true,
          cwd,
          projectCwd: cwd,
          provider,
          model,
          prompt,
          claudeAccessMode: 'default',
          envMode: 'local',
          scope: 'project',
        });
      } else {
        const fieldPrompt =
          action === 'after-revoke' ? prompt.replace('"accepted"', '"after revocation"') : prompt;
        const nextPrompt =
          'I have started a new turn with Computer Use enabled. Please make a new tool call now. The previous turn is complete. ' +
          fieldPrompt;
        await send('session.continue', { sessionId, prompt: nextPrompt, provider, model });
      }
      const card = await wait('set_value approval for ' + action, async () => {
        const state = await evaluate('cuTest');
        if (state.errors.length) throw Error(state.errors.join('\n'));
        if (state.cards.length) return state.cards[0];
        if (Object.values(state.status).includes('completed'))
          throw Error(
            'Model completed without requesting a fixture edit for ' +
              action +
              '. Tools: ' +
              state.calls.join(', ') +
              '. Gateway: ' +
              state.gatewayStatus +
              '. Response: ' +
              state.answer,
          );
      });
      assert.equal(card.input.kind, 'computer-use');
      assert.equal(card.input.toolName, 'set_value');
      assert.equal(card.input.params.app, app);
      assert.equal(card.input.params.window_id, second);
      assert.equal(card.input.params.value, action === 'after-revoke' ? 'after revocation' : 'accepted');
      sessionId ??= card.sessionId;
      assert.equal(card.sessionId, sessionId);
      if (action === 'disable') {
        assert.equal((await evaluate('window.electron.setComputerUseEnabled(false)')).enabled, false);
      } else if (action === 'stop') {
        await evaluate('window.electron.stopComputerUse(' + JSON.stringify(sessionId) + ')');
        await wait('Stop notification', async () => (await evaluate('cuTest.stopped')).includes(sessionId));
      } else {
        await send('permission.response', {
          sessionId,
          toolUseId: card.toolUseId,
          result:
            action === 'allow'
              ? { behavior: 'allow', computerUseGrant: 'until-revoked' }
              : { behavior: 'deny', message: 'End this test turn.' },
        });
      }
      await wait('completed agent turn after ' + action, async () => {
        const state = await evaluate('cuTest');
        if (state.errors.length) throw Error(state.errors.join('\n'));
        return state.status[sessionId] === 'completed';
      });
      await checkDocuments(action === 'allow' || action === 'after-revoke' ? 'accepted' : 'original-1');
      if (action === 'allow') {
        const grant = await wait(
          'fixture grant',
          async () => (await evaluate('cuTest.grants'))[sessionId]?.[0],
        );
        assert.equal(grant.appId, app);
        await send('computerUse.revoke', { sessionId, grantKey: grant.key });
        await wait('grant revocation', async () => (await evaluate('cuTest.grants'))[sessionId]?.length === 0);
      }
      if (action === 'disable') await evaluate('window.electron.setComputerUseEnabled(true)');
      if (action === 'stop') {
        // A second Stop from a still-open preview can arrive after the turn ended.
        await evaluate('window.electron.stopComputerUse(' + JSON.stringify(sessionId) + ')');
      }
      console.log('Packaged ' + provider + ' turn completed after ' + action);
    }
    await evaluate('window.electron.setComputerUseEnabled(false)');
  } finally {
    socket?.close();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    const forceQuit = setTimeout(() => proc.kill('SIGKILL'), 8000);
    try {
      await exited;
    } finally {
      clearTimeout(forceQuit);
    }
  }
}

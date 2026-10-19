// show_widget over Aegis's session MCP server (the HTTP path most providers
// use): listed beside the other session tools, alone when the URL asks for
// `?tools=show_widget` (Kimi's entry), and callable. Kimi's mcp.json entry
// names the token's variable (no secret in the file) and goes on quit.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-widget-mcp-'));
app.setPath('userData', path.join(temp, 'profile'));
process.env.KIMI_CODE_HOME = path.join(temp, 'kimi-code');
process.env.AEGIS_KIMI_LEGACY_MCP_PATH = path.join(temp, 'kimi', 'mcp.json');
app.on('window-all-closed', () => {});

async function rpc(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const { ensureSessionHttpServer } = require('../../dist-electron/electron/libs/session-http-server.js');
    const info = await ensureSessionHttpServer();
    const names = async (url) => (await rpc(url, info.token, { method: 'tools/list', params: {} })).result.tools.map((tool) => tool.name).sort();

    const all = await names(info.url);
    assert.ok(all.includes('show_widget'), `listed: ${all}`);
    assert.ok(all.includes('widget_guide'), `listed: ${all}`);
    assert.ok(all.includes('read_session'));
    assert.deepEqual(await names(`${info.url}?tools=show_widget,widget_guide`), ['show_widget', 'widget_guide'], 'Kimi entry sees only the widget tools');
    const guide = await rpc(info.url, info.token, { method: 'tools/call', params: { name: 'widget_guide', arguments: { topics: ['chart'] } } });
    assert.match(guide.result.content[0].text, /## Charts/);

    const call = await rpc(`${info.url}?tools=show_widget`, info.token, {
      method: 'tools/call',
      params: { name: 'show_widget', arguments: { title: 'Test', html: '<div>hi</div>' } },
    });
    assert.match(call.result.content[0].text, /shown to the user/);
    const empty = await rpc(info.url, info.token, { method: 'tools/call', params: { name: 'show_widget', arguments: { html: '' } } });
    assert.equal(empty.result.isError, true, 'an empty widget is refused');
    const { writeKimiWidgetEntry, releaseKimiWidgetEntrySync, KIMI_WIDGET_SERVER_NAME, SESSION_TOKEN_ENV_VAR } = require('../../dist-electron/electron/libs/session-http-server.js');
    fs.mkdirSync(path.join(temp, 'kimi-code'), { recursive: true });
    await writeKimiWidgetEntry();
    const kimiFile = path.join(temp, 'kimi-code', 'mcp.json');
    const entry = JSON.parse(fs.readFileSync(kimiFile, 'utf8')).mcpServers[KIMI_WIDGET_SERVER_NAME];
    const { DESIGN_TOOL_NAMES } = require('../../dist-electron/shared/design-tools.js');
    assert.deepEqual(entry, { url: `${info.url}?tools=${['show_widget', 'widget_guide', ...DESIGN_TOOL_NAMES].join(',')}`, bearerTokenEnvVar: SESSION_TOKEN_ENV_VAR });
    assert.ok(!fs.readFileSync(kimiFile, 'utf8').includes(info.token), 'the token stays out of the file');
    assert.equal(process.env[SESSION_TOKEN_ENV_VAR], info.token, 'the daemon inherits the token');
    releaseKimiWidgetEntrySync();
    assert.equal(JSON.parse(fs.readFileSync(kimiFile, 'utf8')).mcpServers[KIMI_WIDGET_SERVER_NAME], undefined, 'removed on quit');
    console.log('PASS widget MCP: listed with session tools, narrowed by ?tools=, callable, Kimi entry written and released');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    // Best effort: Chromium may still be writing the profile, and a throw here
    // would skip app.exit and leave the process (and CI) hanging.
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    app.exit(code);
  }
});

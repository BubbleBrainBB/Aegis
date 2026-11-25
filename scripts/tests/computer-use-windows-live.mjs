// Real macOS window targeting. Only the two windows created by this test are touched.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
if (process.platform !== 'darwin') {
  console.log('Skipping macOS Computer Use window tests on ' + process.platform);
  process.exit(0);
}
const require = createRequire(import.meta.url);
// Running the same test with the signed app in Node mode exercises the modules
// inside its app.asar and resolves cua-driver from its signed Resources folder.
const archive = process.resourcesPath && path.join(process.resourcesPath, 'app.asar');
const packaged = archive && existsSync(path.join(archive, 'dist-electron/electron/libs/computer-use'));
const lib = (name) =>
  packaged
    ? require(path.join(archive, 'dist-electron/electron/libs', name))
    : require('../../dist-electron/electron/libs/' + name);
const { initializeComputerUseGateway } = lib('computer-use');
const { resolveCuaDriver } = lib('computer-use/driver-binary');
const root = process.cwd();
const home = mkdtempSync(path.join(tmpdir(), 'cu-windows-'));
const bundle = path.join(home, 'WindowFixture.app', 'Contents');
const id = 'org.example.cu.fixture' + process.pid;
const executable = path.join(bundle, 'MacOS', 'WindowFixture');
process.env.AEGIS_BROWSER_USE_TEST_MODE = '1';
process.env.AEGIS_COMPUTER_USE_ENABLED = '1';
process.env.AEGIS_COMPUTER_USE_SETTINGS_PATH = path.join(home, 'settings.json');
let child, gateway, childExit;
const fixtureLog = path.join(home, 'fixture.log');
const stopFile = path.join(home, 'stop');
const fixtureOutput = () => readFileSync(fixtureLog, 'utf8');
async function waitForOutput(message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fixtureOutput().includes(message)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Fixture did not report ' + message + ': ' + fixtureOutput());
}
try {
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict>' +
      '<key>CFBundleIdentifier</key><string>' +
      id +
      '</string><key>CFBundleExecutable</key><string>WindowFixture</string>' +
      '<key>CFBundleName</key><string>WindowFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  execFileSync('xcrun', [
    'swiftc',
    path.join(root, 'scripts/tests/fixtures/computer-use/TwoDocuments.swift'),
    '-o',
    executable,
  ]);
  writeFileSync(fixtureLog, '');
  child = spawn('/usr/bin/open', [
    '-gnW',
    '--stdout',
    fixtureLog,
    '-a',
    path.dirname(bundle),
    '--args',
    stopFile,
    String(process.pid),
  ]);
  childExit = once(child, 'exit');
  await waitForOutput('ready');
  const driver = resolveCuaDriver();
  assert.equal(driver.state, 'ready', driver.message);
  if (packaged) assert.equal(driver.source, 'bundled');
  const { DRIVER_INPUT_TOOLS, REVISION_INPUT_TOOLS } = lib('computer-use/policy');
  for (const name of [...Object.keys(DRIVER_INPUT_TOOLS), 'verify_state', 'zoom']) {
    const description = execFileSync(driver.path, ['describe', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const { properties, additionalProperties } = JSON.parse(description.split('input_schema:\n')[1]);
    assert.equal('ui_tree_revision' in properties, REVISION_INPUT_TOOLS.has(name), name);
    if (name === 'zoom' || name === 'verify_state') {
      assert.equal(additionalProperties, false);
      assert.deepEqual(
        Object.keys(properties).filter((key) => /file|path|out_dir/.test(key)),
        [],
        name,
      );
    }
  }
  gateway = initializeComputerUseGateway(
    {
      userDataDir: () => home,
      ownProcessIds: () => [process.pid],
      getSession: () => ({ generation: 1, planMode: false, fullAccess: false, readOnlyWorkflowRole: null }),
      requestApproval: async () => ({ allow: true, untilRevoked: false }),
      emitLive: () => {},
    },
    { hostBundleId: 'com.aegis.desktop' },
  );
  let seq = 0;
  const call = async (tool, args = {}) => {
    const result = await gateway.call({
      sessionId: 'windows',
      toolUseId: 'test-' + ++seq,
      tool,
      args: { app: id, ...args },
    });
    assert.equal(result.isError, false, tool + ': ' + result.text);
    return result;
  };
  const listed = JSON.parse((await call('list_windows')).text);
  const windowId = (title) => listed.find((w) => w.title === title)?.window_id;
  const first = windowId('First Document'),
    second = windowId('Second Document');
  assert.ok(first && second && first !== second, JSON.stringify(listed));
  if (process.argv[2] === 'signed-ui') {
    const { verifySignedTurn } = await import('./fixtures/computer-use/signed-turn.mjs');
    const checkDocuments = async (secondValue) => {
      for (const [window_id, value_equals] of [
        [first, 'original-0'],
        [second, secondValue],
      ]) {
        await call('get_app_state', { window_id, include_screenshot: false });
        const result = await call('verify_state', { window_id, role: 'AXTextField', value_equals });
        assert.equal(JSON.parse(result.text).status, 'satisfied', result.text);
      }
    };
    await verifySignedTurn({
      executable: path.resolve(process.argv[3]),
      provider: process.argv[4],
      home,
      app: id,
      second,
      checkDocuments,
    });
    console.log('Signed app driver, switch, Stop, next turn and document values verified.');
  } else if (process.argv[2]) {
    const { verifyProviderTurn } = await import('./fixtures/computer-use/provider-turn.mjs');
    const cwd = path.join(home, 'workspace');
    mkdirSync(cwd);
    await verifyProviderTurn({ kind: process.argv[2], gateway, app: id, first, second, cwd, lib });
  } else {
    const target = await call('get_app_state', {
      window_id: second,
      query: 'Document value',
      include_screenshot: false,
    });
    assert.equal(target.images.length, 0);
    const field = /\[(\d+)\] AXTextField/.exec(target.text);
    assert.ok(field, target.text);
    const wrongWindow = await gateway.call({
      sessionId: 'windows',
      toolUseId: 'wrong-document',
      tool: 'set_value',
      args: { app: id, window_id: first, element_index: field[1], value: 'wrong document' },
    });
    assert.equal(wrongWindow.isError, true);
    assert.match(wrongWindow.text, /does not match window_id/);
    const changed = await call('set_value', { window_id: second, element_index: field[1], value: 'edited' });
    assert.match(changed.text, /edited/);
    const verify = async (window_id, value_equals) => {
      const result = await call('verify_state', { window_id, role: 'AXTextField', value_equals });
      return JSON.parse(result.text);
    };
    const edited = await verify(second, 'edited');
    const crop = await call('zoom', { window_id: second, x1: 10, y1: 10, x2: 160, y2: 100 });
    assert.ok(crop.images[0]?.data.length);
    await call('get_app_state', { window_id: first });
    const untouched = await verify(first, 'original-0');
    const mismatch = await verify(first, 'edited');
    console.log(JSON.stringify({ driver: driver.version, edited, untouched, mismatch, zoom: true }));
    assert.equal(edited.status, 'satisfied');
    assert.equal(untouched.status, 'satisfied');
    assert.equal(mismatch.status, 'unsatisfied');
    await call('invoke_menu', { window_id: first, path: ['Document', 'Inspect Document'] });
    await waitForOutput('menu invoked in First Document');
    await call('get_app_state', { window_id: second });
    const otherMenu = await gateway.call({
      sessionId: 'windows',
      toolUseId: 'sibling-menu',
      tool: 'invoke_menu',
      args: { app: id, window_id: second, path: ['Document', 'Inspect Document'] },
    });
    if (otherMenu.isError) {
      assert.match(otherMenu.text, /window_not_key|not the confirmed|background_unavailable/i);
      console.log('Sibling document menu refused before dispatch.');
    } else {
      await waitForOutput('menu invoked in Second Document');
      console.log('Sibling document received its own menu command.');
    }
    assert.equal(fixtureOutput().match(/menu invoked in First Document/g)?.length, 1);
    await call('get_app_state', { window_id: first });
    await call('press_key', { window_id: first, key: 'End' });
    await call('type_text', { window_id: first, text: 'typed' });
    await call('drag', { window_id: first, from_x: 50, from_y: 82, to_x: 96, to_y: 82 });
    gateway.stopForTurn('windows', true);
    const stopped = await gateway.call({
      sessionId: 'windows',
      toolUseId: 'after-stop',
      tool: 'list_windows',
      args: { app: id },
    });
    assert.equal(stopped.isError, true);
    assert.match(stopped.text, /stopped/);
    gateway.finishTurn('windows');
    gateway.stopForTurn('windows', false);
    await call('get_app_state', { window_id: first, include_screenshot: false });
    console.log(
      'Window targeting, edit verification, zoom, menu routing, keyboard input, drag and Stop recovery passed.',
    );
  }
  assert.doesNotMatch(fixtureOutput(), /fixture took focus/);
} finally {
  try {
    await gateway?.shutdown('done');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      writeFileSync(stopFile, 'stop');
      await childExit;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

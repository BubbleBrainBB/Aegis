// One Aegis controlling another, as two real apps on this machine: real main processes,
// real renderers, a local relay and a real Claude session on the "other Mac".
// Uses agent usage, so it is not part of `npm test`.
//
//   npm run probe:multi-device-e2e
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../services/relay/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-multi-device-')));
const outDir = process.env.MULTI_DEVICE_OUT || path.join(tmp, 'shots');
await mkdir(outDir, { recursive: true });
const project = path.join(tmp, 'relay-demo');
await mkdir(project, { recursive: true });
await writeFile(path.join(project, 'README.md'), '# relay-demo\n');
for (const args of [['init', '-q'], ['config', 'user.email', 'e2e@example.com'], ['config', 'user.name', 'E2E'], ['add', '-A'], ['commit', '-qm', 'init']])
  execFileSync('git', args, { cwd: project });

const relay = createRelay({ port: 0 });
const { port: relayPort } = await relay.listen();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const vitePort = process.env.MULTI_DEVICE_VITE_PORT || '10187';
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', vitePort, '--strictPort'], {
  cwd: root, env: { ...process.env, PORT: vitePort, BROWSER: 'none' }, stdio: 'ignore',
});
for (let i = 0; i < 120; i++) {
  try { await fetch(`http://localhost:${vitePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

const patch = path.join(tmp, 'role.cjs');
await writeFile(patch, `
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROLE = process.env.MD_ROLE, TMP = ${JSON.stringify(tmp)}, OUT = ${JSON.stringify(outDir)}, PROJECT = ${JSON.stringify(project)}, RELAY = ${JSON.stringify(relayUrl)};
app.commandLine.appendSwitch('use-mock-keychain');
dialog.showMessageBox = async (...args) => { const o = args.find((a) => a && a.buttons); fs.writeFileSync(path.join(TMP, 'confirm.json'), JSON.stringify(o)); return { response: 1, checkboxChecked: false }; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[' + ROLE + ']', ...a);
const until = async (check, label, ms = 180000) => { const t = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await delay(250); } };
app.whenReady().then(async () => {
  if (app.setActivationPolicy) app.setActivationPolicy('accessory');
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window', 60000);
  await until(() => !win.webContents.isLoading() && win.webContents.getURL(), 'load', 60000);
  await delay(1500);
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message.slice(0, 300)); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const text = () => js('document.body.innerText');
  const shot = async (name) => { const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG()); log('shot', name); };
  const done = (result) => { fs.writeFileSync(path.join(TMP, ROLE + '.json'), JSON.stringify(result, null, 1)); };
  try {
    if (ROLE === 'host') {
      await js('window.__events = []; window.electron.onServerEvent((e) => { if (e.type === "session.status") window.__events.push(e.payload); }); 0');
      await js('window.electron.remoteCompanion("configure", { relay: ' + JSON.stringify(RELAY) + ', token: "" })');
      await until(() => js('window.electron.remoteCompanion("status").then((s) => s.status === "waiting")'), 'relay', 30000);
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.start', payload: { cwd: PROJECT, projectCwd: PROJECT, provider: 'claude', model: 'haiku', title: 'Fix relay reconnect', skipTitleGeneration: true, envMode: 'local', scope: 'project', teamMode: 'solo', teamId: null, claudeAccessMode: 'default', prompt: 'Reply with exactly this one word and nothing else: ready' } }) + '); 0');
      await until(() => js('window.__events.some((e) => e.status === "idle" || e.status === "completed")'), 'first turn');
      void until(() => fs.existsSync(path.join(TMP, 'start-plan')), 'plan signal', 400000).then(() =>
        js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.start', payload: { cwd: PROJECT, projectCwd: PROJECT, provider: 'claude', model: 'haiku', title: 'Plan a file', skipTitleGeneration: true, envMode: 'local', scope: 'project', teamMode: 'solo', teamId: null, claudeAccessMode: 'default', claudeExecutionMode: 'plan', prompt: 'Make a one-step plan to create a file named PLAN_OK.txt containing the word ok, then call ExitPlanMode to ask me to approve it. Once approved, create the file.' } }) + '); 0'),
      ).catch(() => {});
      const offer = await js('window.electron.remoteCompanion("pair")');
      fs.writeFileSync(path.join(TMP, 'offer.txt'), offer.url);
      log('offer ready');
      await until(() => fs.existsSync(path.join(TMP, 'stop-host')), 'stop', 400000);
      await delay(800);
      await shot('host-after');
      done({ ok: true, cardGone: !(await text()).includes('Approve once'), devices: (await js('window.electron.remoteCompanion("status")')).devices.map((d) => d.name) });
    } else {
      const link = await until(() => fs.existsSync(path.join(TMP, 'offer.txt')) && fs.readFileSync(path.join(TMP, 'offer.txt'), 'utf8'), 'offer');
      await js('window.__statuses = []; window.electron.onServerEvent((e) => { if (e.type === "session.status" || e.type === "runner.error") window.__statuses.push(e); }); 0');
      // Through the real page: Settings, Connections, Add device, paste, Connect.
      const page = (fn, arg) => js('(' + fn.toString() + ')(' + JSON.stringify(arg ?? null) + ')');
      const press = (label) => page((text) => {
        const el = [...document.querySelectorAll('button, [role="menuitem"]')].find((n) => (n.textContent.trim() === text || (n.getAttribute('role') === 'menuitem' && n.textContent.trim().startsWith(text))) && n.getBoundingClientRect().width > 0);
        if (!el) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        return true;
      }, label);
      await page(() => {
        const el = document.querySelector('[aria-label^="Profile menu"]');
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      await until(() => press('Settings'), 'settings item', 10000);
      await until(() => press('Connections'), 'connections tab', 15000);
      await until(async () => (await text()).includes('Devices you control'), 'connections page', 15000);
      await delay(300);
      await shot('0-connections-empty');
      await until(() => press('Add device'), 'add device', 10000);
      await until(() => js('!!document.querySelector("[data-pairing-link]")'), 'dialog', 10000);
      await page((value) => {
        const el = document.querySelector('[data-pairing-link]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, link);
      await until(() => press('Connect'), 'connect', 10000);
      await until(() => js('window.electron.remoteHosts("list").then((l) => l[0] && l[0].status === "connected")'), 'connected', 60000);
      await until(async () => /Connected · (Relay|Direct)/.test(await text()), 'status row', 15000);
      await delay(600);
      await shot('0-connections-paired');
      await until(() => press('Back to app'), 'back to app', 10000);
      await until(async () => (await text()).includes('Fix relay reconnect'), 'row in sidebar', 30000);
      await shot('1-sidebar');
      const rowInfo = await js(\`(() => { const el = [...document.querySelectorAll('*')].filter((n) => n.children.length === 0 || n.textContent === 'Fix relay reconnect').reverse().find((n) => n.textContent === 'Fix relay reconnect' && n.getBoundingClientRect().width > 0); const row = el && (el.closest('[data-session-id]') || el.closest('button') || el.closest('[role="button"]') || el.parentElement); if (!row) return null; row.click(); return { glyph: !!row.querySelector('[data-session-device]') }; })()\`);
      log('row', JSON.stringify(rowInfo));
      await until(async () => (await text()).includes('ready'), 'history shown', 30000);
      await delay(800);
      await shot('2-opened');
      const chip = await js('!!document.querySelector("[data-session-machine]")');
      log('chip', chip);
      const remoteId = await until(async () => {
        const raw = await js('new Promise((resolve) => { const off = window.electron.onServerEvent((e) => { if (e.type === "session.list") { off(); resolve(e.payload.sessions.filter((s) => s.device).map((s) => s.id)); } }); window.electron.sendClientEvent({ type: "session.list" }); })');
        return raw && raw[0];
      }, 'remote id', 20000);
      const prompt = 'Use the Bash tool to run exactly: echo hello-from-macbook > DONE.txt  Then say the word finished.';
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: remoteId, prompt } }) + '); 0');
      await until(async () => { const t = await text(); return t.includes('Approve once'); }, 'approval card', 120000);
      await delay(500);
      await shot('3-approval');
      const clicked = await js(\`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Approve once'); if (!b) return [...document.querySelectorAll('button')].map((x) => x.textContent.trim()).filter(Boolean).slice(-12); b.click(); return true; })()\`);
      log('allow clicked', JSON.stringify(clicked));
      await until(() => fs.existsSync(path.join(PROJECT, 'DONE.txt')), 'file written on the host', 120000);
      await until(async () => /finished/i.test(await text()), 'answer shown', 120000);
      await delay(1500);
      await shot('4-finished');
      // A question from the agent, answered here.
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: remoteId, prompt: 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with: chosen color is <color>.' } }) + '); 0');
      await until(async () => { const t = await text(); return t.includes('Red') && t.includes('Blue') && /Skip|Submit|Send/.test(t); }, 'question card', 120000);
      await delay(400);
      await shot('3b-question');
      await until(() => page(() => {
        const option = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Blue') && b.getBoundingClientRect().width > 0);
        if (!option) return false;
        option.click();
        return true;
      }), 'pick an option', 10000);
      await delay(300);
      await until(() => page(() => {
        const skip = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip' || /^(Skip|Decline)/.test(b.textContent.trim()));
        const send = skip && [...skip.parentElement.querySelectorAll('button')].filter((b) => b !== skip && !b.disabled).at(-1);
        if (!send) return false;
        send.click();
        return true;
      }), 'submit the answer', 10000);
      await until(async () => /chosen color is blue/i.test(await text()), 'the answer reached the agent', 120000);
      await delay(800);
      await shot('3c-question-answered');
      const questionAnswered = true;

      // A plan from a session in plan mode on that Mac, approved here.
      fs.writeFileSync(path.join(TMP, 'start-plan'), '1');
      await until(async () => (await text()).includes('Plan a file'), 'plan session listed', 60000);
      await until(() => page(() => {
        const el = [...document.querySelectorAll('*')].reverse().find((n) => n.textContent === 'Plan a file' && n.getBoundingClientRect().width > 0 && n.closest('button, [role="button"], [data-session-id]'));
        if (!el) return false;
        el.closest('button, [role="button"], [data-session-id]').click();
        return true;
      }), 'open the plan session', 20000);
      await until(async () => (await text()).includes('Approve and execute'), 'plan card', 180000);
      await delay(400);
      await shot('3d-plan');
      await until(() => page(() => {
        const option = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Approve and execute') && b.getBoundingClientRect().width > 0);
        if (!option) return false;
        option.click();
        return true;
      }), 'approve the plan', 10000);
      await delay(300);
      await page(() => {
        const skip = [...document.querySelectorAll('button')].find((b) => /^(Skip|Decline)/.test(b.textContent.trim()));
        const send = skip && [...skip.parentElement.querySelectorAll('button')].filter((b) => b !== skip && !b.disabled).at(-1);
        if (send) send.click();
      });
      await until(async () => {
        if (fs.existsSync(path.join(PROJECT, 'PLAN_OK.txt'))) return true;
        if ((await text()).includes('Approve once')) await press('Approve once');
        return false;
      }, 'plan carried out on the host', 180000);
      const planApproved = true;
      await delay(800);
      await shot('3e-plan-done');

      // A new task on the other Mac, through the landing composer: the device-grouped menu,
      // that Mac's agents, typed text and the Send button.
      await until(() => press('New Task'), 'new task', 10000);
      await until(async () => (await text()).includes('What should we work on'), 'landing', 15000);
      await page(() => {
        const el = document.querySelector('[aria-label="Project folder"]');
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      await until(() => js('!!document.querySelector("[data-remote-host-projects]")'), 'device group in the project menu', 15000);
      await delay(300);
      await shot('7-project-menu');
      await page(() => {
        const el = document.querySelector('[data-remote-host-projects] [cmdk-item]');
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      await until(async () => (await text()).includes(' / relay-demo'), 'device in the tray', 15000);
      await until(() => js('(() => { const el = document.querySelector("[data-remote-agent-picker]"); return !!el && !el.disabled && el.textContent.trim().startsWith("Claude Code"); })()'), 'agents from that Mac', 30000);
      await delay(300);
      await shot('8-new-task-remote');
      const localControlsGone = await page(() => !document.querySelector('[data-composer-control="permission"]') || !!document.querySelector('[data-remote-agent-picker]'));
      // That Mac's model list and permission modes, in the composer.
      const fire = (selector) => page((css) => {
        const el = document.querySelector(css);
        if (!el) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
        return true;
      }, selector);
      await fire('[data-remote-agent-picker]');
      await until(() => js('!!document.querySelector("[data-remote-model-option]")'), 'model list from that Mac', 15000);
      await delay(300);
      await shot('8a-remote-models');
      const modelPicked = await fire('[data-remote-model-option*="haiku"]');
      if (!modelPicked) await page(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await delay(400);
      await fire('[data-composer-control="permission"]');
      await until(() => press('Full Access'), 'full access option', 10000);
      await until(() => js('document.querySelector("[data-composer-control=permission]").textContent.includes("Full Access")'), 'full access chosen', 5000);
      await delay(300);
      await shot('8b-remote-full-access');
      await page(() => {
        const el = document.querySelector('[data-composer-drop-zone] [contenteditable="true"], [data-composer-drop-zone] textarea');
        el.focus();
      });
      win.focus();
      win.webContents.focus();
      win.webContents.insertText('Use the Bash tool to run exactly: echo full > FULL.txt  Then reply with exactly this one word: started-remotely');
      await until(async () => (await text()).includes('started-remotely'), 'typed text', 10000);
      await delay(300);
      await page(() => {
        const zone = document.querySelector('[data-composer-drop-zone]');
        const buttons = [...zone.querySelectorAll('button')].filter((b) => !b.disabled);
        const send = buttons.at(-1);
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) send.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      await until(() => js('!!document.querySelector("[data-session-machine]") && !document.body.innerText.includes("What should we work on")'), 'moved to the new session', 60000);
      await until(async () => { const t = await text(); return (t.match(/started-remotely/g) || []).length >= 2; }, 'answer from the new task', 120000);
      await delay(800);
      await shot('9-new-task-running-remote');
      const hostSessions = await until(async () => {
        const listed = await js('new Promise((resolve) => { const off = window.electron.onServerEvent((e) => { if (e.type === "session.list") { off(); resolve(e.payload.sessions.filter((s) => s.device).length); } }); window.electron.sendClientEvent({ type: "session.list" }); })');
        return listed >= 2 && listed;
      }, 'second session listed', 20000);
      log('remote sessions', hostSessions, 'local controls gone', localControlsGone, 'model picked', modelPicked);
      const fullAccessRan = fs.existsSync(path.join(PROJECT, 'FULL.txt'));
      const remoteSettingsOf = async (title) => {
        const listed = await js('new Promise((resolve) => { const off = window.electron.onServerEvent((e) => { if (e.type === "session.list") { off(); resolve(e.payload.sessions.filter((s) => s.device)); } }); window.electron.sendClientEvent({ type: "session.list" }); })');
        return listed.find((s) => s.title.startsWith(title))?.remoteSettings;
      };
      const chosen = await until(() => remoteSettingsOf('Use the Bash tool'), 'settings on the host', 15000);
      log('settings on the host', JSON.stringify(chosen));
      // A follow-up keeps them: the host must not fall back to its default mode.
      await page(() => document.querySelector('[data-composer-drop-zone] [contenteditable="true"], [data-composer-drop-zone] textarea').focus());
      win.focus();
      win.webContents.focus();
      win.webContents.insertText('Reply with exactly this one word: followed-up');
      await delay(300);
      await page(() => {
        const zone = document.querySelector('[data-composer-drop-zone]');
        const send = [...zone.querySelectorAll('button')].filter((b) => !b.disabled).at(-1);
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) send.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      await until(async () => { const t = await text(); return (t.match(/followed-up/g) || []).length >= 2; }, 'follow-up answered', 120000);
      await delay(1500);
      const kept = await remoteSettingsOf('Use the Bash tool');
      const settingsKept = kept?.permissionMode === 'bypassPermissions' && chosen?.permissionMode === 'bypassPermissions' && (!modelPicked || /haiku/.test(kept?.model ?? ''));
      log('settings after the follow-up', JSON.stringify(kept));
      await shot('9b-follow-up');
      // A file from this Mac, read by the agent on that one.
      const followId = (await js('new Promise((resolve) => { const off = window.electron.onServerEvent((e) => { if (e.type === "session.list") { off(); resolve(e.payload.sessions.find((s) => s.title.startsWith("Use the Bash tool")).id); } }); window.electron.sendClientEvent({ type: "session.list" }); })'));
      const notePath = path.join(TMP, 'secret-note.txt');
      fs.writeFileSync(notePath, 'The secret word is marmalade.');
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: followId, prompt: 'Read the attached file and reply with only the secret word in it.', attachments: [{ id: 'note', path: notePath, name: 'secret-note.txt', size: fs.statSync(notePath).size, mimeType: 'text/plain', kind: 'file' }] } }) + '); 0');
      await until(async () => /marmalade/i.test(await text()), 'the attachment reached the agent', 120000);
      const attachmentRead = true;
      await delay(800);
      await shot('9c-attachment');
      // A message into the running turn.
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: followId, prompt: 'Use the Bash tool to run exactly: sleep 25  Then reply with the word slept.' } }) + '); 0');
      await until(() => js('!!document.querySelector("[data-session-machine]") && document.body.innerText.includes("sleep 25")'), 'long turn visible', 30000);
      await delay(6000);
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.continue', payload: { sessionId: followId, prompt: 'Also end your reply with the word pineapple.' } }) + '); 0');
      await delay(1000);
      await shot('9d-steer-sent');
      await until(async () => /Also end your reply with the word pineapple/.test(await text()), 'steer shown here', 15000);
      await until(async () => { const matches = (await text()).match(/pineapple/gi) || []; return matches.length >= 2; }, 'the steer reached the agent', 150000);
      const steered = true;
      const steerErrors = await js('window.__statuses.filter((e) => e.type === "runner.error").map((e) => e.payload.message)');
      await delay(800);
      await shot('9e-steered');
      const statuses = await js('window.__statuses.map((e) => e.type === "runner.error" ? "error:" + e.payload.message : e.payload.status)');
      const hidden = await page(() => !!document.querySelector('[title="Add files or photos"]') && !!document.querySelector('[data-remote-agent-picker]'));
      // The other Mac goes away: a short gap first, then a plain offline state.
      fs.writeFileSync(path.join(TMP, 'stop-host'), '1');
      await until(() => js('!!document.querySelector("[data-session-machine] .animate-spin")'), 'reconnecting', 30000);
      await shot('5-reconnecting');
      await until(() => js('!!document.querySelector("[data-remote-offline]")'), 'offline row', 60000);
      await delay(300);
      await shot('6-offline');
      const composerLocked = await js('(() => { const el = document.querySelector("[data-composer-drop-zone] textarea, [data-composer-drop-zone] [contenteditable]"); return !!el && (el.disabled === true || el.getAttribute("contenteditable") === "false"); })()');
      const stillListed = (await text()).includes('Fix relay reconnect');
      done({ ok: true, chip, glyph: rowInfo && rowInfo.glyph, hidden, localControlsGone, attachmentRead, steered, steerErrors, fullAccessRan, settingsKept, hostSessions, questionAnswered, planApproved, composerLocked, stillListed, statuses, errors: errors.slice(0, 30), file: fs.readFileSync(path.join(PROJECT, 'DONE.txt'), 'utf8') });
    }
  } catch (error) {
    log('FAILED', error.message);
    try { await shot('failed-' + ROLE); } catch {}
    try { log('page text:', (await text()).slice(0, 1200)); } catch {}
    done({ ok: false, error: error.message, errors: errors.slice(0, 30) });
    fs.writeFileSync(path.join(TMP, 'stop-host'), '1');
  }
  await delay(300);
  app.exit(0);
});
`);
// The role script is generated: check it now, or a mistake in it only shows as a silent hang.
execFileSync(process.execPath, ['--check', patch], { stdio: 'inherit' });
const seed = (name) => path.join(tmp, name);
const children = [];
const launch = async (role) => {
  const dir = seed(role);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'renderer-state.json'), JSON.stringify({ 'aegis-onboarding-complete': '1' }));
  const env = { ...process.env, MD_ROLE: role, AEGIS_USER_DATA_DIR: dir, PORT: vitePort, AEGIS_REMOTE_LAN: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/.bin/electron'), ['-r', patch, root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const relayLogs = (chunk) => { for (const line of String(chunk).split('\n')) if (/^\[(host|controller)\]/.test(line)) console.log(line); };
  child.stdout.on('data', relayLogs);
  child.stderr.on('data', relayLogs);
  return new Promise((resolve) => child.on('close', resolve));
};
const finished = Promise.all([launch('host'), launch('controller')]);
const timeout = setTimeout(() => { console.log('[e2e] overall timeout'); for (const child of children) child.kill(); vite.kill(); process.exit(2); }, 15 * 60_000);
await finished;
clearTimeout(timeout);
vite.kill();
await relay.close();
const read = async (name) => (existsSync(seed(name + '.json')) ? JSON.parse(await readFile(seed(name + '.json'), 'utf8')) : null);
const host = await read('host');
const controller = await read('controller');
const confirm = existsSync(seed('confirm.json')) ? JSON.parse(await readFile(seed('confirm.json'), 'utf8')) : null;
console.log('[e2e] host:', JSON.stringify(host));
console.log('[e2e] controller:', JSON.stringify(controller, null, 1));
console.log('[e2e] confirm dialog:', confirm && confirm.message);
console.log('[e2e] screenshots:', outDir);
const ok = host?.ok && host.cardGone && controller?.ok && controller.file === 'hello-from-macbook\n' && controller.chip && controller.glyph && controller.hidden && controller.localControlsGone && controller.attachmentRead && controller.steered && !controller.steerErrors.length && controller.fullAccessRan && controller.settingsKept && controller.hostSessions >= 2 && controller.questionAnswered && controller.planApproved && controller.composerLocked && controller.stillListed;
console.log(ok ? '[e2e] PASS' : '[e2e] FAIL');
process.exit(ok ? 0 : 1);

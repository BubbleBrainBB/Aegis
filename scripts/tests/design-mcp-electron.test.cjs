// Design tools over Aegis's session MCP server and as Bubble / Pi tools.
// A runtime bound to one session (signed x-aegis-session header) writes that
// session's designs; a forged header is refused; a shared runtime is
// attributed from request meta; a process-global one (Kimi) from the caller's
// pending call in its history. design_preview returns a real screenshot.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-mcp-'));
app.setPath('userData', path.join(temp, 'profile'));
process.env.KIMI_CODE_HOME = path.join(temp, 'kimi-code');
process.env.AEGIS_KIMI_LEGACY_MCP_PATH = path.join(temp, 'kimi', 'mcp.json');
app.on('window-all-closed', () => {});

async function post(url, headers, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
}
async function rpc(url, headers, body) {
  const response = await post(url, headers, body);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const call = (url, headers, name, args) => rpc(url, headers, { method: 'tools/call', params: { name, arguments: args } });
const json = (result) => JSON.parse(result.result.content[0].text);

app.whenReady().then(async () => {
  let code = 0;
  try {
    const http = require('../../dist-electron/electron/libs/session-http-server.js');
    const { initializeToolCallerAttribution } = require('../../dist-electron/electron/libs/tool-caller-attribution.js');
    const { createNativeDesignTools, createPiDesignTools, setDesignAgentNamer } = require('../../dist-electron/electron/design/tools.js');
    const { getDesignRepository } = require('../../dist-electron/electron/design/service.js');
    const { DESIGN_TOOL_NAMES } = require('../../dist-electron/shared/design-tools.js');
    setDesignAgentNamer((sessionId) => (sessionId === 'session-a' ? 'Claude' : undefined));

    const info = await http.ensureSessionHttpServer();
    const auth = { Authorization: `Bearer ${info.token}` };
    const scoped = async (sessionId) => (await http.getSessionReaderHttpConfig({ sessionId })).headers;
    const a = await scoped('session-a');

    // Listed beside the other session tools; Kimi's narrowed entry sees them too.
    const listed = (await rpc(info.url, a, { method: 'tools/list', params: {} })).result.tools.map((t) => t.name);
    for (const name of DESIGN_TOOL_NAMES) assert.ok(listed.includes(name), `${name} listed: ${listed}`);
    const kimiList = (await rpc(`${info.url}?tools=show_widget,widget_guide,${DESIGN_TOOL_NAMES.join(',')}`, auth, { method: 'tools/list', params: {} })).result.tools.map((t) => t.name);
    assert.deepEqual(kimiList.sort(), ['show_widget', 'widget_guide', ...DESIGN_TOOL_NAMES].sort());

    // A session-bound runtime: create, add a board, read, preview.
    const created = json(await call(info.url, a, 'design_create', { title: 'Atlas website', operationId: 'op-1' }));
    assert.equal(created.title, 'Atlas website');
    const updated = json(await call(info.url, a, 'design_update', {
      documentId: created.id, operationId: 'op-2', summary: 'Drew Home',
      operations: [{ type: 'add', name: 'Home', width: 640, height: 400, html: '<main style="padding:40px;background:#f6f2ea"><h1>Notes that think along with you.</h1></main>' }],
    }));
    assert.equal(updated.boards.length, 1);
    assert.equal(updated.renderStatus, 'not_checked');
    const history = getDesignRepository().history('session-a', created.id);
    assert.equal(history[0].author.name, 'Claude', 'versions name the session’s agent');
    const read = json(await call(info.url, a, 'design_read', { documentId: created.id }));
    assert.match(read.boards[0].html, /Notes that think/);
    const preview = await call(info.url, a, 'design_preview', { documentId: created.id, boardId: updated.boards[0].id, revision: updated.revision });
    const image = preview.result.content.find((c) => c.type === 'image');
    assert.ok(image && image.mimeType === 'image/png' && image.data.length > 1000, 'the preview is a PNG');
    assert.equal(json(preview).imageAttached, true);
    const guide = await call(info.url, a, 'design_guide', { topics: ['structure'] });
    assert.match(guide.result.content[0].text, /data-aegis-layer-name/);

    // Another session's runtime cannot see or touch session-a's design.
    const b = await scoped('session-b');
    assert.deepEqual(json(await call(info.url, b, 'design_read', {})), []);
    const foreign = await call(info.url, b, 'design_read', { documentId: created.id });
    assert.equal(foreign.result.isError, true);
    // A forged session header is refused outright.
    const forged = await post(info.url, { ...auth, 'x-aegis-session': 'session-a.forged' }, { method: 'tools/list', params: {} });
    assert.equal(forged.status, 403);
    assert.equal((await post(info.url, { ...auth, 'x-aegis-session-resolver': 'nobody' }, { method: 'tools/list', params: {} })).status, 403);

    // A shared runtime (OpenCode) names the caller in request meta.
    http.registerSessionMetaResolver('test-runtime', async (meta) => (meta && meta.chat === 'c-1' ? 'session-a' : null));
    const shared = (await http.getSessionReaderHttpConfig({ resolver: 'test-runtime' })).headers;
    const viaMeta = await rpc(info.url, shared, { method: 'tools/call', params: { name: 'design_read', arguments: {}, _meta: { chat: 'c-1' } } });
    assert.equal(json(viaMeta)[0].id, created.id, 'attributed from request meta');

    // A process-global runtime (Kimi): attributed from the pending call in history.
    const pendingInput = { documentId: created.id, includeResolved: true };
    initializeToolCallerAttribution({
      listRunningSessionIds: () => ['session-z', 'session-a'],
      getSessionHistory: (sessionId) => sessionId === 'session-a'
        ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-9', name: 'mcp__aegis-widgets__design_comments', input: pendingInput }] } }]
        : [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'other_design_comments', input: pendingInput }] } }],
    });
    const scanned = await call(info.url, auth, 'design_comments', pendingInput);
    assert.equal(scanned.result.isError, undefined, scanned.result.content[0].text);
    assert.deepEqual(json(scanned), []);
    // Claimed once: the same call cannot be attributed twice.
    const unclaimed = await call(info.url, auth, 'design_comments', pendingInput);
    assert.equal(unclaimed.result.isError, true);
    assert.match(unclaimed.result.content[0].text, /No Aegis conversation/);

    // Bubble host tools and Pi custom tools act for the session they were made for.
    const bubble = createNativeDesignTools('session-a');
    assert.deepEqual(bubble.map((t) => t.name), [...DESIGN_TOOL_NAMES]);
    assert.equal(bubble.find((t) => t.name === 'design_update').effect, 'write_direct');
    const bubbleRead = await bubble.find((t) => t.name === 'design_read').execute({}, {});
    assert.equal(JSON.parse(bubbleRead.content)[0].id, created.id);
    const bubblePreview = await bubble.find((t) => t.name === 'design_preview').execute({ documentId: created.id, boardId: updated.boards[0].id, revision: updated.revision }, {});
    assert.equal(bubblePreview.images[0].mimeType, 'image/png');
    const pi = createPiDesignTools('session-b');
    await assert.rejects(() => pi.find((t) => t.name === 'design_read').execute('call-1', { documentId: created.id }), /not found/i);
    const piGuide = await pi.find((t) => t.name === 'design_guide').execute('call-2', {});
    assert.match(piGuide.content[0].text, /Designing on the Aegis canvas/);

    // Render checks: what the screenshot alone might not show.
    const broken = json(await call(info.url, a, 'design_update', {
      documentId: created.id, operationId: 'op-checks', operations: [
        { type: 'add', name: 'Broken', width: 400, height: 300, html: '<main style="position:relative;height:600px;font:16px system-ui"><h2 style="position:absolute;top:20px;left:20px;margin:0">Overlapping title</h2><p style="position:absolute;top:24px;left:30px;margin:0">Body text on top</p><div style="position:absolute;top:120px;left:20px;width:80px;height:20px;overflow:hidden;white-space:nowrap">A caption that is far too long for its box</div><div style="position:absolute;top:160px;left:20px;width:80px;height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Ellipsis is intended here</div><img alt="" src="data:image/png;base64,AAAA"></main>' },
        { type: 'add', name: 'Empty', width: 400, height: 300, html: '<main></main>' },
      ],
    }));
    const boardId = (name) => broken.boards.find((b) => b.name === name).id;
    const checks = json(await call(info.url, a, 'design_preview', { documentId: created.id, boardId: boardId('Broken'), revision: broken.revision })).warnings;
    assert.ok(checks.some((w) => /Text overlaps: h2 "Overlapping title" and p "Body text on top"/.test(w)), JSON.stringify(checks));
    assert.ok(checks.some((w) => /cut off inside div "A caption/.test(w)), JSON.stringify(checks));
    assert.ok(!checks.some((w) => /Ellipsis is intended/.test(w)), 'an ellipsis is intended overflow');
    assert.ok(checks.some((w) => /taller than the board \(600 > 300px\)/.test(w)), JSON.stringify(checks));
    assert.ok(checks.some((w) => /1 image could not be loaded/.test(w)), JSON.stringify(checks));
    const empty = json(await call(info.url, a, 'design_preview', { documentId: created.id, boardId: boardId('Empty'), revision: broken.revision })).warnings;
    assert.deepEqual(empty, ['The board renders empty: nothing visible is drawn.']);
    const clean = json(preview).warnings;
    assert.deepEqual(clean, [], 'a sound board has no warnings');

    // The composer's style and variations reach the agent: context and guide.
    const { setDesignComposerPrefs, designContextText } = require('../../dist-electron/electron/design/focus.js');
    const { setDesignPromptSource } = require('../../dist-electron/electron/design/tools.js');
    setDesignComposerPrefs('session-a', { styleId: 'quiet-slate', variants: 3 });
    const context = designContextText('session-a');
    assert.match(context, /Style guide: "Quiet Slate"/);
    assert.match(context, /make 3 distinct directions/);
    assert.match(designContextText('fresh-draft') || '', /^$/, 'nothing picked, no designs: no context');
    setDesignComposerPrefs('fresh-draft', { variants: 2 });
    assert.match(designContextText('fresh-draft'), /make 2 distinct directions/, 'a new design carries its picks before any board');
    const styled = await call(info.url, a, 'design_guide', { topics: ['color'] });
    assert.match(styled.result.content[0].text, /Style guide: Quiet Slate[\s\S]*--accent: #4f5bd5/);
    // Agent versions keep the message that asked for them.
    setDesignPromptSource((sessionId) => (sessionId === 'session-a' ? { prompt: 'Make the hero calmer', id: 'm-1' } : undefined));
    const current = json(await call(info.url, a, 'design_read', { documentId: created.id }));
    await call(info.url, a, 'design_update', { documentId: created.id, operationId: 'op-3', operations: [{ type: 'content', boardId: current.boards[0].id, expectedRevision: current.boards[0].contentRevision, html: '<main><h1>Calmer</h1></main>' }] });
    assert.equal(getDesignRepository().boardPrompts('session-a', created.id)[current.boards[0].id].prompt, 'Make the hero calmer');

    // A project's design system: guide by default, components and templates on demand.
    const { setDesignProjectRoot, listProjectTemplates } = require('../../dist-electron/electron/design/styles.js');
    const project = path.join(temp, 'project');
    fs.mkdirSync(path.join(project, 'design-system', 'components'), { recursive: true });
    fs.mkdirSync(path.join(project, 'design-system', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(project, 'design-system', 'README.md'), '# Atlas design system\nCalm, paper-like surfaces; one ink accent.\n');
    fs.writeFileSync(path.join(project, 'design-system', 'components', 'Button.md'), '# Primary and quiet buttons\nVariants: primary, quiet. Never more than one primary per view.\n');
    fs.writeFileSync(path.join(project, 'design-system', 'components', 'Button.html'), '<button class="btn btn-primary">Start writing</button>');
    fs.writeFileSync(path.join(project, 'design-system', 'templates', 'landing.html'), '<main><h1>Landing</h1><script>alert(1)</script></main>');
    fs.writeFileSync(path.join(project, 'design-system', 'templates', 'landing.md'), 'A product landing page: hero, three features, pricing.');
    setDesignProjectRoot((sessionId) => (sessionId === 'session-ds' ? project : null));
    const ds = await scoped('session-ds');
    const index = await call(info.url, ds, 'design_resources', {});
    assert.match(index.result.content[0].text, /- Button: Primary and quiet buttons[\s\S]*- landing: A product landing page/);
    assert.match((await call(info.url, ds, 'design_resources', { kind: 'component', name: 'button' })).result.content[0].text, /Never more than one primary[\s\S]*Reference markup[\s\S]*btn-primary/);
    assert.match((await call(info.url, ds, 'design_resources', { kind: 'template', name: 'landing' })).result.content[0].text, /Template: Landing[\s\S]*<h1>Landing<\/h1>/);
    assert.match((await call(info.url, ds, 'design_resources', { kind: 'template', name: 'nope' })).result.content[0].text, /No template named "nope"/);
    const dsGuide = (await call(info.url, ds, 'design_guide', { topics: ['color'] })).result.content[0].text;
    assert.match(dsGuide, /Style guide: This project's design system[\s\S]*Calm, paper-like[\s\S]*Components \(read one/, 'the project system applies by default');
    assert.doesNotMatch(listProjectTemplates('session-ds')[0].html, /<script/, 'templates are sanitized for thumbnails');
    assert.equal(designContextText('session-ds'), '', 'no design work yet: no context line in plain chats');
    setDesignComposerPrefs('session-ds', { templateId: 'landing' });
    assert.match(designContextText('session-ds'), /Template: start new boards from "Landing"/);
    assert.match((await call(info.url, b, 'design_resources', {})).result.content[0].text, /no design system/);

    // Quick edits: one layer, a fast model, new markup or a handoff.
    const { quickEditDesign, setQuickEditModel, cancelQuickEdit, quickEditReply } = require('../../dist-electron/electron/design/quick-edit.js');
    assert.deepEqual(quickEditReply('```html\n<h1>x</h1>\n```'), { html: '<h1>x</h1>' });
    assert.deepEqual(quickEditReply('Here you go: <p>y</p> done'), { html: '<p>y</p>' });
    assert.deepEqual(quickEditReply('HANDOFF: needs a new board'), { handoff: 'needs a new board' });
    const qeDoc = json(await call(info.url, a, 'design_update', { documentId: created.id, operationId: 'op-qe', operations: [{ type: 'add', name: 'Quick', width: 400, height: 300, html: '<style>:root{--accent:#4f5bd5}</style><main><h1 style="font-size: 48px">Notes</h1><p>Body</p></main>' }] }));
    const quick = qeDoc.boards.find((x) => x.name === 'Quick');
    const h1 = (getDesignRepository().read('session-a', created.id).boards.find((x) => x.id === quick.id).html.match(/<h1[^>]*data-aegis-node-id="([^"]+)"/) || [])[1];
    assert.ok(h1, 'h1 has a layer id');
    let seen = null;
    setQuickEditModel(async (input) => { seen = input; return '```html\n<h1 style="font-size: 36px; color: var(--accent)">Notes</h1>\n```'; });
    const req = (over) => ({ requestId: 'q-' + Math.random(), sessionId: 'session-a', documentId: created.id, boardId: quick.id, nodeId: h1, instruction: 'smaller, in the accent color', ...over });
    const ok = await quickEditDesign(req());
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.match(ok.html, new RegExp(`<h1 style="font-size: 36px; color: var\\(--accent\\)" data-aegis-node-id="${h1}">Notes</h1><p`));
    assert.equal(ok.contentRevision, quick.contentRevision);
    assert.match(seen.prompt, /--accent: #4f5bd5/);
    assert.match(seen.prompt, /<h1 style="font-size: 48px"/);
    assert.match(seen.system, /HANDOFF/);
    setQuickEditModel(async () => 'HANDOFF: needs a second board');
    assert.deepEqual(await quickEditDesign(req()), { ok: false, handoff: 'needs a second board' });
    setQuickEditModel(async () => '<h1>A</h1><h2>B</h2>');
    assert.match((await quickEditDesign(req())).handoff, /didn't fit the board/);
    setQuickEditModel(async () => { throw new Error('not logged in'); });
    assert.match((await quickEditDesign(req())).error, /needs Claude Code: not logged in/);
    setQuickEditModel(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pendingEdit = quickEditDesign(req({ requestId: 'q-cancel' }));
    await new Promise((r) => setTimeout(r, 50));
    cancelQuickEdit('q-cancel');
    assert.match((await pendingEdit).error, /Cancelled/);
    assert.match((await quickEditDesign(req({ sessionId: 'session-b' })).catch((e) => ({ error: e.message }))).error, /not found/i, 'only the session\'s own designs');

    // Handoff: chosen boards and a README written into the session's project.
    const { handOffDesign, slugOf } = require('../../dist-electron/electron/design/handoff.js');
    assert.throws(() => handOffDesign({ sessionId: 'session-a', documentId: created.id }), /no project folder/);
    setDesignProjectRoot((sessionId) => (sessionId === 'session-a' ? project : null));
    const handed = handOffDesign({ sessionId: 'session-a', documentId: created.id, boardIds: [quick.id] });
    assert.match(handed.folder, /^\.aegis[\\/]design[\\/][a-z0-9-]+$/);
    assert.deepEqual(handed.boards.map((x) => [x.name, x.file, x.width]), [['Quick', 'quick.html', 400]]);
    assert.match(fs.readFileSync(path.join(project, handed.folder, 'quick.html'), 'utf8'), /<h1[^>]*>Notes<\/h1>/);
    const readme = fs.readFileSync(path.join(project, handed.folder, 'README.md'), 'utf8');
    assert.match(readme, /- Quick \(400 × 300\): quick\.html[\s\S]*## Tokens\n- --accent: #4f5bd5[\s\S]*not code to paste in/);
    assert.equal(handOffDesign({ sessionId: 'session-a', documentId: created.id }).boards.length, getDesignRepository().read('session-a', created.id).boards.length, 'no choice: every board');
    assert.throws(() => handOffDesign({ sessionId: 'session-a', documentId: created.id, boardIds: ['gone'] }), /at least one board/);
    assert.equal(slugOf('Café — Home!', 'x'), 'cafe-home');
    assert.equal(slugOf('***', 'board-1'), 'board-1');

    // Designs belong to the project: another chat there lists and works on them.
    setDesignProjectRoot((sessionId) => (sessionId === 'session-a' || sessionId === 'session-p' ? project : null));
    const p = await scoped('session-p');
    const inProject = json(await call(info.url, p, 'design_read', {}));
    assert(inProject.some((d) => d.id === created.id && d.member === false), 'the project design is listed for another chat: ' + JSON.stringify(inProject));
    const fresh = json(await call(info.url, p, 'design_read', { documentId: created.id }));
    json(await call(info.url, p, 'design_update', { documentId: created.id, operationId: 'op-project', operations: [{ type: 'add', name: 'From another chat', html: '<main><h1>Hi</h1></main>' }] }));
    assert.equal(getDesignRepository().chats(created.id)[0], 'session-p', 'the agent that changed it joined its chats');
    assert(json(await call(info.url, p, 'design_read', {})).find((d) => d.id === created.id).member);
    assert.equal(fresh.project, project);
    assert.match((await call(info.url, b, 'design_read', { documentId: created.id })).result.content[0].text, /not found/i, 'other projects still cannot');

    console.log('PASS design MCP: listed, session-bound writes and previews, isolation, forged headers refused, meta and history attribution, Bubble and Pi tools, quick edits, handoff');
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

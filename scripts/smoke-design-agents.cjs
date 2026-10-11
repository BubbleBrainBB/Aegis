// Manual smoke test with real agents (not part of npm test: it uses your
// Claude Code / Codex accounts). Each agent reaches Aegis's session MCP server
// bound to one session, creates a design, draws a board, previews it, then
// addresses a design comment and replies in its thread.
//
//   node node_modules/electron/cli.js scripts/smoke-design-agents.cjs [claude] [codex]
const { app } = require('electron');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-smoke-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const dist = path.join(__dirname, '../dist-electron/electron');
const wanted = process.argv.slice(2).filter((a) => a === 'claude' || a === 'codex');
const agents = wanted.length ? wanted : ['claude', 'codex'];

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const DRAW = [
  'Use the Aegis design tools (design_guide, design_create, design_update, design_preview).',
  'Read design_guide (topics: structure). Then create a design titled "Smoke test" and add ONE board named "Card", 390 wide and 600 tall:',
  'a simple product card for a calm notes app with a heading, one line of text and a button. Static HTML and inline CSS only.',
  'Then call design_preview on that board once. Do not touch any files. Finish with one short sentence.',
].join(' ');
const FIX = [
  'A design comment is waiting on the "Smoke test" design in this conversation.',
  'Read it with design_comments, make the change with design_update (pass its commentId and a one-line summary),',
  'then answer in the thread with design_reply. Do not touch any files. Finish with one short sentence.',
].join(' ');

async function smoke(agent, info, repo, headersFor) {
  const sessionId = `smoke-${agent}-${Date.now().toString(36)}`;
  const headers = headersFor(sessionId);
  const cwd = fs.mkdtempSync(path.join(temp, `${agent}-`));
  const turn = async (prompt) => {
    if (agent === 'claude') {
      const config = path.join(cwd, 'mcp.json');
      fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'aegis-sessions': { type: 'http', url: info.url, headers } } }));
      return run('claude', [
        '-p', prompt, '--mcp-config', config, '--strict-mcp-config',
        '--allowedTools', 'mcp__aegis-sessions__design_guide,mcp__aegis-sessions__design_create,mcp__aegis-sessions__design_update,mcp__aegis-sessions__design_read,mcp__aegis-sessions__design_preview,mcp__aegis-sessions__design_comments,mcp__aegis-sessions__design_reply',
        '--output-format', 'json',
      ], { cwd, env: { ...process.env } });
    }
    const toml = (v) => JSON.stringify(v);
    const headerTable = `{${Object.entries(headers).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(',')}}`;
    return run('codex', [
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"',
      '-c', `mcp_servers.aegis-sessions.url=${toml(info.url)}`,
      '-c', `mcp_servers.aegis-sessions.http_headers=${headerTable}`,
      prompt,
    ], { cwd, env: { ...process.env } });
  };

  const first = await turn(DRAW);
  const designs = repo.list(sessionId);
  assert.equal(designs.length, 1, `${agent} created one design (exit ${first.code})\n${first.out.slice(-1500)}\n${first.err.slice(-1500)}`);
  const doc = repo.read(sessionId, designs[0].id);
  assert.equal(doc.boards.length, 1, `${agent} drew one board`);
  assert.ok(doc.boards[0].html.length > 200, `${agent}'s board has real content`);
  const author = repo.history(sessionId, doc.id)[0].author;
  assert.equal(author?.kind, 'agent');

  const board = doc.boards[0];
  const comment = repo.comment(sessionId, {
    documentId: doc.id, boardId: board.id, contentRevision: board.contentRevision,
    text: 'Make the button full width.', anchor: { rect: { x: 0, y: 0, width: board.width, height: board.height } },
    id: `c-${agent}`, toAgent: true, author: { kind: 'user', name: 'Smoke' },
  });
  const second = await turn(FIX);
  const thread = repo.comments(sessionId, doc.id).find((c) => c.id === comment.id);
  const after = repo.read(sessionId, doc.id);
  assert.ok(after.revision > doc.revision, `${agent} changed the design for the comment (exit ${second.code})\n${second.out.slice(-1500)}\n${second.err.slice(-1500)}`);
  assert.ok(thread.messages.some((m) => m.author.kind === 'agent'), `${agent} replied in the thread`);
  return { agent, boards: after.boards.length, revision: after.revision, reply: thread.messages.at(-1).text };
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const http = require(`${dist}/libs/session-http-server.js`);
    const { getDesignRepository } = require(`${dist}/design/service.js`);
    const info = await http.ensureSessionHttpServer();
    const headersFor = (sessionId) => ({ Authorization: `Bearer ${info.token}`, 'x-aegis-session': http.sessionCallerValue(info.token, sessionId) });
    const results = [];
    for (const agent of agents) {
      try {
        results.push(await smoke(agent, info, getDesignRepository(), headersFor));
      } catch (error) {
        code = 1;
        results.push({ agent, error: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});

// Config files other tools own are never replaced when Aegis cannot parse
// them, and a write lands in one rename that keeps symlinks, permission bits
// and the fields Aegis does not manage. HOME and the Kimi paths point at temp
// files, so nothing here touches the real ~/.claude.json or friends.
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-config-files-')));
process.env.HOME = join(root, 'home');
process.env.KIMI_CODE_HOME = join(root, 'home', '.kimi-code');
process.env.AEGIS_KIMI_LEGACY_MCP_PATH = join(root, 'home', '.kimi', 'mcp.json');
mkdirSync(process.env.HOME, { recursive: true });

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const mode = (path: string) => statSync(path).mode & 0o777;
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.tmp'));
const server = { type: 'stdio' as const, command: 'npx', args: ['some-mcp'] };

async function main() {
  const { saveMcpServers, saveProjectMcpServers } = await import('../../src/electron/libs/claude-settings');
  const { saveOpencodeProjectMcpServers } = await import('../../src/electron/libs/opencode-mcp-settings');
  const { upsertKimiMcpServerRaw, removeKimiMcpServerRaw } = await import('../../src/electron/libs/kimi-mcp-settings');
  const { ConfigFileUnreadableError } = await import('../../src/electron/libs/json-config-file');

  // ~/.claude.json: fields Aegis does not manage and the file mode survive.
  const claudePath = join(process.env.HOME!, '.claude.json');
  writeFileSync(claudePath, JSON.stringify({ oauthAccount: { email: 'a@b.c' }, projects: { '/p': { allowedTools: ['x'] } } }));
  chmodSync(claudePath, 0o600);
  saveMcpServers({ mine: server });
  saveProjectMcpServers('/p', { local: server });
  const claude = read(claudePath);
  assert.deepEqual(claude.oauthAccount, { email: 'a@b.c' }, 'unmanaged fields are kept');
  assert.deepEqual(claude.projects['/p'].allowedTools, ['x'], 'unmanaged project fields are kept');
  assert.deepEqual(claude.mcpServers.mine, server);
  assert.deepEqual(claude.projects['/p'].mcpServers.local, server);
  assert.equal(mode(claudePath), 0o600, 'the file keeps its permission bits');
  assert.deepEqual(leftovers(process.env.HOME!), [], 'no temp file is left behind');

  // An unparseable or empty file is left exactly as it was.
  for (const broken of ['{"oauthAccount": {"email": "a@b.c"},', '']) {
    writeFileSync(claudePath, broken);
    assert.throws(() => saveMcpServers({ mine: server }), ConfigFileUnreadableError);
    assert.throws(() => saveProjectMcpServers('/p', { local: server }), ConfigFileUnreadableError);
    assert.equal(readFileSync(claudePath, 'utf8'), broken, 'the unreadable file is untouched');
  }
  writeFileSync(claudePath, '[]');
  assert.throws(() => saveMcpServers({ mine: server }), /not an object/);

  // A missing file is created.
  rmSync(claudePath);
  saveMcpServers({ mine: server });
  assert.deepEqual(read(claudePath), { mcpServers: { mine: server } });

  // opencode.json with comments (JSONC) is refused, not flattened.
  const project = join(root, 'project');
  mkdirSync(project);
  const opencodePath = join(project, 'opencode.json');
  const jsonc = '{\n  // my model\n  "model": "x/y"\n}\n';
  writeFileSync(opencodePath, jsonc);
  assert.throws(() => saveOpencodeProjectMcpServers(project, { mine: server }), ConfigFileUnreadableError);
  assert.equal(readFileSync(opencodePath, 'utf8'), jsonc);

  // A symlinked config (dotfiles) is written through; the link stays a link.
  const dotfiles = join(root, 'dotfiles');
  mkdirSync(dotfiles);
  const realOpencode = join(dotfiles, 'opencode.json');
  writeFileSync(realOpencode, JSON.stringify({ model: 'x/y' }));
  rmSync(opencodePath);
  symlinkSync(realOpencode, opencodePath);
  saveOpencodeProjectMcpServers(project, { mine: server });
  assert.ok(lstatSync(opencodePath).isSymbolicLink(), 'the symlink survives');
  const opencode = read(realOpencode);
  assert.equal(opencode.model, 'x/y');
  assert.deepEqual(opencode.mcp.mine, { type: 'local', command: ['npx', 'some-mcp'], enabled: true });
  assert.deepEqual(leftovers(dotfiles), []);

  // Kimi's automatic startup entry never replaces a file it cannot parse.
  const kimiPath = join(process.env.KIMI_CODE_HOME!, 'mcp.json');
  mkdirSync(process.env.KIMI_CODE_HOME!, { recursive: true });
  const brokenKimi = '{"mcpServers": {"mine": {"command": "npx"}},}';
  writeFileSync(kimiPath, brokenKimi);
  const entry = { url: 'http://127.0.0.1:2/mcp', bearerTokenEnvVar: 'AEGIS_BROWSER_USE_TOKEN' };
  assert.throws(() => upsertKimiMcpServerRaw('aegis-browser', entry), ConfigFileUnreadableError);
  assert.throws(() => removeKimiMcpServerRaw('aegis-browser'), ConfigFileUnreadableError);
  assert.equal(readFileSync(kimiPath, 'utf8'), brokenKimi);

  // A readable Kimi file is written 0600 (it can name tokens).
  writeFileSync(kimiPath, JSON.stringify({ mcpServers: { mine: { command: 'npx' } } }));
  chmodSync(kimiPath, 0o644);
  upsertKimiMcpServerRaw('aegis-browser', entry);
  assert.deepEqual(read(kimiPath).mcpServers.mine, { command: 'npx' });
  assert.deepEqual(read(kimiPath).mcpServers['aegis-browser'], entry);
  assert.equal(mode(kimiPath), 0o600);

  rmSync(root, { recursive: true, force: true });
  console.log('provider-config-files: unreadable files untouched, atomic writes keep fields, modes and symlinks passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

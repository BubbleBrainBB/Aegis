import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendComputerUseLiveFrame,
  classifyComputerUseAction,
  COMPUTER_USE_GATEWAY_TOOLS,
  COMPUTER_USE_TOOLS,
  computerUsePreviewWindowPolicy,
  environmentHasComputerUseSection,
  extractComputerUseAppName,
  formatComputerUseGrantLabel,
  formatComputerUseLabel,
  formatComputerUseScreenshotFileName,
  hydrateComputerUseFramesFromMessages,
  isComputerUsePreviewHash,
  isDeniedComputerUseTarget,
  mergeComputerUseLiveFrame,
  mergeHydratedComputerUseFrames,
  parseMcpToolName,
  shouldAcceptComputerUseLive,
} from '../../src/shared/computer-use';
import {
  buildComputerUseMcpOverrideArgs,
  codexFullAccessApprovalPolicy,
  computerUseReadsAskAegis,
  ComputerUseLease,
  injectsComputerUseServer,
  persistComputerUseMedia,
  resolveComputerUseArtifact,
  resolveComputerUseSpawnPolicy,
} from '../../src/electron/libs/codex-computer-use';
import { ComputerUseGrantRegistry } from '../../src/electron/libs/codex-computer-use-grants';
import {
  buildMcpElicitationResponse,
  codexToolApprovalElicitationFixture,
  parseMcpToolApprovalElicitation,
  toolNameFromApprovalMessage,
  wrappedComputerUseElicitationFixture,
} from '../../src/electron/libs/codex-computer-use-elicitation';
import { classifyToolUse, deriveReadableToolDisplay, formatReadableToolSummary } from '../../src/ui/utils/tool-summary';
import { summarizeWorkstreamEntries } from '../../src/ui/utils/workstream-stages';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';

function testClassification() {
  assert.deepEqual(parseMcpToolName('mcp__aegis-computer-use__click'), {
    server: 'aegis-computer-use',
    tool: 'click',
  });

  const click = classifyComputerUseAction({
    toolName: 'mcp__aegis-computer-use__click',
    app: 'Finder',
    title: 'Open the project',
  });
  assert.equal(click?.kind, 'click');
  assert.equal(click?.mutating, true);
  assert.equal(formatComputerUseLabel(click!, 'pending'), 'Open the project');
  assert.equal(
    formatComputerUseLabel({ ...click!, title: null }, 'pending'),
    'Clicking in Finder'
  );

  const script = classifyComputerUseAction({
    toolName: 'mcp__node_repl__js',
    title: 'Inspect apps',
  });
  assert.equal(script?.kind, 'script');
  assert.equal(script?.mutating, true);

  assert.equal(classifyToolUse('mcp__aegis-computer-use__get_app_state', { app: 'Finder' }), 'computer_use');
  assert.equal(classifyToolUse('mcp__pencil__get_screenshot', {}), 'mcp_tool_call');
  assert.equal(
    formatReadableToolSummary(
      deriveReadableToolDisplay(
        'Bash',
        {
          command:
            "/bin/zsh -lc \"sed -n '1,240p' /Users/me/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717/skills/computer-use/SKILL.md\"",
        },
        'success'
      )
    ),
    'Read Computer Use skill'
  );
  assert.equal(isDeniedComputerUseTarget('com.aegis.desktop'), true);
  assert.equal(isDeniedComputerUseTarget('Finder'), false);

  assert.equal(extractComputerUseAppName({ app: 'Finder' }), 'Finder');
  assert.equal(
    extractComputerUseAppName({
      code: 'await sky.click({app:"Notes", id:"AXTextArea"});',
      title: '点击备忘录',
    }),
    'Notes'
  );
  assert.equal(extractComputerUseAppName({ title: '点击备忘录' }), 'Notes');
  assert.equal(
    extractComputerUseAppName({
      __aegisComputerUse: { app: 'Safari', kind: 'click' },
    }),
    'Safari'
  );
  assert.equal(extractComputerUseAppName({ title: 'email the team' }), null);
}

function testElicitationParser() {
  const parsed = parseMcpToolApprovalElicitation('elicitation/create', {
    message: 'Allow Computer Use to click?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_name: 'click',
      tool_title: 'Open the project',
      tool_params: { app: 'Finder', element_index: 4 },
      persist: 'session',
    },
    server: 'aegis-computer-use',
  });
  assert.ok(parsed);
  assert.equal(parsed?.toolName, 'click');
  assert.equal(parsed?.action?.kind, 'click');
  assert.equal(parsed?.persistOptions.includes('session'), true);
  assert.equal(parsed?.deniedTarget, false);

  const denied = parseMcpToolApprovalElicitation('mcpServer/elicitation/request', {
    message: 'Allow Computer Use to click?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_name: 'click',
      tool_params: { app: 'com.aegis.desktop' },
    },
    server: 'aegis-computer-use',
  });
  assert.equal(denied?.deniedTarget, true);

  const unknown = parseMcpToolApprovalElicitation('elicitation/create', {
    message: 'hello',
  });
  assert.equal(unknown, null);

  const wrapped = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-thread',
      tool: 'click',
      app: 'com.apple.finder',
      persist: 'session',
    })
  );
  assert.ok(wrapped);
  assert.equal(wrapped?.toolName, 'click');
  assert.equal(wrapped?.canonicalApp, 'com.apple.finder');
  assert.equal(wrapped?.providerThreadId, 'p-thread');
  assert.equal(wrapped?.turnId, 'turn-cu-1');
  assert.equal(wrapped?.requestType, 'form');
  assert.equal(wrapped?.grantEligible, true);
  assert.equal(wrapped?.persistOptions.includes('session'), true);

  const nodeRepl = parseMcpToolApprovalElicitation('mcpServer/elicitation/request', {
    threadId: 'p-thread',
    serverName: 'node_repl',
    request: {
      type: 'form',
      message: 'Allow node_repl?',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'js',
        tool_params: { code: 'sky.click()' },
      },
    },
  });
  assert.equal(nodeRepl?.isNodeRepl, true);
  assert.equal(nodeRepl?.grantEligible, false);

  const accept = buildMcpElicitationResponse({ allow: true, persist: 'session' });
  assert.equal(accept.action, 'accept');
  assert.deepEqual(accept._meta, { persist: 'session' });
  const decline = buildMcpElicitationResponse({ allow: false });
  assert.equal(decline.action, 'decline');
  assert.equal(decline.content, null);
  assert.equal('_meta' in decline, false);
}

/** The request as codex-cli 0.166.0 really sends it: no tool name but in the question. */
function testRealApprovalRequestShape() {
  assert.equal(toolNameFromApprovalMessage('Allow the aegis-computer-use MCP server to run tool "list_apps"?'), 'list_apps');
  assert.equal(toolNameFromApprovalMessage('Allow the server to run something?'), null);
  assert.equal(toolNameFromApprovalMessage(null), null);

  const read = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    codexToolApprovalElicitationFixture({ threadId: 'p1', tool: 'get_app_state', params: { app: 'Finder' } })
  );
  assert.ok(read);
  assert.equal(read.toolName, 'get_app_state');
  assert.equal(read.server, 'aegis-computer-use');
  assert.equal(read.approvalKind, 'mcp_tool_call');
  assert.equal(read.isComputerUse, true);
  assert.equal(read.action?.kind, 'get_app_state');
  assert.equal(read.action?.mutating, false, 'a look is known to be a look');
  assert.equal(read.providerThreadId, 'p1');
  assert.equal(read.turnId, 'turn-cu-1');

  const click = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    codexToolApprovalElicitationFixture({ threadId: 'p1', tool: 'click', params: { app: 'Finder', element_index: '4' } })
  );
  assert.equal(click?.toolName, 'click');
  assert.equal(click?.action?.mutating, true);
  assert.equal(click?.canonicalApp, 'Finder');
  assert.equal(click?.grantEligible, true, '"until revoked" is offered again for a real request');
  assert.deepEqual(click?.toolParamsDisplay.map((item) => item.name), ['app', 'element_index']);

  // A question that names no tool: unknown, and unknown counts as acting.
  const unnamed = parseMcpToolApprovalElicitation('mcpServer/elicitation/request', {
    ...codexToolApprovalElicitationFixture({ threadId: 'p1', tool: 'click' }),
    message: 'Allow this?',
  });
  assert.equal(unnamed?.toolName, null);
  assert.equal(unnamed?.action?.kind, 'unknown');
  assert.equal(unnamed?.action?.mutating, true);
  assert.equal(unnamed?.grantEligible, false);

  // Another server's tool: an approval, not Computer use.
  const other = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    codexToolApprovalElicitationFixture({ threadId: 'p1', server: 'github', tool: 'create_issue', params: { title: 'x' } })
  );
  assert.equal(other?.isComputerUse, false);
  assert.equal(other?.approvalKind, 'mcp_tool_call');
  assert.equal(other?.toolName, 'create_issue');

  // A name given outright still wins over the sentence.
  const wrapped = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({ threadId: 'p1', tool: 'click', app: 'Finder', message: 'Allow the x MCP server to run tool "list_apps"?' })
  );
  assert.equal(wrapped?.toolName, 'click');
}

function testOverridesAndLease() {
  assert.equal(resolveComputerUseSpawnPolicy({ permissionMode: 'defaultPermissions' }), 'mutating');
  assert.equal(resolveComputerUseSpawnPolicy({ permissionMode: 'auto' }), 'mutating');
  assert.equal(resolveComputerUseSpawnPolicy({ permissionMode: 'fullAccess' }), 'mutating');
  assert.equal(
    resolveComputerUseSpawnPolicy({ permissionMode: 'fullAccess', executionMode: 'execute' }),
    'mutating'
  );
  assert.equal(
    resolveComputerUseSpawnPolicy({ permissionMode: 'fullAccess', executionMode: 'plan' }),
    'read-only'
  );

  const readOnly = buildComputerUseMcpOverrideArgs({
    clientPath: '/tmp/SkyComputerUseClient',
    policy: 'read-only',
    hasNodeRepl: true,
  });
  const joined = readOnly.join(' ');
  assert.equal(joined.includes('mcp_servers.computer-use.enabled=false'), true);
  assert.equal(joined.includes('mcp_servers.aegis-computer-use.default_tools_approval_mode="writes"'), true);
  assert.equal(joined.includes('"list_apps"'), true);
  assert.equal(joined.includes('"click"'), false);
  assert.equal(joined.includes('mcp_servers.node_repl.disabled_tools=["js", "js_add_node_module_dir"]'), true);

  // The two read tools ask before they run, each by its own setting; the
  // tools that act keep the server's "writes". (A server-wide "prompt" would
  // also work for the reads, but changes what the acting tools send.)
  const READS_ASK = [
    'mcp_servers.aegis-computer-use.tools.list_apps.approval_mode="prompt"',
    'mcp_servers.aegis-computer-use.tools.get_app_state.approval_mode="prompt"',
  ];
  assert.deepEqual(readOnly.filter((arg) => arg.includes('.approval_mode="prompt"')), READS_ASK, 'Plan: reads ask');
  const mutatingArgs = buildComputerUseMcpOverrideArgs({
    clientPath: '/tmp/SkyComputerUseClient',
    policy: 'mutating',
    hasNodeRepl: true,
  });
  assert.deepEqual(mutatingArgs.filter((arg) => arg.includes('.approval_mode="prompt"')), READS_ASK, 'Default and Full Access: reads ask');
  assert.equal(mutatingArgs.filter((arg) => arg.includes('default_tools_approval_mode="prompt"')).length, 0);
  assert.ok(mutatingArgs.includes('mcp_servers.aegis-computer-use.default_tools_approval_mode="writes"'));
  // Auto mode: Codex's own reviewer would answer instead of Aegis, so reads do not ask there.
  assert.equal(computerUseReadsAskAegis('auto'), false);
  for (const mode of ['defaultPermissions', 'fullAccess', undefined, null]) assert.equal(computerUseReadsAskAegis(mode), true);
  const autoArgs = buildComputerUseMcpOverrideArgs({
    clientPath: '/tmp/SkyComputerUseClient',
    policy: 'mutating',
    hasNodeRepl: false,
    readsAsk: false,
  });
  assert.deepEqual(autoArgs.filter((arg) => arg.includes('approval_mode="prompt"')), []);
  // Without the client there is no server, and nothing to ask about.
  const absent = buildComputerUseMcpOverrideArgs({ clientPath: null, policy: 'mutating', hasNodeRepl: false });
  assert.deepEqual(absent.filter((arg) => arg.includes('approval_mode')), []);
  assert.equal(injectsComputerUseServer(absent), false);
  assert.equal(injectsComputerUseServer(mutatingArgs), true);
  assert.equal(injectsComputerUseServer(readOnly), true);

  // Full Access: "never" would let Codex approve Computer use calls without
  // Aegis hearing of them. With the server injected, tool approvals of MCP
  // servers are the one thing that reaches the client; every other category
  // stays off, as "never" has it.
  assert.equal(codexFullAccessApprovalPolicy(false), 'never');
  assert.deepEqual(codexFullAccessApprovalPolicy(true), {
    granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true },
  });

  const mutating = mutatingArgs.join(' ');
  assert.equal(mutating.includes('"click"'), true);
  // Codex's own client has select_text (its tools/list says so) and keeps it;
  // the cua-driver gateway, which cannot do it, does not offer it.
  assert.equal(mutating.includes('"select_text"'), true);
  assert.equal((COMPUTER_USE_GATEWAY_TOOLS as readonly string[]).includes('select_text'), false);
  assert.deepEqual(
    COMPUTER_USE_TOOLS.filter((tool) => !(COMPUTER_USE_GATEWAY_TOOLS as readonly string[]).includes(tool)),
    ['select_text']
  );
  assert.equal(mutating.includes('disabled_tools=["js_add_node_module_dir"]'), true);

  // The lease is held per action. A session that has acted keeps the desktop
  // when a later action of its own is dropped (a declined approval), until
  // its turn ends.
  const lease = new ComputerUseLease();
  assert.equal(lease.tryAcquire('thread-a', 'call-1'), true);
  assert.equal(lease.tryAcquire('thread-b', 'call-2'), false);
  assert.equal(lease.tryAcquire('thread-a', 'call-3'), true);
  assert.deepEqual(lease.currentOwner(), { threadId: 'thread-a', toolUseId: 'call-3' });
  lease.release('thread-a', 'call-3');
  assert.equal(lease.holds('thread-a', 'call-1'), true, 'the first action still holds the desktop');
  assert.equal(lease.holds('thread-a', 'call-3'), false);
  assert.deepEqual(lease.currentOwner(), { threadId: 'thread-a', toolUseId: 'call-1' });
  assert.deepEqual(lease.actionsOf('thread-a'), ['call-1']);
  assert.deepEqual(lease.actionsOf('thread-b'), []);
  assert.equal(lease.heldByAnother('thread-b'), true);
  assert.equal(lease.heldByAnother('thread-a'), false);
  assert.equal(lease.tryAcquire('thread-b', 'call-4'), false, 'dropping one action does not free the desktop');
  lease.release('thread-b', 'call-4');
  assert.equal(lease.currentOwner()?.threadId, 'thread-a', "another session cannot release what it does not hold");
  lease.release('thread-a', 'call-1');
  assert.equal(lease.currentOwner(), null, 'the last action dropped frees it');
  assert.equal(lease.tryAcquire('thread-b', 'call-4'), true);
  lease.releaseThread('thread-b');
  assert.equal(lease.tryAcquire('thread-a', 'call-5'), true);
  lease.release('thread-a');
  assert.equal(lease.currentOwner(), null, 'no id: every action of the session');
}

function testMediaSidecar() {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-media-'));
  try {
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBIVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAECBQYAB//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAhEAACAgICAwEBAAAAAAAAAAABAgADEQQSITEFQ Rig/9oACAEBAAE/AN7n/9k=',
      'base64'
    );
    const payload = [
      { type: 'text', text: 'Finder windows' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    ];
    const persisted = persistComputerUseMedia({
      userDataDir: dir,
      sessionId: 'session-1',
      payload,
    });
    assert.equal(persisted.text, 'Finder windows');
    assert.equal(persisted.mediaRefs.length, 1);
    assert.equal(persisted.mediaRefs[0].sessionId, 'session-1');
    assert.equal(persisted.text.includes('data:image'), false);
    const resolved = resolveComputerUseArtifact(dir, 'session-1', persisted.mediaRefs[0].sha256);
    assert.ok(resolved);
    const saved = readFileSync(resolved!.path);
    assert.equal(resolveComputerUseArtifact(dir, '../escape', persisted.mediaRefs[0].sha256), null);
    assert.equal(resolveComputerUseArtifact(dir, 'session-1', 'not-a-hash'), null);
    assert.ok(saved.length > 0);

    // The trusted root is the profile's one artifact folder: a session id that
    // is not a plain name, or a session folder that is a link out of it, is
    // refused for reading and for writing.
    const sha = persisted.mediaRefs[0].sha256;
    const artifacts = join(dir, 'computer-use-artifacts');
    for (const id of ['.', '..', 'a/b', '']) {
      assert.equal(resolveComputerUseArtifact(dir, id, sha), null, `read "${id}"`);
      assert.deepEqual(persistComputerUseMedia({ userDataDir: dir, sessionId: id, payload }).mediaRefs, [], `write "${id}"`);
    }
    assert.deepEqual(readdirSync(artifacts), ['session-1'], 'nothing was written beside the session folder');
    const outside = mkdtempSync(join(tmpdir(), 'aegis-cu-outside-'));
    try {
      symlinkSync(outside, join(artifacts, 'linked'));
      assert.deepEqual(persistComputerUseMedia({ userDataDir: dir, sessionId: 'linked', payload }).mediaRefs, []);
      assert.deepEqual(readdirSync(outside), [], 'a linked session folder is never written through');
      writeFileSync(join(outside, `${sha}.jpg`), saved);
      assert.equal(resolveComputerUseArtifact(dir, 'linked', sha), null, 'nor read through');
      // A file under the right name that is a link elsewhere is not followed either.
      const real = join(artifacts, 'session-1', `${sha}.jpg`);
      unlinkSync(real);
      symlinkSync(join(outside, `${sha}.jpg`), real);
      assert.equal(resolveComputerUseArtifact(dir, 'session-1', sha), null);
      // And writing does not go through it: the linked file keeps its bytes.
      writeFileSync(join(outside, `${sha}.jpg`), 'not the image');
      assert.equal(persistComputerUseMedia({ userDataDir: dir, sessionId: 'session-1', payload }).mediaRefs.length, 1);
      assert.equal(readFileSync(join(outside, `${sha}.jpg`), 'utf8'), 'not the image');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    // The artifact folder itself: when it is a link (to a folder outside the
    // profile, or anywhere), nothing is read or written through it, whatever
    // the session folder under it looks like.
    const profile = mkdtempSync(join(tmpdir(), 'aegis-cu-profile-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'aegis-cu-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(profile, 'computer-use-artifacts'));
      assert.deepEqual(persistComputerUseMedia({ userDataDir: profile, sessionId: 'session-1', payload }).mediaRefs, []);
      assert.deepEqual(readdirSync(elsewhere), [], 'a linked artifact folder is never written through');
      // Even with a real session folder and the right file waiting behind the link.
      mkdirSync(join(elsewhere, 'session-1'));
      writeFileSync(join(elsewhere, 'session-1', `${sha}.jpg`), saved);
      assert.equal(resolveComputerUseArtifact(profile, 'session-1', sha), null, 'nor read through');
      assert.deepEqual(persistComputerUseMedia({ userDataDir: profile, sessionId: 'session-2', payload }).mediaRefs, []);
      assert.deepEqual(readdirSync(elsewhere), ['session-1']);
      // A file where the folder should be is not a folder either.
      // unlinkSync, not rmSync: Node 23.9 refuses to rmSync a link to a folder.
      unlinkSync(join(profile, 'computer-use-artifacts'));
      writeFileSync(join(profile, 'computer-use-artifacts'), '');
      assert.deepEqual(persistComputerUseMedia({ userDataDir: profile, sessionId: 'session-1', payload }).mediaRefs, []);
      // Put right again, it works: the check is made each time, nothing is remembered.
      unlinkSync(join(profile, 'computer-use-artifacts'));
      const again = persistComputerUseMedia({ userDataDir: profile, sessionId: 'session-1', payload });
      assert.equal(again.mediaRefs.length, 1);
      assert.ok(resolveComputerUseArtifact(profile, 'session-1', sha));
      // The profile folder itself may be reached through a link (as /tmp is on macOS): it is where the app keeps its data.
      const viaLink = join(elsewhere, 'profile-link');
      symlinkSync(profile, viaLink);
      assert.ok(resolveComputerUseArtifact(viaLink, 'session-1', sha));
    } finally {
      rmSync(profile, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testWorkstreamStage() {
  const click: Extract<WorkstreamEntry, { type: 'tool' | 'memory' }> = {
      id: 'cu-1',
      type: 'tool',
      toolName: 'mcp__aegis-computer-use__click',
      kind: 'computer_use',
      summary: 'Clicking in Finder',
      status: 'success',
      block: {
        type: 'tool_use',
        id: 'cu-1',
        name: 'mcp__aegis-computer-use__click',
        input: { app: 'Finder' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'cu-1',
        content: 'ok',
      },
  };
  const entries: WorkstreamEntry[] = [click];
  const stages = summarizeWorkstreamEntries(entries);
  assert.equal(stages[0]?.kind, 'computer_use');
  assert.equal(stages[0]?.defaultExpanded, false);
  assert.equal(stages[0]?.title, 'Clicking in Finder');
  assert.equal(stages[0]?.computerUseApp, 'Finder');

  const grouped = summarizeWorkstreamEntries([
    click,
    {
      ...click,
      id: 'cu-2',
      summary: 'Typing in Notes',
      block: { ...click.block, id: 'cu-2', name: 'mcp__aegis-computer-use__type_text' },
      result: { type: 'tool_result', tool_use_id: 'cu-2', content: 'ok' },
    },
  ]);
  assert.equal(grouped.length, 2, 'each Computer Use action should be its own stage row');
  assert.equal(grouped[0]?.title, 'Clicking in Finder');
  assert.equal(grouped[1]?.title, 'Typing in Notes');

  const nodeRepl = summarizeWorkstreamEntries([
    {
      id: 'cu-js',
      type: 'tool',
      toolName: 'mcp__node_repl__js',
      kind: 'computer_use',
      summary: '点击备忘录',
      status: 'success',
      block: {
        type: 'tool_use',
        id: 'cu-js',
        name: 'mcp__node_repl__js',
        input: {
          code: 'await sky.type_text({app:"Notes", text:"hello"});',
          title: '点击备忘录',
        },
      },
      result: { type: 'tool_result', tool_use_id: 'cu-js', content: 'ok' },
    },
  ]);
  assert.equal(nodeRepl[0]?.computerUseApp, 'Notes');
}

function testGrants() {
  const registry = new ComputerUseGrantRegistry();
  const clickFinder = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'click',
      app: 'com.apple.finder',
    })
  );
  assert.ok(clickFinder?.grantEligible);
  const grant = registry.createFromElicitation({
    threadId: 't1',
    generation: 1,
    elicitation: clickFinder!,
  });
  assert.ok(grant);
  assert.equal(formatComputerUseGrantLabel('click', 'com.apple.finder'), 'Allow click in com.apple.finder until revoked');
  assert.ok(
    registry.match({ threadId: 't1', generation: 1, elicitation: clickFinder! }),
    'same app+tool should match'
  );

  const clickChrome = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'click',
      app: 'com.google.Chrome',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: clickChrome! }), null);

  const typeFinder = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'type_text',
      app: 'com.apple.finder',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: typeFinder! }), null);

  const descendant = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-child',
      tool: 'click',
      app: 'com.apple.finder',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: descendant! }), null);
  assert.equal(registry.match({ threadId: 't1', generation: 2, elicitation: clickFinder! }), null);

  registry.revokeThread('t1');
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: clickFinder! }), null);
}

function testHydrateFramesFromHistory() {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);
  const messages = [
    {
      type: 'assistant',
      createdAt: 10,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'u1',
            name: 'mcp__aegis-computer-use__get_app_state',
            input: { app: 'Notes' },
          },
        ],
      },
    },
    {
      type: 'user',
      createdAt: 11,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'u1',
            content: 'ok',
            mediaRefs: [
              { sessionId: 'session-1', sha256: shaA, mimeType: 'image/png', sizeBytes: 12 },
            ],
          },
        ],
      },
    },
    {
      type: 'user',
      createdAt: 12,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'u1',
            content: 'ok',
            mediaRefs: [
              { sessionId: 'session-1', sha256: shaB, mimeType: 'image/png', sizeBytes: 14 },
            ],
          },
        ],
      },
    },
  ];

  const hydrated = hydrateComputerUseFramesFromMessages({ sessionId: 'session-1', messages });
  assert.equal(hydrated.length, 2);
  assert.equal(hydrated[0]?.media?.sha256, shaA);
  assert.equal(hydrated[1]?.media?.sha256, shaB);
  assert.equal(hydrated[0]?.app, 'Notes');
  assert.equal(environmentHasComputerUseSection({ frames: hydrated, grants: [] }), true);

  const live = {
    threadId: 'session-1',
    toolUseId: 'live',
    label: 'Clicking in Notes',
    app: 'Notes',
    tool: 'click',
    mutating: true,
    media: { sessionId: 'session-1', sha256: shaB, mimeType: 'image/png', sizeBytes: 14 },
    hasFreshMedia: true,
    at: 99,
  };
  const merged = mergeHydratedComputerUseFrames([live], hydrated);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((frame) => frame.media?.sha256 === shaB)?.label, 'Clicking in Notes');
  assert.equal(environmentHasComputerUseSection({ frames: [], grants: [] }), false);
}

function testEnvironmentFilmstripVisibility() {
  assert.equal(environmentHasComputerUseSection({ frames: [], grants: [] }), false);
  assert.equal(environmentHasComputerUseSection({ frames: [{ media: null }], grants: [] }), false);
  assert.equal(
    environmentHasComputerUseSection({
      frames: [
        {
          media: { sessionId: 's1', sha256: 'abc', mimeType: 'image/png', sizeBytes: 12 },
        },
      ],
      grants: [],
    }),
    true
  );
  assert.equal(
    environmentHasComputerUseSection({
      frames: [],
      grants: [{ key: 'g1' }],
    }),
    true
  );
  assert.equal(
    formatComputerUseScreenshotFileName({ app: 'Notes', mimeType: 'image/png', index: 1 }),
    'Notes-1.png'
  );
  assert.equal(
    formatComputerUseScreenshotFileName({ app: '备忘录', mimeType: 'image/jpeg', index: 2 }),
    'Notes-2.jpg'
  );
}

function testLiveFrameMerge() {
  const first = {
    threadId: 't1',
    toolUseId: 'u1',
    label: 'Looking at Finder',
    app: 'Finder',
    tool: 'get_app_state',
    mutating: false,
    media: { sessionId: 's1', sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 8 },
    hasFreshMedia: true,
    at: 1,
  };
  const second = {
    ...first,
    toolUseId: 'u2',
    label: 'Clicking in Finder',
    tool: 'click',
    mutating: true,
    media: { sessionId: 's1', sha256: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 8 },
    at: 2,
  };
  const labelOnly = {
    ...second,
    hasFreshMedia: false,
    label: 'Clicked in Finder',
    at: 3,
  };

  const frames = appendComputerUseLiveFrame(appendComputerUseLiveFrame([], first), second);
  assert.equal(frames.length, 2);
  assert.equal(appendComputerUseLiveFrame(frames, labelOnly).length, 2);
  assert.equal(mergeComputerUseLiveFrame(second, labelOnly).label, 'Clicked in Finder');
  assert.equal(mergeComputerUseLiveFrame(second, labelOnly).media?.sha256, 'b'.repeat(64));
}

function testPreviewWindowPolicy() {
  const policy = computerUsePreviewWindowPolicy();
  assert.equal(policy.alwaysOnTop, false);
  assert.equal(policy.fullscreenable, false);
  assert.equal(policy.modal, false);
  assert.equal(policy.type, null);
  assert.equal(policy.visibleOnAllWorkspaces, false);
  assert.equal(policy.hasParent, true);
  assert.equal(isComputerUsePreviewHash('#computer-use-preview'), true);
  assert.equal(isComputerUsePreviewHash('#/computer-use-preview'), true);
  assert.equal(isComputerUsePreviewHash('#settings'), false);
  assert.equal(shouldAcceptComputerUseLive('running'), true);
  assert.equal(shouldAcceptComputerUseLive('stopping'), false);
  assert.equal(shouldAcceptComputerUseLive('idle'), false);
}

function testPreviewSourceWiring() {
  const root = join(process.cwd());
  const preview = readFileSync(join(root, 'src/electron/libs/computer-use-preview-window.ts'), 'utf8');
  assert.match(preview, /parent/);
  assert.match(preview, /alwaysOnTop: policy\.alwaysOnTop/);
  assert.equal(preview.includes("type: 'panel'"), false);
  assert.equal(preview.includes('screen-saver'), false);
  assert.equal(preview.includes('setAlwaysOnTop'), false);
  assert.match(preview, /COMPUTER_USE_PREVIEW_HASH/);

  const mainUi = readFileSync(join(root, 'src/ui/main.tsx'), 'utf8');
  assert.match(mainUi, /ComputerUsePreviewApp/);
  assert.match(mainUi, /isComputerUsePreviewHash/);

  const hud = readFileSync(join(root, 'src/ui/components/ComputerUseLiveHud.tsx'), 'utf8');
  assert.match(hud, /Pop out/);
  assert.match(hud, /openComputerUsePreview/);
  assert.match(hud, /stopComputerUse/);

  const previewApp = readFileSync(join(root, 'src/ui/components/ComputerUsePreviewApp.tsx'), 'utf8');
  assert.match(previewApp, /stopComputerUse/);

  const env = readFileSync(join(root, 'src/ui/components/environment/EnvironmentComputerUseSection.tsx'), 'utf8');
  assert.match(env, /Pop out/);
  assert.match(env, /openComputerUsePreview/);
  assert.match(env, /formatComputerUseScreenshotFileName/);
  assert.equal(env.includes('ComputerUseFilmstrip'), false);
  assert.equal(env.includes('ComputerUseSelectedFrame'), false);

  const store = readFileSync(join(root, 'src/ui/store/useAppStore.ts'), 'utf8');
  assert.match(
    store,
    /computerUseLive: shouldAcceptComputerUseLive\(status\) \? session\.computerUseLive : null/,
    'turn completion must hide the live HUD'
  );
  assert.match(store, /computerUseFrames: existing\?\.computerUseFrames/);
  assert.match(store, /hydrateComputerUseFramesFromMessages/);
  assert.match(store, /framesFromComputerUseHistory/);
  assert.match(store, /closeComputerUsePreview/);

  const ipc = readFileSync(join(root, 'src/electron/ipc-handlers.ts'), 'utf8');
  const finish = ipc.slice(ipc.indexOf('function finishComputerUseUi'));
  const stoppedAt = finish.indexOf("type: 'computerUse.stopped'");
  const closeAt = finish.indexOf('stopComputerUsePreviewIfSession');
  assert.ok(stoppedAt >= 0 && closeAt >= 0 && stoppedAt < closeAt, 'Stop must hide HUD before closing the preview window');
  assert.match(ipc, /read-computer-use-app-icon/);

  const workstream = readFileSync(join(root, 'src/ui/components/AssistantWorkstream.tsx'), 'utf8');
  assert.match(workstream, /ComputerUseAppIcon/);
  assert.equal(
    /kind === 'computer_use'\) return <Monitor/.test(workstream),
    false,
    'Computer Use rows should use the target app icon, not a generic monitor'
  );
}

testClassification();
testElicitationParser();
testRealApprovalRequestShape();
testOverridesAndLease();
testMediaSidecar();
testWorkstreamStage();
testGrants();
testHydrateFramesFromHistory();
testEnvironmentFilmstripVisibility();
testLiveFrameMerge();
testPreviewWindowPolicy();
testPreviewSourceWiring();
console.log('codex computer-use unit tests passed');

# Computer use across providers

Computer use (desktop actions through `cua-driver`) is one service in the main
process: the **Computer use gateway**, `src/electron/libs/computer-use/service.ts`.
It holds the lease (one session has the desktop at a time, shared with Codex's
own Computer use), asks with the COMPUTER USE card and keeps the grants,
validates every argument, refuses Aegis itself as a target, holds Plan mode to
looking, and owns the driver process. This page says how each agent harness
reaches that gateway, and which ones do not.

No provider is handed `cua-driver` or its MCP server, and no provider has a
gateway of its own. `verify:computer-use-providers` pins that.

## Working in a background window

Use `list_windows` to find the document title, then pass its `window_id` to `get_app_state` and subsequent actions.
An explicit ID that no longer exists fails the read. Supply `query`, `max_elements` or `include_screenshot: false` to narrow a read.
`zoom` returns a crop in full-window pixel coordinates. `invoke_menu` takes a native menu path and requires background delivery.
`verify_state` checks the selected window for a control and returns the driver's verdict. Check for `satisfied` before reporting success.
macOS resolves native menu commands through the application's document menu. A background window outside that context can be refused. Verify the resulting document state after dispatch.
Stopping Computer Use releases the gateway's desktop control for the rest of the turn. The agent can continue its conversation.

The chat shows the current Computer Use action under the assistant's message. The picture-in-picture preview streams the observed macOS window after a screenshot arrives. If capture is unavailable or a provider supplies only screenshots, it shows the latest frame. Hover or focus the preview for placement and Stop controls. Click the image to open the floating preview. When the turn ends, its preview controls disappear. Saved screenshots can be viewed by expanding the corresponding tool result in the chat.

Run `npm run verify:computer-use-preview` on macOS to exercise the chat and detached preview against an isolated window, including live changes, resizing, docking and Stop.
Run `npm run verify:computer-use-windows-live` on macOS for the two-document acceptance test.
Append `-- <provider>` to exercise a real model on its configured account against the same isolated windows.
For the signed macOS build, run `ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Aegis" scripts/tests/computer-use-windows-live.mjs` from the repository.
Run `node scripts/tests/computer-use-windows-live.mjs signed-ui "$APP/Contents/MacOS/Aegis"` for the signed application's Settings IPC, approval and Stop flow with Claude. Append `opencode` to run the same flow with OpenCode. The test uses a temporary profile and project, checks both documents after each turn, and presses Stop between turns to verify that the next approved edit succeeds.

## The three ways in

| Way in | Who | Where |
| --- | --- | --- |
| Host tools, bound to the session by closure | Bubble | `bubble-computer-use-tool.ts` |
| Custom tools, bound to the session by closure | Pi | `computer-use/provider-mcp.ts` (`createPiComputerUseTools`) |
| The gateway's **MCP bridge**: a loopback MCP server whose every request is bound to one session | DeepSeek, MiniMax, MiMo, Devin, Grok, Qoder, Claude, OpenCode | `computer-use/mcp-bridge.ts`, `computer-use/provider-mcp.ts` |

Codex keeps its own Computer use client (`codex-computer-use.ts`) and shares
only the lease and the grant registry, as before. Kimi and Antigravity get
none; the reasons are below.

### The MCP bridge

`ComputerUseMcpBridge` is a transport and nothing else: `tools/list` gives the
gateway's thirteen tools with the gateway's own schemas, and `tools/call` is
`gateway.call(...)`. What it adds is the one thing the gateway cannot know by
itself, which session is calling:

- A runtime is handed a URL and headers when it starts. The headers carry a
  bearer token and a random **capability** that names exactly one Aegis
  session (`bindSession`), or, for a runtime that serves many sessions from
  one MCP configuration, a resolver that reads the session from each request's
  `_meta` (`bindResolver`, OpenCode).
- A request without a valid capability is refused before anything is listed
  or run (401 / 403). A call the resolver cannot place is not run.
- **There is no guessing from transcripts.** Browser Use falls back to
  matching a pending tool call in a session's history for providers with a
  process-global MCP configuration. A desktop action attributed to the wrong
  session would ask the wrong conversation and take the wrong lease, so the
  bridge has no such fallback.
- The capability ends with the runtime: the adapter disposes it when the
  agent process exits or the SDK query closes, and calls of it still on their
  way end with it (their approval card is taken down, their hold on the
  desktop goes back).
- A provider that gives up on a call says so with an MCP `cancelled`
  notification, which arrives on another HTTP request than the call; the
  bridge matches it by capability and request id. A closed connection ends the
  call too.
- An MCP client waits for the HTTP response of its call, and the common ones
  give up after five minutes without response headers. The bridge ends the
  call and answers in words after 4.5 minutes
  (`COMPUTER_USE_MCP_CALL_DEADLINE_MS`), which in practice means an approval
  card nobody answered. Bubble and Pi, which do not go through HTTP, keep the
  gateway's ten minutes.

The server name `aegis-computer-use` is Aegis's. Adapters that merge the
user's own MCP servers (DeepSeek, Claude) drop a user entry of that name before
handing servers over, with the switch on or off.

### What every provider gets from the gateway unchanged

- The lease, per action, shared across all of them and with Codex.
- The COMPUTER USE card in the session's own conversation, with the app and
  the element on it, and "until revoked" grants per app.
- Plan mode: looking only. `computer-use/session-modes.ts` maps each
  provider's own Plan mode to the gateway's one rule.
- Full Access (where `isSessionFullAccess` knows the provider's mode):
  actions run without the card; everything else still applies.
- Read-only workflow members get no tools, and are refused if they call.
- The HUD, the Environment screenshot strip and the tool cards. The agent
  loop passes every provider's transcript through `ComputerUseTranscript`,
  which gives gateway tool calls their one name
  (`mcp__aegis-computer-use__<tool>`, whatever the provider's own spelling)
  and files each call's saved screenshots with its result.
- The switch in Settings. Runtimes are handed their tools when they start, so
  flipping the switch retires idle runtimes of these providers
  (`flushComputerUseRunners`) and each session gets the new answer with its
  next turn. A call made after the switch went off is refused by the gateway
  whatever the runtime still lists.

### The provider's own approval layer

Some agents ask before every MCP tool call. The gateway decides Computer use
calls itself, and asking twice for one click only teaches people to click
through, so the adapter answers the provider's own question for gateway tools
(`gatewayApprovalOption`, `isGatewayToolCall`). It does so only when:

- this session's runtime was handed the gateway's entry and has reached the
  server with it. Without an entry (the switch is off, a read-only member),
  the same tool name is some other MCP server's and gets the provider's
  ordinary card;
- the request names a gateway tool of that server; and
- for ACP agents, the provider offers "allow once". Nothing wider is ever
  picked, so the provider goes on asking and the gateway goes on deciding.

## Per provider

The two-window test exercises a real model, Aegis's tool binding, and the macOS driver.
The provider fixture restricts calls to the synthetic target, checks the model's three successful calls, and independently rereads both documents. Gateway and bridge tests exercise wrong window IDs and cross-session requests directly.
The older adapter probes use a scripted driver. Codex uses its own client.

| Provider | Way in | Binding | Own approval for MCP tools | Screenshot to the model | Plan | Full Access | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bubble | host tools | closure | answered by the adapter (PR #208) | image | yes | yes | Two-window test passed |
| DeepSeek | bridge, per runtime (`cordis.yml` of that runtime) | capability | none (no approval channel) | image, when the model takes images; the file path always | no Plan mode | `danger-full-access` | Two-window test passed |
| MiniMax Code | bridge, ACP `session/new` | capability | none seen (mcode 0.6.12, Ask mode) | file path | yes | `bypassPermissions` | Two-window test passed |
| MiMo Code | bridge, ACP `session/new` | capability | none (Aegis's permission config asks for edit/bash/webfetch only) | file path | yes | `build` | Scripted-driver probe passed previously. Real-driver model turn blocked by an invalid API key. |
| Devin | bridge, ACP `session/new` | capability | **asks for every MCP call, reads too**: answered by the adapter | file path | yes | `bypass` | Two-window test passed |
| Grok Build | bridge, ACP `session/new` | capability | unknown; the adapter answers if it asks | file path | yes | card always | Scripted-agent integration passed. Real-model request returned HTTP 402 (exhausted balance). |
| Qoder | bridge, `query({ mcpServers })` | capability | **asks for every MCP call**: answered by the adapter (not in Don't Ask, which denies) | file path | yes | `bypassPermissions` | Two-window test passed |
| Claude | bridge, `query({ mcpServers })` | capability | `canUseTool` lets MCP tools through | image | yes | Full access | Two-window SDK test passed. Signed app passed switch, Stop, approval and grant revocation across four turns. |
| Pi | custom tools | closure | none (Pi has no approval) | image | no Plan mode | card always | Two-window test passed |
| OpenCode | bridge, the server's inline config | resolver: `_meta['ai.opencode/sessionID']`, as Browser Use | none expected (asks are limited to edit/shell/webfetch) | file path | yes | card always | Two-window test passed with deepseek/deepseek-flash. The same model passed the four-turn signed app test. |
| Codex | its own client | — | — | — | — | — | unchanged |
| **Kimi** | **none** | — | — | — | — | — | not supported for now, see below |
| **Antigravity** | **none** | — | — | — | — | — | not supported, see below |

Notes:

- "Card always" for Grok, Pi and OpenCode: `isSessionFullAccess` has no
  Full Access mode for them (Kimi `yolo`, Grok `yolo` and OpenCode
  `fullAccess` are not mapped there today), so the gateway always asks. That
  is the safe side and was left as it is.
- "File path": the result text names the saved screenshot file instead of
  carrying an image block. An MCP client that does not understand image
  blocks drops them at best and pastes base64 into the context at worst, so
  `inline` is used only where it was seen to work (DeepSeek, Claude).
- Workflow members: MiniMax, MiMo, Devin, Claude and Pi give workflow members
  none of Aegis's tools, so none of these either. DeepSeek, Grok and Qoder
  give them to members that are not read-only, as Bubble does.

### Kimi: not supported for now, on purpose

Kimi's server runtime (`kimi web`, what new Kimi sessions run on) takes MCP
servers only from its user-level `mcp.json`: one configuration for the whole
daemon and every session it serves. Its REST API manages that file
(`/mcp/servers`) and has no per-session entry (checked on kimi 2.3.1), and its
MCP requests carry nothing that names the calling session. Aegis's Browser
Use and widget tools live with that by matching a pending tool call in the
sessions' histories.

For desktop control that is not good enough: the lease and the approval card
are per session, and the binding has to be something the model cannot
influence. So Kimi is handed no Computer use entry at all (nothing is written
to `mcp.json`), and a Kimi session has no Computer use tools.

Decided 2026-11-22: Kimi stays without Computer use for now. Binding its
calls by matching the sessions' histories, the weaker way its browser tools
use, was considered and turned down for desktop control. It is looked at
again once Kimi's runtime can bind a call to a session.

What would make that possible: a per-session MCP entry in Kimi's server API (the
core has `addSessionMcpServer`, the REST surface does not expose it), a
session id in its MCP request metadata (then `bindResolver` fits, as for
OpenCode), or moving Kimi to its ACP runtime, which takes `mcpServers` per
session but lacks steer, usage and subagents (see
`docs/kimi-server-adapter-plan.md`).

### Antigravity: not supported

`agy acp` (1.5.14) advertises no MCP capability, so it takes no HTTP MCP
server, and its adapter starts every session with `mcpServers: []`. It has no
tool channel of Aegis's own either: under the terms of a personal Google
sign-in only a person may drive it (`src/shared/human-driven-providers.ts`),
and none of Aegis's tools are handed to it. So there is nothing to bind a
Computer use call to, and an Antigravity session has no Computer use tools.
If `agy` gains MCP over ACP, it follows the path of the other ACP agents.

## Tests and probes

In CI:

- `verify:computer-use` — the gateway, and now the bridge: transport and
  capabilities, cross-agent lease (bridge sessions, a host-tool session and
  Codex before one lease, both ways, with a card open, simultaneous actions),
  cancellation and disconnects, the call deadline, the resolver, screenshots
  into the transcript, provider tool names, the provider approval layer, Plan
  per provider.
- `verify:computer-use-providers` — the four real ACP adapters against a
  scripted agent that makes real MCP calls to the bridge; session entries
  (Claude, Qoder), the shared-server entry (OpenCode) and Pi's tools against
  the app's gateway; source checks for the adapters that cannot run in a test.
- `verify:deepseek-computer-use` — the real DeepSeek adapter and Harness
  runtime against a mock model: tools, look, action behind the card, Bubble
  shut out by the lease, screenshots in the transcript, Stop with a card open,
  no server for sessions without Computer use.

By hand (each makes one small real model request on your account):

- `npm run probe:computer-use-acp -- minimax|mimo|devin|grok [inline]`
- `npm run probe:computer-use-adapters -- qoder|opencode|pi`
- `npm run verify:computer-use-live` — the real driver on Calculator.

Run the probes again after upgrading one of these CLIs or SDKs: how an agent
names MCP tools and whether it asks its own approval are theirs to change.

## Adding a provider

1. Find how its runtime takes MCP servers for one session. If it can only
   take them process-wide and its requests name no session, stop: see Kimi.
2. Hand it `createComputerUseMcpEntry` / `createComputerUseAcpEntry` /
   `createComputerUseSessionEntry` under `AEGIS_COMPUTER_USE_SERVER_NAME`, and
   dispose the entry with the runtime.
3. Add its Plan mode to `session-modes.ts` and, if it has one, its Full Access
   mode to `isSessionFullAccess`.
4. Run a probe. If it asks its own approval for MCP tools, answer it with
   `gatewayApprovalOption` / `isGatewayToolCall`. If it names tools in a way
   `computerUseToolOfProviderName` does not read, add the spelling there.
5. Add it to `COMPUTER_USE_FIXED_AT_START` in `ipc-handlers.ts` if its tool
   list is fixed when the runtime starts.

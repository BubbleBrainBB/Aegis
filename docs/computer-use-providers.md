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

## The three ways in

| Way in | Who | Where |
| --- | --- | --- |
| Host tools, bound to the session by closure | Bubble | `bubble-computer-use-tool.ts` |
| Custom tools, bound to the session by closure | Pi | `computer-use/provider-mcp.ts` (`createPiComputerUseTools`) |
| The gateway's **MCP bridge**: a loopback MCP server whose every request is bound to one session | DeepSeek, MiniMax, MiMo, Devin, Grok, Qoder, Claude, OpenCode | `computer-use/mcp-bridge.ts`, `computer-use/provider-mcp.ts` |

Codex keeps its own Computer use client (`codex-computer-use.ts`) and shares
only the lease and the grant registry, as before.

### The MCP bridge

`ComputerUseMcpBridge` is a transport and nothing else: `tools/list` gives the
gateway's nine tools with the gateway's own schemas, and `tools/call` is
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

"Live" means a real model turn through the provider's real CLI or SDK against
the app's bridge and gateway with a scripted driver (no desktop touched), run
by hand with the probes below. The real driver is covered by
`npm run verify:computer-use-live`, which now also drives Calculator through
the bridge.

| Provider | Way in | Binding | Own approval for MCP tools | Screenshot to the model | Plan | Full Access | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bubble | host tools | closure | answered by the adapter (PR #208) | image | yes | yes | PR #208 |
| DeepSeek | bridge, per runtime (`cordis.yml` of that runtime) | capability | none (no approval channel) | image, when the model takes images; the file path always | no Plan mode | `danger-full-access` | CI: real Harness runtime + its MCP client, mock model (`verify:deepseek-computer-use`). No live model turn: the API balance on the test machine was exhausted. |
| MiniMax Code | bridge, ACP `session/new` | capability | none seen (mcode 0.6.12, Ask mode) | file path | yes | `bypassPermissions` | live (`probe:computer-use-acp minimax`) + CI with a scripted agent |
| MiMo Code | bridge, ACP `session/new` | capability | none (Aegis's permission config asks for edit/bash/webfetch only) | file path | yes | `build` | live + CI with a scripted agent |
| Devin | bridge, ACP `session/new` | capability | **asks for every MCP call, reads too**: answered by the adapter | file path | yes | `bypass` | live + CI with a scripted agent |
| Grok Build | bridge, ACP `session/new` | capability | unknown; the adapter answers if it asks | file path | yes | card always | CI with a scripted agent only. **Not live**: the account's balance was exhausted (HTTP 402). |
| Qoder | bridge, `query({ mcpServers })` | capability | **asks for every MCP call**: answered by the adapter (not in Don't Ask, which denies) | file path | yes | `bypassPermissions` | live with the real adapter (`probe:computer-use-adapters qoder`) |
| Claude | bridge, `query({ mcpServers })` | capability | `canUseTool` lets MCP tools through | image | yes | Full access | live at SDK level (same `mcpServers` shape as `runner.ts`); the runner path itself only by source check |
| Pi | custom tools | closure | none (Pi has no approval) | image | no Plan mode | card always | live with the real adapter (`probe:computer-use-adapters pi`) |
| OpenCode | bridge, the server's inline config | resolver: `_meta['ai.opencode/sessionID']`, as Browser Use | none expected (asks are limited to edit/shell/webfetch) | file path | yes | card always | CI for the entry and the resolver only. **Not live**: no model on the test machine had usable credentials. |
| Codex | its own client | — | — | — | — | — | unchanged |
| **Kimi** | **none** | — | — | — | — | — | disabled, see below |

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

### Kimi: not supported, on purpose

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

What would change this: a per-session MCP entry in Kimi's server API (the
core has `addSessionMcpServer`, the REST surface does not expose it), a
session id in its MCP request metadata (then `bindResolver` fits, as for
OpenCode), or moving Kimi to its ACP runtime, which takes `mcpServers` per
session but lacks steer, usage and subagents (see
`docs/kimi-server-adapter-plan.md`).

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

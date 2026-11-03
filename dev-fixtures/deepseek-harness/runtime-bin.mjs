#!/usr/bin/env node
// Boot the DeepSeek Harness SDK runtime from this profile's cordis.yml
// (dsh-acp-demo bin pattern, minus the snapshot machinery). stdout carries
// the SDK JSON-RPC protocol; diagnostics go to stderr only.
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installDeepseekSdkResumeShim } from './runtime-resume-shim.mjs';
import { installDeepseekSdkStreamShim } from './runtime-stream-shim.mjs';
import { installProjectRoots } from './runtime-project-roots.mjs';

const NAME = 'aegis-dsh-sdk-runtime';
installFailLoud(NAME);
loadEnv(NAME);
process.env.AEGIS_DSH_ATTACHMENT_HOME ||= join(homedir(), '.aegis', 'deepseek');
installProjectRoots();
installDeepseekSdkResumeShim({ HarnessSdkJsonRpcServer, SessionId });
installDeepseekSdkStreamShim({ HarnessSdkJsonRpcServer });
// The SDK launches `dshBin --profile sdk --patch <config>`. Aegis owns
// the complete composition (including temporary MCP rows), so this single
// patch is our config, not an overlay on the user's global DSH profile.
const { values, positionals } = parseArgs({
  options: { profile: { type: 'string' }, patch: { type: 'string', multiple: true } },
  allowPositionals: true,
});
if ((values.profile && values.profile !== 'sdk') ||
    (values.patch?.length ?? 0) > 1 || positionals.length > 1 ||
    (values.patch?.length && positionals.length)) {
  throw new Error('Aegis runtime requires one SDK composition config');
}
const root = await boot(
  NAME,
  resolveConfigPath(values.patch?.[0] ?? positionals[0] ?? './cordis.yml', undefined),
  undefined,
  undefined,
  new URL('./', import.meta.url).href,
);

// A client that dies without `shutdown` (Aegis crashed, a script called
// process.exit) leaves only stdin EOF. Upstream's sdk-app binds EOF to shutdown,
// but this bin does not mount it, and a live session keeps the event loop alive.
const EOF_SHUTDOWN_LIMIT_MS = 10_000;
function shutDownOnEof() {
  setTimeout(() => process.exit(1), EOF_SHUTDOWN_LIMIT_MS).unref();
  void root.fiber.dispose().finally(() => process.exit(0));
}
if (process.stdin.readableEnded) shutDownOnEof();
else process.stdin.once('end', shutDownOnEof);

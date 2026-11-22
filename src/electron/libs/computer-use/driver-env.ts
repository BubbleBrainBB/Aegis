// The environment a cua-driver process is given, whatever it is started for
// (the daemon, its MCP proxy, a `--version` probe): built here, not inherited.

/**
 * What the driver is allowed to inherit from Aegis's own environment: where
 * things are and how text is encoded. Nothing that configures the driver
 * (`CUA_*`: an extra HTTP listener, foreground delivery, another policy), no
 * tokens, no proxies.
 */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
] as const;

/** The few inherited names, plus "no telemetry, no update check": enough to run the binary at all. */
export function baseCuaDriverEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (typeof value === 'string' && value) env[name] = value;
  }
  return {
    ...env,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
  };
}

/**
 * The whole environment the daemon and its proxy start with: embedded in this
 * app, its state under Aegis's own folder (never the folder of a cua-driver
 * the user installed themselves), and the gateway's policy file.
 */
export function buildCuaDriverEnv(input: {
  base: NodeJS.ProcessEnv;
  homeDir: string;
  hostBundleId: string;
  policyFile: string;
}): NodeJS.ProcessEnv {
  return {
    ...baseCuaDriverEnv(input.base),
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_HOST_BUNDLE_ID: input.hostBundleId,
    CUA_DRIVER_RS_HOME: input.homeDir,
    CUA_DRIVER_POLICY_FILE: input.policyFile,
  };
}

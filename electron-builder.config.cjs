// electron-builder entry point: the static settings live in
// electron-builder.json; this adds exclusions computed from package-lock.json
// and per-platform native prebuild filters while preserving the root allowlist.
// Build with `electron-builder --config electron-builder.config.cjs`
// (`npm run build:electron`); electron-builder would otherwise pick the JSON.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { unusedLauncherPackageNames } = require('./scripts/deepseek-sdk-closure.cjs');

// Parse the JSON with the same json5 reader electron-builder uses for it.
const json5 = createRequire(require.resolve('app-builder-lib/package.json'))('json5');
const config = json5.parse(fs.readFileSync(path.join(__dirname, 'electron-builder.json'), 'utf8'));

// The dsh CLI graph that @deepseek-ai/dsh-sdk-client depends on is never
// loaded (see scripts/deepseek-sdk-closure.cjs). Exclude, wherever
// electron-builder places them, the packages no other dependency uses.
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8')).packages;
const rootDependencies = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).dependencies;

const baseFiles = [
  ...config.files,
  ...unusedLauncherPackageNames(lock, rootDependencies).flatMap((name) => [
    `!node_modules/${name}`,
    `!node_modules/${name}/**/*`,
    `!node_modules/**/node_modules/${name}`,
    `!node_modules/**/node_modules/${name}/**/*`,
  ]),
];

function excludeForeignNativePrebuilds(foreignOsPrefixes) {
  return foreignOsPrefixes.flatMap((osPrefix) => [
    `!node_modules/node-pty/prebuilds/${osPrefix}-*`,
    `!node_modules/node-pty/prebuilds/${osPrefix}-*/**/*`,
    `!node_modules/**/node_modules/node-pty/prebuilds/${osPrefix}-*`,
    `!node_modules/**/node_modules/node-pty/prebuilds/${osPrefix}-*/**/*`,
    `!node_modules/better-sqlite3/prebuilds/${osPrefix}*.node`,
  ]);
}

// Note: in electron-builder, platform-specific `files` replaces root `files`
// (and an exclusion-only array implicitly prepends `**/*`!). Always spread
// `baseFiles` so the allowlist (dist-electron, dist-react, node_modules) stays intact.
config.files = baseFiles;
config.mac = { ...config.mac, files: [...baseFiles, ...excludeForeignNativePrebuilds(['win32', 'linux'])] };
config.win = { ...config.win, files: [...baseFiles, ...excludeForeignNativePrebuilds(['darwin', 'linux'])] };
config.linux = { ...config.linux, files: [...baseFiles, ...excludeForeignNativePrebuilds(['darwin', 'win32'])] };

module.exports = config;

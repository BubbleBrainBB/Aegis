#!/usr/bin/env node
// Compiles src/electron/native/liquid-glass.mm into dist-electron/native/
// liquid-glass.node (macOS only, universal). It is plain N-API, so Node's own
// headers are enough and the result loads in Electron without a rebuild.
// When it cannot be built the app still runs: glass themes paint solid.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'src/electron/native/liquid-glass.mm');
const output = path.join(root, 'dist-electron/native/liquid-glass.node');

if (process.platform !== 'darwin') process.exit(0);

const nodeHeaders = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
if (!fs.existsSync(path.join(nodeHeaders, 'node_api.h'))) {
  console.warn(`[liquid-glass] Node headers not found at ${nodeHeaders}; skipping (glass themes will be solid).`);
  process.exit(0);
}

const upToDate =
  fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
if (upToDate) process.exit(0);

fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(
  'xcrun',
  [
    'clang++',
    '-arch', 'arm64',
    '-arch', 'x86_64',
    '-mmacosx-version-min=12.0',
    '-std=c++17',
    '-fobjc-arc',
    '-O2',
    '-bundle',
    '-undefined', 'dynamic_lookup',
    '-DNODE_GYP_MODULE_NAME=liquid_glass',
    '-DNAPI_VERSION=8',
    '-I', nodeHeaders,
    '-framework', 'AppKit',
    source,
    '-o', output,
  ],
  { stdio: 'inherit' }
);
if (result.status !== 0) {
  console.warn('[liquid-glass] Build failed; glass themes will be solid.');
  fs.rmSync(output, { force: true });
}

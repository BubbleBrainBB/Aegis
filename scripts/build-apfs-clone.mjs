#!/usr/bin/env node
// Compiles src/electron/native/apfs-clone.cc into dist-electron/native/
// apfs-clone.node (macOS only, universal). Plain N-API v8, so Node's own
// headers are enough and the result loads in both Node and Electron without a
// rebuild. Without it, new worktrees on macOS only get small ignored files.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'src/electron/native/apfs-clone.cc');
const output = path.join(root, 'dist-electron/native/apfs-clone.node');

if (process.platform !== 'darwin') process.exit(0);

const nodeHeaders = path.resolve(path.dirname(process.execPath), '..', 'include', 'node');
if (!fs.existsSync(path.join(nodeHeaders, 'node_api.h'))) {
  console.warn(`[apfs-clone] Node headers not found at ${nodeHeaders}; skipping (new worktrees will only get small ignored files).`);
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
    '-O2',
    '-bundle',
    '-undefined', 'dynamic_lookup',
    '-DNODE_GYP_MODULE_NAME=apfs_clone',
    '-DNAPI_VERSION=8',
    '-I', nodeHeaders,
    source,
    '-o', output,
  ],
  { stdio: 'inherit' }
);
if (result.status !== 0) {
  console.warn('[apfs-clone] Build failed; new worktrees will only get small ignored files.');
  fs.rmSync(output, { force: true });
}

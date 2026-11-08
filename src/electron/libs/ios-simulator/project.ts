// Whether a folder is iOS app work, so the New tab menu offers the
// simulator only where it can be used: an Xcode project or workspace in the
// folder or one level down, or a Swift package that names the iOS platform.

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'Pods', 'DerivedData', 'build', '.build', 'dist']);
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: boolean }>();

function isXcodeContainer(name: string): boolean {
  return name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace');
}

async function packageTargetsIos(dir: string): Promise<boolean> {
  try {
    const manifest = await readFile(join(dir, 'Package.swift'), 'utf8');
    return /\.iOS\s*\(/.test(manifest);
  } catch {
    return false;
  }
}

async function scan(dir: string, depth: number): Promise<boolean> {
  let entries: import('fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((entry) => entry.isDirectory() && isXcodeContainer(entry.name))) return true;
  if (entries.some((entry) => entry.isFile() && entry.name === 'Package.swift') && (await packageTargetsIos(dir))) {
    return true;
  }
  if (depth === 0) return false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    if (await scan(join(dir, entry.name), depth - 1)) return true;
  }
  return false;
}

export async function isIosProject(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await scan(cwd, 2);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

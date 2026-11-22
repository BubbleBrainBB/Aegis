#!/usr/bin/env node
// Downloads the one cua-driver release Aegis runs and verifies it.
//
// Cua Driver (https://github.com/trycua/cua, libs/cua-driver, MIT) ships as a
// single Rust binary. Upstream publishes several releases a day, all marked
// prerelease, so the version and the archive's SHA-256 are fixed here; the
// hash is the one upstream lists in that release's SHA256SUMS. To move to
// another version, change VERSION and SHA256 here and CUA_DRIVER_VERSION in
// src/electron/libs/computer-use/driver-binary.ts in one change
// (scripts/tests/computer-use-gateway.test.ts fails when they differ).
//
//   node scripts/fetch-cua-driver.mjs [--dest <dir>] [--force]
//
// The binary lands in native/cua-driver/dist/ (ignored by git), where a
// development run of Aegis looks for it. macOS only for now.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.57.0';
export const ASSET = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
export const SHA256 = '917dfccdbbd5cbd90774cfa46292551b9a9e86bc719b878dbd21af14e38bb76b';
export const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ASSET}`;
/** The daemon and the cursor overlay it draws; the SDK library and Node binding in the archive are not used. */
const FILES = ['cua-driver', 'cua-cursor-theme'];

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const destIndex = args.indexOf('--dest');
  const dest = destIndex >= 0 ? path.resolve(args[destIndex + 1]) : path.join(root, 'native', 'cua-driver', 'dist');
  const force = args.includes('--force');

  if (process.platform !== 'darwin') {
    console.log('cua-driver is fetched for macOS only for now; nothing to do on this platform.');
    return;
  }
  const marker = path.join(dest, 'VERSION');
  if (!force && existsSync(path.join(dest, 'cua-driver')) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${VERSION} ${SHA256}`) {
    console.log(`cua-driver ${VERSION} is already in ${dest}`);
    return;
  }

  // Downloaded and unpacked in a fresh folder of its own; only the two named files are taken out of it.
  const work = mkdtempSync(path.join(tmpdir(), 'aegis-cua-driver-'));
  try {
    const archivePath = path.join(work, ASSET);
    const unpacked = path.join(work, 'unpacked');
    mkdirSync(unpacked);
    console.log(`Downloading ${URL}`);
    // curl, not fetch(): it follows the proxy the environment names.
    execFileSync('/usr/bin/curl', ['-fL', '--retry', '3', '--connect-timeout', '20', '-o', archivePath, URL], { stdio: 'inherit' });
    const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    if (digest !== SHA256) {
      throw new Error(`SHA-256 mismatch for ${ASSET}: expected ${SHA256}, got ${digest}. Nothing was installed.`);
    }
    execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', unpacked, ...FILES], { stdio: 'inherit' });
    mkdirSync(dest, { recursive: true });
    for (const file of FILES) {
      copyFileSync(path.join(unpacked, file), path.join(dest, file));
      chmodSync(path.join(dest, file), 0o755);
    }
    writeFileSync(marker, `${VERSION} ${SHA256}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const reported = execFileSync(path.join(dest, 'cua-driver'), ['--version'], {
    encoding: 'utf8',
    // The binary just downloaded gets a bare environment, not this shell's.
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY_ENABLED: 'false', CUA_DRIVER_RS_UPDATE_CHECK: 'false' },
  }).trim();
  if (!reported.includes(VERSION)) throw new Error(`The binary reports "${reported}", expected ${VERSION}.`);
  console.log(`Installed ${reported} in ${dest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

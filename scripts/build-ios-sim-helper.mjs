#!/usr/bin/env node
// Builds aegis-sim-helper (native/ios-sim-helper) into native/ios-sim-helper/dist:
//
//   dist/aegis-sim-helper            universal (arm64 + x86_64) executable
//   dist/Frameworks/*.framework      idb's FBSimulatorControl and friends
//   dist/THIRD_PARTY_NOTICES.txt     idb and AXe licenses (both MIT)
//
// idb comes from the fork AXe pins (it carries Xcode 27's DTUHID input
// transport). Its frameworks are built with AXe's own build script at a
// pinned AXe commit, once, and cached in native/ios-sim-helper/.idb.
// Needs macOS, Xcode (26 or later), git and XcodeGen.
//
// The result is ad-hoc signed so it runs from a checkout; packaged apps
// re-sign it with the app's identity.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AXE_REPO = 'https://github.com/cameroncooke/AXe.git';
// AXe v1.8.0: pins the idb fork (cameroncooke/idb 604c5101) and builds it.
const AXE_REF = '30f4bfa9bc81817906a60fadedbc913d7314b7e1';
// What the helper links (FBDeviceControl, for physical devices, is not).
const FRAMEWORKS = ['FBControlCore', 'FBSimulatorControl', 'XCTestBootstrap'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'native', 'ios-sim-helper');
const idbDir = path.join(packageDir, '.idb');
const axeDir = path.join(idbDir, 'axe');
const stampFile = path.join(idbDir, 'BUILT_FROM');
const distDir = path.join(packageDir, 'dist');

function sh(command, args, options = {}) {
  console.log(`[ios-sim-helper] ${command} ${args.join(' ')}`);
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
}

if (process.platform !== 'darwin') {
  console.log('[ios-sim-helper] macOS only; skipped.');
  process.exit(0);
}

for (const tool of ['git', 'xcodegen', 'xcodebuild', 'swift']) {
  try {
    capture('/usr/bin/which', [tool]);
  } catch {
    console.error(`[ios-sim-helper] ${tool} is required${tool === 'xcodegen' ? ' (brew install xcodegen)' : ''}.`);
    process.exit(1);
  }
}

// 1. idb frameworks, via AXe's build script at the pinned commit.
const built = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === AXE_REF;
if (!built || process.argv.includes('--rebuild-idb')) {
  mkdirSync(idbDir, { recursive: true });
  if (!existsSync(path.join(axeDir, '.git'))) {
    rmSync(axeDir, { recursive: true, force: true });
    mkdirSync(axeDir, { recursive: true });
    sh('git', ['init', '--quiet', axeDir]);
    sh('git', ['-C', axeDir, 'remote', 'add', 'origin', AXE_REPO]);
  }
  // Only the pinned commit, in one pack; GitHub drops long transfers now
  // and then, so try a few times.
  for (let attempt = 1; ; attempt += 1) {
    try {
      sh('git', ['-C', axeDir, 'fetch', '--depth', '1', 'origin', AXE_REF]);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
  sh('git', ['-C', axeDir, 'checkout', '--force', '--quiet', 'FETCH_HEAD']);
  const env = { ...process.env, GIT_PAGER: 'cat' };
  // setup clones the idb fork (large); retry dropped transfers.
  for (let attempt = 1; ; attempt += 1) {
    try {
      sh('./scripts/build.sh', ['setup'], { cwd: axeDir, env });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      rmSync(path.join(axeDir, 'idb_checkout'), { recursive: true, force: true });
    }
  }
  for (const step of ['frameworks', 'install', 'xcframeworks']) {
    sh('./scripts/build.sh', [step], { cwd: axeDir, env });
  }
  for (const name of ['XCFrameworks', 'PrivateHeaders']) rmSync(path.join(idbDir, name), { recursive: true, force: true });
  cpSync(path.join(axeDir, 'build_products', 'XCFrameworks'), path.join(idbDir, 'XCFrameworks'), { recursive: true, verbatimSymlinks: true });
  cpSync(path.join(axeDir, 'idb_checkout', 'PrivateHeaders'), path.join(idbDir, 'PrivateHeaders'), { recursive: true });
  writeFileSync(stampFile, `${AXE_REF}\n`);
}

// 2. The helper, universal.
const swiftArgs = ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', packageDir];
sh('swift', swiftArgs);
// Where a universal build lands differs between Swift versions: ask.
const products = capture('swift', [...swiftArgs, '--show-bin-path']);

// 3. dist/: the executable with its frameworks beside it (rpath
// @executable_path/Frameworks).
rmSync(distDir, { recursive: true, force: true });
mkdirSync(path.join(distDir, 'Frameworks'), { recursive: true });
cpSync(path.join(products, 'aegis-sim-helper'), path.join(distDir, 'aegis-sim-helper'));
for (const name of FRAMEWORKS) {
  const xcframework = path.join(idbDir, 'XCFrameworks', `${name}.xcframework`);
  const slice = readdirSync(xcframework).find((entry) => entry.startsWith('macos-'));
  if (!slice) throw new Error(`${name}.xcframework has no macOS slice`);
  cpSync(path.join(xcframework, slice, `${name}.framework`), path.join(distDir, 'Frameworks', `${name}.framework`), {
    recursive: true,
    verbatimSymlinks: true,
  });
}
// Runtime needs only each framework's binary and resources: drop headers,
// Swift modules, and the copies of sibling frameworks idb nests inside
// (dyld could otherwise load a second copy).
for (const name of FRAMEWORKS) {
  const framework = path.join(distDir, 'Frameworks', `${name}.framework`);
  for (const part of ['Headers', 'Modules', 'Frameworks', 'PrivateHeaders']) {
    rmSync(path.join(framework, part), { force: true });
    rmSync(path.join(framework, 'Versions', 'A', part), { recursive: true, force: true });
  }
  rmSync(path.join(framework, 'Versions', 'A', '_CodeSignature'), { recursive: true, force: true });
}
const notice = (title, file) => `${title}\n${'='.repeat(title.length)}\n\n${readFileSync(file, 'utf8').trim()}\n`;
writeFileSync(
  path.join(distDir, 'THIRD_PARTY_NOTICES.txt'),
  [
    'aegis-sim-helper links idb (https://github.com/cameroncooke/idb, a fork of facebook/idb), built with AXe\'s build script (https://github.com/cameroncooke/AXe).\n',
    notice('idb', path.join(axeDir, 'idb_checkout', 'LICENSE')),
    notice('AXe', path.join(axeDir, 'LICENSE')),
  ].join('\n')
);

// 4. Ad-hoc signatures, frameworks first.
for (const name of FRAMEWORKS) {
  sh('codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(distDir, 'Frameworks', `${name}.framework`)]);
}
sh('codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(distDir, 'aegis-sim-helper')]);

const archs = capture('lipo', ['-archs', path.join(distDir, 'aegis-sim-helper')]);
console.log(`[ios-sim-helper] built ${path.relative(root, distDir)} (${archs})`);

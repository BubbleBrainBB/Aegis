import { execFile } from 'node:child_process';
import {
  constants as fsConstants,
  existsSync,
  promises as fsPromises,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_LS_TIMEOUT_MS = 15_000;
const GIT_LS_MAX_BUFFER = 32 * 1024 * 1024;
const COPY_CONCURRENCY = 6;

const HARD_EXCLUDED_SEGMENTS = new Set(['.git', '.worktrees']);
const HARD_EXCLUDED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);
const HARD_EXCLUDED_PREFIXES = ['.claude/worktrees'];

const SOFT_EXCLUDED_EXTENSIONS = new Set([
  '.dmg',
  '.pkg',
  '.msi',
  '.appimage',
  '.iso',
  '.log',
  '.swp',
  '.swo',
]);

// Without copy-on-write, only individually ignored files up to this size are
// copied byte for byte; anything bigger needs an explicit `.worktreeinclude`.
const PLAIN_COPY_MAX_BYTES = 10 * 1024 * 1024;

interface ApfsCloneAddon {
  cloneFile(src: string, dst: string): Promise<void>;
}

let cachedApfsAddon: ApfsCloneAddon | null | undefined;

function loadApfsCloneAddon(): ApfsCloneAddon | null {
  if (cachedApfsAddon !== undefined) return cachedApfsAddon;
  cachedApfsAddon = null;
  if (process.platform !== 'darwin') return cachedApfsAddon;

  const candidates = [
    // Compiled Electron / CJS layout: dist-electron/electron/libs -> dist-electron/native
    join(__dirname, '..', '..', 'native', 'apfs-clone.node'),
    // Source layout when executed via tsx: src/electron/libs -> dist-electron/native
    join(__dirname, '..', '..', '..', 'dist-electron', 'native', 'apfs-clone.node'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded = require(candidate) as ApfsCloneAddon;
      if (typeof loaded?.cloneFile === 'function') {
        cachedApfsAddon = loaded;
        return cachedApfsAddon;
      }
    } catch {
      // Try next candidate or use the small-file fallback.
    }
  }
  return cachedApfsAddon;
}

export interface WorktreeBootstrapInput {
  /** Repository working tree whose local ignored environment should be cloned. */
  sourceRoot: string;
  /** Newly created worktree directory. */
  worktreePath: string;
  /** Known worktree paths (optional; queried via git if omitted). */
  existingWorktreePaths?: string[];
  /** Override platform for testing. */
  platform?: NodeJS.Platform;
  /** Override copy-on-write detection for testing. */
  copyOnWrite?: boolean;
}

export interface WorktreeBootstrapResult {
  copied: string[];
  skipped: string[];
  failed: Array<{ path: string; reason: string }>;
  durationMs: number;
  /** Whether sourceRoot -> worktreePath supports copy-on-write clones. */
  copyOnWrite: boolean;
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

export function normalizeRelativePath(raw: string, gitPath = false): string | null {
  const trimmed = (gitPath ? raw : raw.replace(/\\/g, '/')).replace(/\/+$/g, '');
  if (!trimmed || trimmed === '.' || trimmed.startsWith('/')) return null;
  const normalized = posix.normalize(trimmed);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null;
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

export function isHardExcludedPath(relPosix: string, extraExcludedRelDirs: ReadonlySet<string> = new Set()): boolean {
  const segments = relPosix.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (HARD_EXCLUDED_BASENAMES.has(base)) return true;
  if (segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment))) return true;
  for (const prefix of HARD_EXCLUDED_PREFIXES) {
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) return true;
  }
  for (const excluded of extraExcludedRelDirs) {
    if (relPosix === excluded || relPosix.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

export function isSoftExcludedPath(relPosix: string): boolean {
  const segments = relPosix.split('/');
  const base = segments[segments.length - 1] ?? '';
  const lowerBase = base.toLowerCase();

  if (
    lowerBase.startsWith('npm-debug.log') ||
    lowerBase.startsWith('yarn-debug.log') ||
    lowerBase.startsWith('yarn-error.log')
  ) {
    return true;
  }
  const dotIndex = lowerBase.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = lowerBase.slice(dotIndex);
    if (SOFT_EXCLUDED_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function toFsPath(root: string, relPosix: string): string {
  return join(root, ...relPosix.split('/'));
}

interface GitEntry {
  rel: string;
  isDir: boolean;
}

async function listGitEntries(cwd: string, args: string[]): Promise<GitEntry[]> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_LS_TIMEOUT_MS,
      maxBuffer: GIT_LS_MAX_BUFFER,
    });
    return stdout.split('\0').flatMap((raw) => {
      const rel = normalizeRelativePath(raw, true);
      return rel ? [{ rel, isDir: raw.endsWith('/') }] : [];
    });
  } catch {
    return [];
  }
}

async function listCheckIgnored(cwd: string, paths: string[], gitDir?: string): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const repository = gitDir ? ['--git-dir', gitDir, '--work-tree', cwd] : [];
  const command = execFileAsync('git', [...repository, 'check-ignore', '--stdin', '-z'], {
    cwd, timeout: GIT_LS_TIMEOUT_MS, maxBuffer: GIT_LS_MAX_BUFFER,
  });
  command.child.stdin?.on('error', () => { /* The command reports early exits below. */ });
  command.child.stdin?.end(paths.map(name => './' + name).join('\0') + '\0');
  try {
    const { stdout } = await command;
    return new Set(stdout.split('\0').filter(Boolean).map(name => name.replace(/^\.\//, '')));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return new Set();
    throw error;
  }
}

function isCoveredBy(relPosix: string, roots: ReadonlySet<string>): boolean {
  if (roots.has(relPosix)) return true;
  const segments = relPosix.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (roots.has(segments.slice(0, i).join('/'))) return true;
  }
  return false;
}

/**
 * Like Claude Code, `.worktreeinclude` only selects among gitignored files:
 * untracked work that merely matches a pattern is never copied.
 */
async function resolveExplicitIncludes(sourceRoot: string, ignored: ReadonlySet<string>): Promise<Set<string>> {
  if (!existsSync(join(sourceRoot, '.worktreeinclude'))) return new Set();
  const matches = await listGitEntries(sourceRoot, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-from=.worktreeinclude',
    '--directory',
  ]);
  const unresolved = matches.map((entry) => entry.rel).filter((rel) => !isCoveredBy(rel, ignored));
  const checked = await listCheckIgnored(sourceRoot, unresolved);
  return new Set(matches.map((entry) => entry.rel).filter((rel) => isCoveredBy(rel, ignored) || checked.has(rel)));
}

async function discoverExistingWorktreePaths(sourceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: sourceRoot, timeout: GIT_LS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice('worktree '.length));
}

function computeHardExcludedRelDirs(sourceRootReal: string, checkoutRoots: string[]): Set<string> {
  const excluded = new Set<string>(['.worktrees', ...HARD_EXCLUDED_PREFIXES]);
  for (const wtReal of checkoutRoots) {
    if (!wtReal || wtReal === sourceRootReal) continue;
    const rel = relative(sourceRootReal, wtReal);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const normalized = normalizeRelativePath(rel.split(sep).join('/'));
    if (normalized) excluded.add(normalized);
  }
  return excluded;
}

async function lstatOrNull(targetPath: string): Promise<Stats | null> {
  try {
    return await fsPromises.lstat(targetPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

// Never traverse a checkout symlink, even if it currently points inside the root.
async function hasDirectoryParents(root: string, rel: string): Promise<boolean> {
  let parent = root;
  for (const part of rel.split('/').slice(0, -1)) {
    parent = join(parent, part);
    const stat = await lstatOrNull(parent);
    if (!stat) break;
    if (!stat.isDirectory()) return false;
  }
  return true;
}

function isUnsupportedSpecialEntry(stat: Stats): boolean {
  return stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice();
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/** Copy-on-write clone of a single file; throws when the filesystem cannot clone. */
async function cloneRegularFile(src: string, dst: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'darwin') {
    // libuv has no COPYFILE_FICLONE_FORCE on macOS (ENOSYS), so cloning needs the addon.
    const addon = loadApfsCloneAddon();
    if (!addon) throw new Error('APFS clone addon unavailable');
    await addon.cloneFile(src, dst);
    return;
  }
  await fsPromises.copyFile(src, dst, fsConstants.COPYFILE_FICLONE_FORCE | fsConstants.COPYFILE_EXCL);
}

/**
 * Decide once whether sourceRoot -> worktreePath can clone. Without it, big
 * directories are skipped instead of copied byte for byte or linked back to
 * the main checkout (a symlinked `node_modules` is untracked to git and shares
 * state with the main repo).
 */
async function probeCopyOnWrite(sourceRoot: string, worktreePath: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === 'win32') return false;
  const gitPath = join(sourceRoot, '.git');
  const probeSrc = (await lstatOrNull(gitPath))?.isDirectory() ? join(gitPath, 'HEAD') : gitPath;
  const probeDst = join(worktreePath, `.aegis-cow-probe-${process.pid}-${Date.now()}`);
  try {
    await cloneRegularFile(probeSrc, probeDst, platform);
    return true;
  } catch {
    return false;
  } finally {
    await fsPromises.rm(probeDst, { force: true }).catch(() => undefined);
  }
}

interface CopyContext {
  platform: NodeJS.Platform;
  copyOnWrite: boolean;
  hardExcludedRelDirs: ReadonlySet<string>;
  explicitIncludes: ReadonlySet<string>;
  sourceRoot: string;
  destinationRoot: string;
  checkoutRoots: string[];
  pendingLinks: Map<string, string>;
  gitDir: string;
  trackedPaths: ReadonlySet<string>;
  trackedParents: ReadonlySet<string>;
}

/** Returns false when the file was left out (exists already, or too costly without CoW). */
async function copyRegularFile(src: string, dst: string, ctx: CopyContext, allowPlainCopy: boolean): Promise<boolean> {
  if (ctx.copyOnWrite) {
    try {
      await cloneRegularFile(src, dst, ctx.platform);
      return true;
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) return false;
      if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'ENOTTY'].some(code => isErrorCode(error, code))) throw error;
    }
  }
  if (!allowPlainCopy) return false;
  try {
    await fsPromises.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

// Roots are deepest first: the default location of a linked checkout is
// inside another checkout's .worktrees directory.
function owningCheckout(path: string, roots: readonly string[]): string | undefined {
  return roots.find(root => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
  });
}

// Resolve external aliases one hop at a time. As soon as the remaining path
// belongs to a checkout, retain its spelling: a tracked alias in that suffix
// must be interpreted by the destination branch. Process ".." in filesystem
// order; a symlink immediately before it may point into another directory.
async function locateLinkTarget(raw: string, parent: string, roots: readonly string[], allowMissing = false, hops = 0): Promise<string | null> {
  if (hops > 40) return null;
  const root = parse(raw).root;
  let dir = root || parent;
  const parts = raw.slice(root.length).split(sep === '\\' ? /[\\/]+/ : /\/+/).filter(part => part && part !== '.');
  const lastParent = parts.lastIndexOf('..');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..') {
      dir = dirname(dir);
      continue;
    }
    if (i === lastParent + 1) {
      const candidate = join(dir, ...parts.slice(i));
      if (owningCheckout(candidate, roots)) return candidate;
    }
    const next = join(dir, parts[i]);
    const stat = await lstatOrNull(next);
    if (!stat) {
      if (!allowMissing || i <= lastParent) return null;
      return join(await fsPromises.realpath(dir), ...parts.slice(i));
    }
    if (stat.isSymbolicLink()) {
      if (roots.length && i > lastParent) {
        // On a case-insensitive volume the supplied spelling may not match
        // the registered root. Check the parent before expanding the alias.
        const candidate = join(await fsPromises.realpath(dir), ...parts.slice(i));
        if (owningCheckout(candidate, roots)) return candidate;
      }
      const rest = parts.slice(i + 1);
      const target = await fsPromises.readlink(next);
      return locateLinkTarget([target, ...rest].join(sep), dir, roots, allowMissing, hops + 1);
    }
    if (i + 1 < parts.length && !stat.isDirectory()) return null;
    dir = next;
  }
  return fsPromises.realpath(dir);
}

// A tracked alias may point at a generated file that another copy operation
// will supply. Resolve the existing portion, including any dangling aliases.
async function mappedTargetState(path: string, ctx: CopyContext): Promise<'local' | 'missing' | 'unsafe'> {
  let actual: string | null;
  let missing = false;
  try {
    actual = await fsPromises.realpath(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOTDIR') || isErrorCode(error, 'ELOOP')) return 'unsafe';
    if (!isErrorCode(error, 'ENOENT')) throw error;
    actual = await locateLinkTarget(path, ctx.destinationRoot, [], true);
    missing = true;
  }
  if (!actual || owningCheckout(actual, ctx.checkoutRoots) !== ctx.destinationRoot) return 'unsafe';
  if (isHardExcludedPath(relative(ctx.destinationRoot, actual).split(sep).join('/'), ctx.hardExcludedRelDirs)) return 'unsafe';
  return missing ? 'missing' : 'local';
}

type WorktreeLink = { target: string; pending?: boolean };

async function worktreeLinkTarget(raw: string, rel: string, ctx: CopyContext): Promise<WorktreeLink | null> {
  const parent = dirname(toFsPath(ctx.sourceRoot, rel));
  const target = await locateLinkTarget(raw, parent, ctx.checkoutRoots);
  if (target === null) return null;
  const owner = owningCheckout(target, ctx.checkoutRoots);
  if (!owner) return { target: isAbsolute(raw) ? raw : target };
  const local = relative(owner, target);
  if (isHardExcludedPath(local.split(sep).join('/'), ctx.hardExcludedRelDirs)) return null;
  const mapped = join(ctx.destinationRoot, local);
  const link = toFsPath(ctx.destinationRoot, rel);
  if (relative(link, mapped) === '') return null;
  const state = await mappedTargetState(mapped, ctx);
  if (state === 'unsafe') return null;
  return { target: relative(dirname(link), mapped) || '.', pending: state === 'missing' };
}

async function copyWorktreeLink(src: string, dst: string, rel: string, ctx: CopyContext): Promise<boolean> {
  const link = await worktreeLinkTarget(await fsPromises.readlink(src), rel, ctx);
  if (!link) return false;
  try {
    // Windows needs the source type when the mapped target has yet to be copied.
    const sourceStat = process.platform === 'win32' ? await fsPromises.stat(src).catch(() => null) : null;
    const type = sourceStat?.isDirectory() ? 'dir' : 'file';
    await fsPromises.symlink(link.target, dst, type);
    if (link.pending) ctx.pendingLinks.set(rel, link.target);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

function excluded(rel: string, ctx: CopyContext): boolean {
  return isCoveredBy(rel, ctx.trackedPaths) || isHardExcludedPath(rel, ctx.hardExcludedRelDirs) ||
    (isSoftExcludedPath(rel) && !isCoveredBy(rel, ctx.explicitIncludes));
}

// Filter the immutable copy, so files added in the source during cloning
// cannot slip past the exclusions. Never descend through a copied symlink.
async function filterClonedDirectory(dir: string, rel: string, ctx: CopyContext): Promise<void> {
  for (const entry of await fsPromises.readdir(dir, { withFileTypes: true })) {
    const child = rel + '/' + entry.name;
    const path = join(dir, entry.name);
    if (excluded(child, ctx) || !(entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())) {
      await fsPromises.rm(path, { recursive: entry.isDirectory(), force: true });
    } else if (entry.isSymbolicLink()) {
      const raw = await fsPromises.readlink(path);
      const link = await worktreeLinkTarget(raw, child, ctx);
      if (link?.target !== raw) {
        await fsPromises.unlink(path);
        if (link) await fsPromises.symlink(link.target, path);
      }
      if (link?.pending) ctx.pendingLinks.set(child, link.target);
    } else if (entry.isDirectory()) {
      await filterClonedDirectory(path, child, ctx);
    }
  }
}

// Stage outside the working tree, beside Git's own private files. An interrupted
// clone or a filtering failure cannot publish a partial directory at dst.
async function cloneFilteredDirectory(src: string, dst: string, rel: string, ctx: CopyContext): Promise<boolean> {
  if (!ctx.copyOnWrite || ctx.trackedParents.has(rel)) return false;
  // A source directory containing a linked worktree (possibly this destination)
  // must be traversed with exclusions before copying anything inside it.
  for (const excludedDir of ctx.hardExcludedRelDirs) {
    if (excludedDir.startsWith(rel + '/')) return false;
  }
  const staging = await fsPromises.mkdtemp(join(ctx.gitDir, 'aegis-clone-'));
  const clone = join(staging, 'tree');
  try {
    if (ctx.platform === 'darwin') {
      const addon = loadApfsCloneAddon();
      if (!addon) return false;
      await addon.cloneFile(src, clone);
    } else if (ctx.platform === 'linux') {
      await execFileAsync('cp', ['-a', '--reflink=always', '--', src, clone], { timeout: 60_000 });
    } else {
      return false;
    }
    const stagedLinks = new Map<string, string>();
    await filterClonedDirectory(clone, rel, { ...ctx, pendingLinks: stagedLinks });
    // dst was just created to query Git. rename only replaces an empty directory.
    await fsPromises.rename(clone, dst);
    for (const [child, target] of stagedLinks) ctx.pendingLinks.set(child, target);
    return true;
  } catch {
    // Directory clones or atomic renames can be unavailable across volumes.
    return false;
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true });
  }
}

function isIgnoreFile(rel: string): boolean {
  return posix.basename(rel).toLowerCase() === '.gitignore';
}

// A rule can unignore itself, expose an existing local file, or hide work the
// user was about to commit. Evaluate the proposed bytes with Git before making
// them active. The shadow only needs directories and applicable ignore files.
async function importIgnoreFile(rel: string, ctx: CopyContext, individual = false): Promise<boolean> {
  const src = toFsPath(ctx.sourceRoot, rel);
  const dst = toFsPath(ctx.destinationRoot, rel);
  if (await lstatOrNull(dst) || !(await listCheckIgnored(ctx.destinationRoot, [rel])).has(rel)) return false;
  const stat = await lstatOrNull(src);
  if (stat?.isSymbolicLink()) {
    // Git never follows a symlink when reading per-directory ignore rules.
    await fsPromises.mkdir(dirname(dst), { recursive: true });
    return copyWorktreeLink(src, dst, rel, ctx);
  }
  if (!stat?.isFile()) return false;
  const allowPlainCopy = isCoveredBy(rel, ctx.explicitIncludes) || (individual && stat.size <= PLAIN_COPY_MAX_BYTES);
  if (!ctx.copyOnWrite && !allowPlainCopy) return false;
  const scope = posix.dirname(rel);
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', 'ls-files', '--others', '-z', '--', scope], {
    cwd: ctx.destinationRoot, timeout: GIT_LS_TIMEOUT_MS, maxBuffer: GIT_LS_MAX_BUFFER,
  });
  const existing = stdout.split('\0').filter(Boolean);
  const shadow = await fsPromises.mkdtemp(join(ctx.gitDir, 'aegis-ignore-'));
  try {
    const dirs = new Set<string>();
    for (const path of [...existing, rel]) {
      let dir = posix.dirname(path);
      while (!dirs.has(dir)) {
        dirs.add(dir);
        if (dir === '.') break;
        dir = posix.dirname(dir);
      }
    }
    for (const dir of dirs) {
      const target = toFsPath(shadow, dir);
      await fsPromises.mkdir(target, { recursive: true });
      const rules = join(toFsPath(ctx.destinationRoot, dir), '.gitignore');
      if ((await lstatOrNull(rules))?.isFile()) await fsPromises.copyFile(rules, join(target, '.gitignore'));
    }
    // Git represents untracked embedded repositories with a trailing slash.
    for (const path of existing) {
      if (path.endsWith('/')) await fsPromises.mkdir(toFsPath(shadow, path), { recursive: true });
    }
    const proposed = toFsPath(shadow, rel);
    if (!await copyRegularFile(src, proposed, ctx, allowPlainCopy)) return false;
    const before = await listCheckIgnored(ctx.destinationRoot, existing);
    const after = await listCheckIgnored(shadow, [...existing, rel], ctx.gitDir);
    if (!after.has(rel) || existing.some(path => before.has(path) !== after.has(path))) return false;
    await fsPromises.mkdir(dirname(dst), { recursive: true });
    return copyRegularFile(proposed, dst, ctx, allowPlainCopy);
  } finally {
    await fsPromises.rm(shadow, { recursive: true, force: true });
  }
}

// Process one directory level at a time. Git needs real directories to
// distinguish "cache/" from "cache/*". Batch queries across siblings so a
// different target policy on node_modules doesn't start Git for every package.
async function copyDirectory(rel: string, ctx: CopyContext): Promise<boolean> {
  let level = [{ rel, parentIgnored: false }];
  const createdVisibleDirs: string[] = [];
  let copied = false;
  try {
    while (level.length) {
      const dirs = [];
      for (const item of level) {
        const dst = toFsPath(ctx.destinationRoot, item.rel);
        const existing = await lstatOrNull(dst);
        if (existing && !existing.isDirectory()) continue;
        if (!existing) await fsPromises.mkdir(dst, { recursive: true });
        dirs.push({ ...item, dst, created: !existing });
      }
      const ignoredDirs = await listCheckIgnored(ctx.destinationRoot,
        dirs.filter(dir => !dir.parentIgnored).map(dir => dir.rel));
      const files = [];
      level = [];
      for (const dir of dirs) {
        const ignored = dir.parentIgnored || ignoredDirs.has(dir.rel);
        if (dir.created) {
          if (ignored) copied = true;
          else createdVisibleDirs.push(dir.dst);
        }
        const src = toFsPath(ctx.sourceRoot, dir.rel);
        if (ignored && dir.created && await cloneFilteredDirectory(src, dir.dst, dir.rel, ctx)) continue;
        for (const entry of await fsPromises.readdir(src, { withFileTypes: true })) {
          const child = dir.rel + '/' + entry.name;
          if (excluded(child, ctx)) continue;
          if (entry.isDirectory()) {
            level.push({ rel: child, parentIgnored: ignored });
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            if (!ignored && isIgnoreFile(entry.name)) {
              if (await importIgnoreFile(child, ctx)) copied = true;
            } else {
              files.push({ rel: child, ignored, link: entry.isSymbolicLink() });
            }
          }
        }
      }
      const ignoredFiles = await listCheckIgnored(ctx.destinationRoot,
        files.filter(file => !file.ignored).map(file => file.rel));
      for (const file of files) {
        if (!file.ignored && !ignoredFiles.has(file.rel)) continue;
        const dst = toFsPath(ctx.destinationRoot, file.rel);
        if (await lstatOrNull(dst)) continue;
        const src = toFsPath(ctx.sourceRoot, file.rel);
        const created = file.link
          ? await copyWorktreeLink(src, dst, file.rel, ctx)
          : await copyRegularFile(src, dst, ctx, isCoveredBy(file.rel, ctx.explicitIncludes));
        if (created) copied = true;
      }
    }
  } finally {
    for (const dir of createdVisibleDirs.reverse()) {
      try {
        await fsPromises.rmdir(dir);
      } catch (error) {
        if (!isErrorCode(error, 'ENOTEMPTY') && !isErrorCode(error, 'EEXIST')) throw error;
      }
    }
  }
  return copied;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/**
 * Materialize gitignored local environment files and directories (such as
 * `node_modules`, `.env*`, build caches, and `.worktreeinclude` entries) from
 * `sourceRoot` into a newly created `worktreePath` so the worktree is ready to
 * run dev servers and tests out of the box.
 *
 * Directories are only copied as copy-on-write clones (APFS clonefile(2),
 * Linux reflinks), which are fast, take no extra disk blocks initially and stay
 * isolated from the main repo. Without copy-on-write (other volumes, ext4,
 * NTFS), only small individually ignored files and `.worktreeinclude`
 * selections are copied. Hard safety exclusions prevent nesting `.git` or
 * other worktrees.
 */
export async function bootstrapWorktreeEnvironment(
  input: WorktreeBootstrapInput
): Promise<WorktreeBootstrapResult> {
  const startedAt = Date.now();
  const platform = input.platform ?? process.platform;
  const sourceRootReal = safeRealpath(input.sourceRoot);
  const worktreePathReal = safeRealpath(input.worktreePath);

  const copied: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];

  if (sourceRootReal === worktreePathReal || !existsSync(sourceRootReal) || !existsSync(worktreePathReal)) {
    return { copied, skipped, failed, durationMs: Date.now() - startedAt, copyOnWrite: false };
  }

  const copyOnWrite = input.copyOnWrite ?? (await probeCopyOnWrite(sourceRootReal, worktreePathReal, platform));
  const existingWorktreePaths =
    input.existingWorktreePaths ?? (await discoverExistingWorktreePaths(sourceRootReal));
  // 1. Discover gitignored files/directories and optional `.worktreeinclude` selections.
  const ignoredEntries = await listGitEntries(sourceRootReal, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);
  const ignoredRels = new Set(ignoredEntries.map((entry) => entry.rel));
  const explicitIncludes = await resolveExplicitIncludes(sourceRootReal, ignoredRels);

  const gitDir = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktreePathReal });
  // The destination index also protects deleted tracked files and gitlinks
  // whose checkout is empty or absent. Never query inside a submodule.
  const index = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: worktreePathReal, timeout: GIT_LS_TIMEOUT_MS, maxBuffer: GIT_LS_MAX_BUFFER,
  });
  const trackedPaths = new Set(index.stdout.split('\0').filter(Boolean));
  const trackedParents = new Set<string>();
  for (const path of trackedPaths) {
    let parent = posix.dirname(path);
    while (parent !== '.' && !trackedParents.has(parent)) {
      trackedParents.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const checkoutRoots = [...new Set([sourceRootReal, worktreePathReal, ...existingWorktreePaths.map(safeRealpath)])]
    .sort((a, b) => b.length - a.length);
  const ctx: CopyContext = {
    checkoutRoots,
    pendingLinks: new Map(),
    gitDir: gitDir.stdout.trimEnd(),
    trackedPaths, trackedParents,
    platform,
    explicitIncludes,
    sourceRoot: sourceRootReal,
    destinationRoot: worktreePathReal,
    copyOnWrite,
    hardExcludedRelDirs: computeHardExcludedRelDirs(sourceRootReal, checkoutRoots),
  };

  const candidates = new Map<string, boolean>();
  for (const entry of ignoredEntries) candidates.set(entry.rel, entry.isDir);
  for (const rel of explicitIncludes) if (!candidates.has(rel)) candidates.set(rel, false);
  const sortedCandidates = [...candidates.keys()].sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  // 2. Filter and deduplicate overlapping paths so parent/child entries never race.
  const planned = new Set<string>();
  for (const rel of sortedCandidates) {
    if (isCoveredBy(rel, trackedPaths) || isHardExcludedPath(rel, ctx.hardExcludedRelDirs)) {
      skipped.push(rel);
      continue;
    }
    const explicitlyIncluded = isCoveredBy(rel, explicitIncludes);
    if (!explicitlyIncluded && (isSoftExcludedPath(rel) || (!copyOnWrite && candidates.get(rel)))) {
      skipped.push(rel);
      continue;
    }
    // Any ancestor already in `planned` is cloned whole or merged entry by
    // entry, so its descendants are covered.
    if (!isCoveredBy(rel, planned)) planned.add(rel);
  }

  // 3. Clone / materialize each planned entry with bounded concurrency.
  const safe: string[] = [];
  for (const rel of planned) {
    if (!await hasDirectoryParents(worktreePathReal, rel)) {
      skipped.push(rel);
    } else if (isIgnoreFile(rel) && !(await lstatOrNull(toFsPath(sourceRootReal, rel)))?.isDirectory()) {
      // The plan is shallowest first. Settle every loose rule before querying
      // loose files in its scope or handing disjoint directories to workers.
      try {
        const imported = await importIgnoreFile(rel, ctx, true);
        (imported ? copied : skipped).push(rel);
      } catch (error) {
        failed.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
      }
    } else {
      safe.push(rel);
    }
  }
  const ignoredInTarget = await listCheckIgnored(worktreePathReal, safe.filter(rel => !candidates.get(rel)));
  await runWithConcurrency(safe, COPY_CONCURRENCY, async (rel) => {
    const src = toFsPath(sourceRootReal, rel);
    const dst = toFsPath(worktreePathReal, rel);
    try {
      const srcStat = await lstatOrNull(src);
      if (!srcStat || isUnsupportedSpecialEntry(srcStat)) {
        skipped.push(rel);
        return;
      }

      // Guard against non-symlink entries somehow resolving outside sourceRoot.
      if (!srcStat.isSymbolicLink()) {
        const relCheck = relative(sourceRootReal, safeRealpath(src));
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          skipped.push(rel);
          return;
        }
      }

      const explicitlyIncluded = isCoveredBy(rel, explicitIncludes);
      const dstStat = await lstatOrNull(dst);
      if (srcStat.isDirectory()) {
        if ((dstStat && !dstStat.isDirectory()) || (!copyOnWrite && !explicitlyIncluded)) {
          skipped.push(rel);
          return;
        }
        const materialized = await copyDirectory(rel, ctx);
        (materialized ? copied : skipped).push(rel);
        return;
      }
      if (!ignoredInTarget.has(rel) || dstStat || !(srcStat.isSymbolicLink() || srcStat.isFile())) {
        skipped.push(rel);
        return;
      }

      await fsPromises.mkdir(dirname(dst), { recursive: true });
      if (srcStat.isSymbolicLink()) {
        const created = await copyWorktreeLink(src, dst, rel, ctx);
        (created ? copied : skipped).push(rel);
        return;
      }
      const allowPlainCopy = explicitlyIncluded || srcStat.size <= PLAIN_COPY_MAX_BYTES;
      if (await copyRegularFile(src, dst, ctx, allowPlainCopy)) copied.push(rel);
      else skipped.push(rel);
    } catch (error) {
      failed.push({
        path: rel,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // A sibling copied in parallel (or in the same staged directory) can supply
  // a missing link target. Check the completed layout before returning it.
  const invalidLinks: string[] = [];
  for (const [rel, target] of ctx.pendingLinks) {
    const link = toFsPath(worktreePathReal, rel);
    const state = await mappedTargetState(resolve(dirname(link), target), ctx);
    // Preserve an intentionally dangling source link. A formerly live link
    // with no counterpart on this branch has no usable mapping.
    if (state === 'unsafe' || (state === 'missing' && existsSync(toFsPath(sourceRootReal, rel)))) invalidLinks.push(rel);
  }
  for (const rel of invalidLinks) {
    const link = toFsPath(worktreePathReal, rel);
    if (await fsPromises.readlink(link) !== ctx.pendingLinks.get(rel)) continue;
    await fsPromises.unlink(link);
    skipped.push(rel);
    const index = copied.indexOf(rel);
    if (index >= 0) copied.splice(index, 1);
  }

  return {
    copied,
    skipped,
    failed,
    durationMs: Date.now() - startedAt,
    copyOnWrite,
  };
}

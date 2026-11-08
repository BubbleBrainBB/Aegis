export interface ProjectFileLink {
  path: string;
  line?: number;
  /** 不在任何已知项目根下的真实绝对路径：面板按外部文件打开 */
  external?: boolean;
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
// react-markdown percent-encodes hrefs before its URL transform: C:\a → C:%5Ca.
const DRIVE_URL = /^[A-Za-z]:(?:[\\/]|%5C)/i;

/** A Windows path such as C:\Users\me\a.png or C:/Users/me/a.png. */
function isDrivePath(value: string): boolean {
  return DRIVE_PATH.test(value);
}

export function looksLikeRevealablePath(value: string): boolean {
  const text = value.trim();
  if (!text || /[\r\n\t]/.test(text)) {
    return false;
  }

  return (
    text === '~' ||
    text.startsWith('~/') ||
    text.startsWith('~\\') ||
    /^\/(Users|home|tmp|var|etc|opt|private|Volumes|mnt)\//.test(text) ||
    isDrivePath(text)
  );
}

/**
 * react-markdown's default transform drops any URL whose "scheme" it does not
 * know, and to it the drive letter in C:\Users\… is a scheme. Local file
 * targets are kept so the anchor can open them; unresolved ones never navigate
 * (the main window denies non-http opens).
 */
export function isLocalFileUrl(url: string): boolean {
  const raw = url.trim();
  return DRIVE_URL.test(raw) || /^file:/i.test(raw);
}

function stripHashAndQuery(value: string): string {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const cutPoints = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (cutPoints.length === 0) return value;
  return value.slice(0, Math.min(...cutPoints));
}

function extractLineHint(value: string): number | undefined {
  const match = /(?:#L|[?&#]line=)(\d+)/i.exec(value);
  if (!match) return undefined;

  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

export function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function parseLineSuffix(path: string): ProjectFileLink {
  // Model answers often cite files as README.md:3 or src/App.tsx:120:8.
  // Keep the display line while preventing it from becoming part of the filename.
  const match = /:(\d+)(?::\d+)?$/.exec(path);
  if (!match) {
    return { path };
  }

  const line = Number(match[1]);
  return {
    path: path.slice(0, match.index ?? path.length),
    line: Number.isInteger(line) && line > 0 ? line : undefined,
  };
}

/** Path below root, or null. Drive paths compare case-insensitively, as Windows does. */
function relativeToRoot(path: string, root: string): string | null {
  const fold = isDrivePath(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
  const folded = fold(path);
  const foldedRoot = fold(root);
  if (folded === foldedRoot) return '';
  return folded.startsWith(`${foldedRoot}/`) ? path.slice(root.length + 1) : null;
}

export function getProjectFileLink(
  href: string | undefined,
  roots: Array<string | null | undefined>
): ProjectFileLink | null {
  const cwds = roots
    .map((root) => (root ? normalizeSlashPath(root).replace(/\/$/, '') : ''))
    .filter(Boolean);
  if (!href || cwds.length === 0) return null;

  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  const drivePath = DRIVE_URL.test(raw);
  if (!drivePath && /^(?:https?|mailto|tel|javascript|data|blob):/i.test(raw)) return null;
  if (!drivePath && /^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.toLowerCase().startsWith('file:')) {
    return null;
  }

  const lineHint = extractLineHint(raw);
  let path = raw;
  if (raw.toLowerCase().startsWith('file:')) {
    try {
      // file:///C:/Users/a.png has the pathname /C:/Users/a.png.
      path = decodeURIComponent(new URL(raw).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '');
    } catch {
      return null;
    }
  } else {
    path = stripHashAndQuery(raw);
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the raw path if it contains a partial percent escape.
    }
  }

  const parsed = parseLineSuffix(normalizeSlashPath(path.trim()));
  path = parsed.path;
  if (!path || path.includes('\0')) return null;

  const line = parsed.line ?? lineHint;
  if (path.startsWith('/') || isDrivePath(path)) {
    // 依次对齐已知根（session cwd、项目根）：worktree 会话里模型常引用
    // 主工作区的绝对路径，相对化后在 worktree 检出里打开同一文件。
    let relative: string | null = null;
    for (const normalizedCwd of cwds) {
      relative = relativeToRoot(path, normalizedCwd);
      if (relative === '') return null;
      if (relative !== null) break;
    }
    if (relative === null) {
      // 不属于任何根、但确实像本机文件的绝对路径 → 面板按外部文件打开，
      // 而不是丢给系统浏览器；网页式的 /pricing 之类保持原有外链行为。
      return looksLikeRevealablePath(path) ? { path, line, external: true } : null;
    }
    path = relative;
  }

  path = path.replace(/^\.\//, '');
  return path && path !== '.' ? { path, line } : null;
}

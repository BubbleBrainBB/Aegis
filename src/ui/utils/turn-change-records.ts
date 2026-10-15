import type { StreamMessage } from '../types';
import {
  extractGitPatchChangeRecords,
  extractToolChangeRecords,
  type ChangeRecord,
} from './change-records';

export interface TurnChangeSummary {
  turnIndex: number;
  /** Inclusive slice start in StreamMessage[] (the user_prompt of the turn, if any). */
  firstMessageIndex: number;
  /** Inclusive slice end in StreamMessage[]. */
  lastMessageIndex: number;
  /** Records merged per file path. */
  records: ChangeRecord[];
  /**
   * Whole-working-tree unified diff captured by the runner across this turn
   * (git tree snapshots), when the session cwd is a git repo. Covers edits
   * made outside Edit/Write tools (MCP servers, terminal commands), which
   * `records` never see. Null when unavailable or empty.
   */
  gitPatch: string | null;
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
}

export interface TurnChangeContext {
  turns: TurnChangeSummary[];
  /** Map tool_use id -> the raw ChangeRecord produced by that tool call. */
  changeRecordByToolUseId: Map<string, ChangeRecord>;
  /** Map tool_use id -> all raw ChangeRecords produced by that tool call. */
  changeRecordsByToolUseId: Map<string, ChangeRecord[]>;
}

/** Forward slashes, `.`/`..` collapsed; null when `..` climbs above the start. */
function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '..') {
      if (parts.length === 0 || parts[parts.length - 1] === '') return null;
      parts.pop();
    } else if (part !== '.' && (part || parts.length === 0)) {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * Whether a change record's path lies inside the session cwd. Relative paths
 * are cwd-relative unless they climb out with `..`; `~` paths are treated as
 * outside (the renderer doesn't know the home directory, and agents address
 * project files by cwd-relative or absolute paths).
 */
export function isPathInsideCwd(filePath: string, cwd: string): boolean {
  const path = normalizePath(filePath);
  if (path === null || path.startsWith('~')) return false;
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) return true;
  const root = normalizePath(cwd);
  if (!root) return false;
  const caseFold = /^[A-Za-z]:\//.test(root);
  const [p, r] = caseFold ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return p === r || p.startsWith(`${r}/`);
}

/**
 * Walks messages and groups tool-induced change records by "turn", where a turn
 * is every message between two consecutive `user_prompt` entries (including the
 * leading prompt of each segment).
 *
 * With `cwd`, tool records outside it are left out of the turn summaries: the
 * card and review describe what the turn did to the project, and the git
 * snapshot that normally wins already ignores files outside the repo. The
 * per-tool maps keep every record for trace-row hints.
 */
export function buildTurnChangeContext(
  messages: StreamMessage[],
  cwd?: string | null
): TurnChangeContext {
  const turns: TurnChangeSummary[] = [];
  const changeRecordByToolUseId = new Map<string, ChangeRecord>();
  const changeRecordsByToolUseId = new Map<string, ChangeRecord[]>();

  let turnStart = 0;
  let pendingTurnIndex = 0;

  const flush = (endExclusive: number) => {
    if (endExclusive <= turnStart) return;
    const slice = messages.slice(turnStart, endExclusive);
    const records = extractToolChangeRecords(slice);
    // Subagent-made changes belong to the subagent's own card (SubagentPanel);
    // the turn card aggregates only the main agent's own edits. The per-tool
    // maps below still index ALL records so hover hints inside subagent lanes
    // keep resolving.
    const mainRecords = extractToolChangeRecords(
      slice.filter((msg) => !(msg as { parentToolUseId?: string }).parentToolUseId)
    );

    for (const record of records) {
      if (record.toolUseId) {
        changeRecordByToolUseId.set(record.toolUseId, record);
        const existing = changeRecordsByToolUseId.get(record.toolUseId);
        if (existing) {
          existing.push(record);
        } else {
          changeRecordsByToolUseId.set(record.toolUseId, [record]);
        }
      }
    }

    const merged = mergeRecordsByPath(
      cwd ? mainRecords.filter((record) => isPathInsideCwd(record.filePath, cwd)) : mainRecords
    );

    // The runner emits one `turn_changes` message per completed turn (git
    // tree-snapshot diff); take the last one in this segment. A turn with a
    // git patch but zero tool records (e.g. MCP-only edits) still counts as
    // a turn with changes — unless the patch is explained by subagent
    // records, in which case the subagent's card owns the display.
    let gitPatch: string | null = null;
    let gitPatchTruncated = false;
    for (const msg of slice) {
      if (msg.type === 'system' && msg.subtype === 'turn_changes' && msg.turnChanges.patch.trim()) {
        gitPatch = msg.turnChanges.patch;
        gitPatchTruncated = msg.turnChanges.truncated;
      }
    }

    const hasSubagentRecords = records.length > mainRecords.length;
    const patchRecords = gitPatch && !gitPatchTruncated && !hasSubagentRecords
      ? extractGitPatchChangeRecords(gitPatch)
      : [];
    // A completed turn's Git tree snapshot is the source of truth. Tool
    // records remain useful while a turn is running and for non-git sessions,
    // but they can miss apply_patch/exec_command edits or infer false paths
    // from shell syntax such as >/dev/null.
    const finalRecords = patchRecords.length > 0 ? patchRecords : merged;
    if (finalRecords.length > 0 || (gitPatch && !hasSubagentRecords)) {
      turns.push({
        turnIndex: pendingTurnIndex,
        firstMessageIndex: turnStart,
        lastMessageIndex: endExclusive - 1,
        records: finalRecords,
        gitPatch,
        totalFiles: finalRecords.length,
        totalAdded: finalRecords.reduce((sum, r) => sum + r.addedLines, 0),
        totalRemoved: finalRecords.reduce((sum, r) => sum + r.removedLines, 0),
      });
    }
    pendingTurnIndex += 1;
    turnStart = endExclusive;
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.type === 'user_prompt' && i > turnStart) {
      flush(i);
    }
  }
  flush(messages.length);

  return { turns, changeRecordByToolUseId, changeRecordsByToolUseId };
}

/**
 * Change summary for ONE subagent's message slice (the messages grouped under
 * its Task tool_use id). Same per-path merging as the main turn card; no git
 * patch — tree snapshots are captured per main turn, not per subagent. The
 * message indices are slice-local and only satisfy the summary shape; they
 * are meaningless against `session.messages`.
 */
export function buildSubagentChangeSummary(
  messages: StreamMessage[],
  cwd?: string | null
): TurnChangeSummary | null {
  if (messages.length === 0) return null;
  const records = extractToolChangeRecords(messages).filter(
    (record) => !cwd || isPathInsideCwd(record.filePath, cwd)
  );
  if (records.length === 0) return null;
  const merged = mergeRecordsByPath(records);
  return {
    turnIndex: 0,
    firstMessageIndex: 0,
    lastMessageIndex: messages.length - 1,
    records: merged,
    gitPatch: null,
    totalFiles: merged.length,
    totalAdded: merged.reduce((sum, r) => sum + r.addedLines, 0),
    totalRemoved: merged.reduce((sum, r) => sum + r.removedLines, 0),
  };
}

function mergeRecordsByPath(records: ChangeRecord[]): ChangeRecord[] {
  const byPath = new Map<string, ChangeRecord>();
  for (const record of records) {
    const existing = byPath.get(record.filePath);
    if (!existing) {
      byPath.set(record.filePath, { ...record });
      continue;
    }

    existing.addedLines += record.addedLines;
    existing.removedLines += record.removedLines;

    if (record.operation === 'delete') {
      existing.operation = 'delete';
    } else if (existing.operation !== 'write' && record.operation === 'write') {
      existing.operation = 'write';
    }

    if (record.diffContent) {
      existing.diffContent = existing.diffContent
        ? `${existing.diffContent}\n${record.diffContent}`
        : record.diffContent;
    }

    if (record.state === 'pending') {
      existing.state = 'pending';
    }
  }
  return Array.from(byPath.values());
}

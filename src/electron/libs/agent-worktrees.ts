import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { StreamMessage } from '../../shared/types';
import { commandOf } from './agent-pull-requests';
import { captureGitTreeSnapshot, diffGitTreeSnapshots, worktreeStartCommit, type TurnTreeDiff } from './git-turn-snapshot';
import * as sessions from './session-store';

const exec = promisify(execFile);

// git run as a command (start, after a shell operator, or as `zsh -lc`'s
// script), not the words inside a grep pattern or commit message.
const WORKTREE_ADD = /(?:^|(?<!\\)[;&|(\n]|\s-\w*c\s+['"]?)\s*git\s+(?:-C\s+\S+\s+)?worktree\s+add\b([^;&|)\n]*)/g;
const SHELL_WORD = /"[^"]*"|'[^']*'|[^\s"']+/g;
// The add itself failed: its branch may well be someone else's worktree. A later
// step of the same command failing doesn't undo the add, so is_error can't tell.
const ADD_REFUSED = /fatal: .*already (?:exists|used|checked out)/;

/** `git worktree add` calls still waiting for their output, by tool_use id. */
const pendingAdds = new Map<string, { sessionId: string; branches: string[] }>();
/** Branches a session's agent gave a worktree and has not changed yet, with whether that worktree has been seen. */
const unworked = new Map<string, Map<string, boolean>>();
/** Sessions being checked; true when another check should follow. */
const checking = new Map<string, boolean>();
/** The check running for a session, settled once no other check follows. */
const checks = new Map<string, Promise<void>>();

/**
 * The branch a `git worktree add` argument list leaves checked out, as git
 * would pick it. Detached checkouts have none: agents use those to build or
 * test a commit, and they are not where the session's work lives.
 */
function branchFromArguments(args: string): string | null {
  const words = (args.match(SHELL_WORD) ?? [])
    .map(word => word.replace(/^['"]|['"]$/g, ''))
    .filter(word => !/^\d*>/.test(word));
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '-d' || word === '--detach' || word === '--orphan') return null;
    if (word === '-b' || word === '-B') return words[i + 1] ?? null;
    if (word === '--reason') i++;
    else if (!word.startsWith('-')) positional.push(word);
  }
  return positional[1] ?? (positional[0] ? basename(positional[0]) : null);
}

export function worktreeBranchesAddedBy(command: string): string[] {
  return [...command.matchAll(WORKTREE_ADD)].flatMap(match => branchFromArguments(match[1]) ?? []);
}

async function git(cwd: string, args: string[]) {
  return (await exec('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

/** Linked worktrees on a branch, by branch. The main checkout is listed first and left out. */
async function linkedWorktrees(cwd: string) {
  const entries = (await git(cwd, ['worktree', 'list', '--porcelain'])).split(/\n\s*\n/).slice(1);
  const byBranch = new Map<string, string>();
  for (const entry of entries) {
    const path = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && branch) byBranch.set(branch, path);
  }
  return byBranch;
}

/** Uncommitted changes, or a HEAD that has moved since `git worktree add`. */
async function hasWork(path: string) {
  if (await git(path, ['status', '--porcelain'])) return true;
  const heads = (await git(path, ['reflog', 'show', 'HEAD', '--format=%H'])).split('\n');
  return new Set(heads).size > 1;
}

async function checkUnworked(sessionId: string, onFollow: (path: string) => void) {
  const branches = unworked.get(sessionId);
  const row = sessions.getSession(sessionId);
  const cwd = row?.worktree_path || row?.cwd || row?.project_cwd;
  if (!branches || !row || !cwd) return;
  // Listed from the session's folder, so another repository's worktrees never match.
  const [worktrees, here] = await Promise.all([linkedWorktrees(cwd), git(cwd, ['rev-parse', '--show-toplevel'])]);
  let followed: string | null = null;
  for (const [branch, seen] of [...branches]) {
    const path = worktrees.get(branch);
    if (!path) {
      // Not there yet when the agent's shell runs it in the background; gone once it was seen.
      if (seen) branches.delete(branch);
    } else if (path === here) {
      branches.delete(branch);
    } else if (await hasWork(path)) {
      branches.delete(branch);
      followed = path;
    } else {
      branches.set(branch, true);
    }
  }
  if (!branches.size) unworked.delete(sessionId);
  if (followed && followed !== row.agent_worktree_path) {
    sessions.setSessionAgentWorktree(sessionId, followed);
    onFollow(followed);
  }
}

async function runCheck(sessionId: string, onFollow: (path: string) => void) {
  if (checking.has(sessionId)) {
    checking.set(sessionId, true);
    return;
  }
  const check = (async () => {
    do {
      checking.set(sessionId, false);
      await checkUnworked(sessionId, onFollow).catch(() => undefined);
    } while (checking.get(sessionId));
    checking.delete(sessionId);
    checks.delete(sessionId);
  })();
  checks.set(sessionId, check);
  await check;
}

/**
 * The worktree a session's agent works in, once the checks its latest tool
 * results started are done, so a turn ending right after the agent's first
 * edit there already sees it.
 */
export async function settledAgentWorktree(sessionId: string): Promise<string | null> {
  await checks.get(sessionId);
  try {
    return sessions.getSession(sessionId)?.agent_worktree_path || null;
  } catch {
    return null;
  }
}

/**
 * Learns that a session's agent moved its work into a worktree it made itself.
 * Shell syntax can't tell where later commands ran and providers don't report
 * it, so git decides: a branch this session's main agent ran `git worktree add`
 * for counts once that worktree holds changes or commits. Reading or running
 * something in another folder never does.
 */
export function observeAgentWorktree(sessionId: string, message: StreamMessage, onFollow: (path: string) => void): void {
  if ((message.type !== 'assistant' && message.type !== 'user') || !Array.isArray(message.message.content)) return;
  let sawResult = false;
  for (const block of message.message.content) {
    if (block.type === 'tool_use' && !message.parentToolUseId) {
      const branches = worktreeBranchesAddedBy(commandOf(block.input ?? {}));
      if (branches.length) pendingAdds.set(block.id, { sessionId, branches });
    } else if (block.type === 'tool_result') {
      sawResult = true;
      const add = pendingAdds.get(block.tool_use_id);
      if (add?.sessionId === sessionId) {
        pendingAdds.delete(block.tool_use_id);
        if (typeof block.content === 'string' && ADD_REFUSED.test(block.content)) continue;
        const branches = unworked.get(sessionId) ?? new Map<string, boolean>();
        add.branches.forEach(branch => branches.set(branch, false));
        unworked.set(sessionId, branches);
      }
    }
  }
  if (sawResult && unworked.has(sessionId)) void runCheck(sessionId, onFollow);
}

/**
 * Turn diffs for the worktree a session's agent works in. The runner's turn
 * snapshots are taken in the session's folder, which the agent left, so its
 * turns would show no changes. Each turn starts from the last one's snapshot;
 * a worktree first seen at the end of a turn starts from the commit it was
 * added at.
 */
export function createAgentWorktreeTurns(sessionId: string) {
  let path: string | null = null;
  let tree: string | null = null;
  return {
    /** Before the first turn: the snapshot a worktree followed already starts from. */
    async start(): Promise<void> {
      const worktree = await settledAgentWorktree(sessionId);
      const snapshot = worktree ? await captureGitTreeSnapshot(worktree) : null;
      if (worktree && snapshot) {
        path = worktree;
        tree = snapshot;
      }
    },
    /**
     * What this turn changed in the worktree, null when nothing. With
     * `namePaths`, its paths start with the worktree's folder name, for a
     * turn that changed the session's folder too.
     */
    async end(namePaths: boolean): Promise<TurnTreeDiff | null> {
      const worktree = await settledAgentWorktree(sessionId);
      if (!worktree) {
        path = tree = null;
        return null;
      }
      const after = await captureGitTreeSnapshot(worktree);
      // A failed snapshot keeps the baseline: the changes roll into the next turn.
      if (!after) return null;
      const before = worktree === path ? tree : await worktreeStartCommit(worktree);
      path = worktree;
      tree = after;
      if (!before) return null;
      const diff = await diffGitTreeSnapshots(worktree, before, after, namePaths ? `${basename(worktree)}/` : '');
      return diff.patch.trim() ? diff : null;
    },
  };
}

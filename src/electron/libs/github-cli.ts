import { execFile } from 'child_process';
import type { PullRequestCheckItem, PullRequestCheckState } from '../../shared/types';

/**
 * The machine's `gh` CLI, as Aegis asks GitHub anything: it reuses the
 * person's own login, so no token is kept here. Used by the pull request
 * directory (pull-requests.ts) and by the main bot's waits (main-bot/).
 */

const GH_TIMEOUT_MS = 20_000;

export class GhCliError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_installed' | 'auth_required' | 'command_failed'
  ) {
    super(message);
    this.name = 'GhCliError';
  }
}

export function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = String(stderr || error.message || '').trim();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new GhCliError(
              'GitHub CLI (gh) was not found. Install it with `brew install gh`.',
              'not_installed'
            )
          );
          return;
        }
        if (/auth login|authentication|HTTP 401|Bad credentials/i.test(detail)) {
          reject(
            new GhCliError(
              'GitHub CLI is not signed in. Run `gh auth login`, then retry.',
              'auth_required'
            )
          );
          return;
        }
        reject(new GhCliError(detail || 'gh command failed.', 'command_failed'));
      }
    );
  });
}

export async function runGhJson<T>(args: string[]): Promise<T> {
  const stdout = await runGh(args);
  return JSON.parse(stdout) as T;
}

/**
 * Roll the per-check statuses up into one chip state plus per-check items.
 * Rollup entries mix CheckRun ({name, status, conclusion, detailsUrl}) and
 * StatusContext ({context, state, targetUrl}) shapes.
 */
export function rollupChecks(
  rollup: Array<Record<string, unknown>> | undefined
): { state: PullRequestCheckState; summary: string; items: PullRequestCheckItem[] } {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) {
    return { state: 'none', summary: 'No checks', items: [] };
  }

  const items: PullRequestCheckItem[] = checks.map((check) => {
    const name = String(check.name || check.context || 'check');
    const workflowName = typeof check.workflowName === 'string' ? check.workflowName : undefined;
    const url =
      typeof check.detailsUrl === 'string'
        ? check.detailsUrl
        : typeof check.targetUrl === 'string'
          ? check.targetUrl
          : undefined;
    const status = String(check.status || '').toUpperCase();
    const conclusion = String(check.conclusion || check.state || '').toUpperCase();
    let state: PullRequestCheckItem['state'];
    // A commit status has no `status`: its `state` says PENDING while it is still out.
    if ((status && status !== 'COMPLETED') || conclusion === 'PENDING') {
      state = 'pending';
    } else if (['SUCCESS', 'EXPECTED'].includes(conclusion)) {
      state = 'passed';
    } else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'].includes(conclusion)) {
      state = 'failed';
    } else if (conclusion === 'SKIPPED') {
      state = 'skipped';
    } else {
      state = 'neutral';
    }
    return { name, workflowName, state, url };
  });

  const failed = items.filter((item) => item.state === 'failed').length;
  const pending = items.filter((item) => item.state === 'pending').length;
  if (failed > 0) {
    return { state: 'failure', summary: `${failed} of ${items.length} checks failing`, items };
  }
  if (pending > 0) {
    return { state: 'pending', summary: `${pending} of ${items.length} checks running`, items };
  }
  return { state: 'success', summary: 'Checks successful', items };
}

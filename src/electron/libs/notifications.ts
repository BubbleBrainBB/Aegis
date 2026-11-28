import { Notification, app } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SessionRow } from '../types';
import { parseTurnReport, turnReportLabel } from '../../shared/turn-report';

export interface NotificationSettings {
  enabled: boolean;
  // 仅在窗口失焦/隐藏时弹（前台工作不打扰）
  onlyWhenUnfocused: boolean;
  inputRequired: boolean;
  approvalRequired: boolean;
}

export type NotificationActivateTarget = { kind: 'session'; sessionId: string };

const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, onlyWhenUnfocused: true, inputRequired: true, approvalRequired: true };

let cachedSettings: NotificationSettings | null = null;
let isWindowFocused: () => boolean = () => false;
let onActivate: ((target: NotificationActivateTarget) => void) | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'notification-settings.json');
}

export function getNotificationSettings(): NotificationSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    cachedSettings = {
      enabled: parsed.enabled !== false,
      onlyWhenUnfocused: parsed.onlyWhenUnfocused !== false,
      inputRequired: typeof parsed.inputRequired === 'boolean' ? parsed.inputRequired : parsed.enabled !== false,
      approvalRequired: typeof parsed.approvalRequired === 'boolean' ? parsed.approvalRequired : parsed.enabled !== false,
    };
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
  }
  return cachedSettings;
}

export function setNotificationSettings(next: Partial<NotificationSettings>): NotificationSettings {
  const merged = { ...getNotificationSettings() };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof NotificationSettings)[]) {
    if (typeof next[key] === 'boolean') merged[key] = next[key];
  }
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  cachedSettings = merged;
  return merged;
}

export function configureNotifications(input: {
  isWindowFocused: () => boolean;
  onActivate: (target: NotificationActivateTarget) => void;
}): void {
  isWindowFocused = input.isWindowFocused;
  onActivate = input.onActivate;
}

function shouldNotify(kind: 'done' | 'input' | 'approval' | 'asked'): boolean {
  const settings = getNotificationSettings();
  if ((kind === 'done' || kind === 'asked') && !settings.enabled) return false;
  if (kind === 'input' && !settings.inputRequired) return false;
  if (kind === 'approval' && !settings.approvalRequired) return false;
  if (!Notification.isSupported()) return false;
  // What the person asked to be told shows wherever they are: in the app they may well be in another task.
  if (kind === 'asked') return true;
  if ((kind === 'done' ? settings.onlyWhenUnfocused : true) && isWindowFocused()) return false;
  return true;
}

function show(title: string, body: string, target: NotificationActivateTarget, kind: 'done' | 'input' | 'approval' | 'asked' = 'done'): void {
  if (!shouldNotify(kind)) return;
  try {
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => onActivate?.(target));
    notification.show();
  } catch (error) {
    // 通知失败绝不阻塞执行
    console.warn('[Notifications] failed to show notification:', error);
  }
}

export function isQuestionRequest(toolName: string, input: unknown): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'Question'
    || (!!input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions));
}

const inputNotices = new Set<string>();
export function notifySessionInput(row: SessionRow, requestId: string, question: boolean): void {
  const key = `${row.id}:${requestId}`;
  if (inputNotices.has(key)) return;
  inputNotices.add(key);
  if (inputNotices.size > 1000) inputNotices.delete(inputNotices.values().next().value!);
  show(question ? 'Agent needs your input' : 'Agent needs approval', row.title || 'Untitled thread',
    { kind: 'session', sessionId: row.id }, question ? 'input' : 'approval');
}

/**
 * A wait of the main bot ended: what it waited for happened, or its deadline
 * came. The person asked to be told, so it shows also while they are in the
 * app (they may be in another task); only switching notifications off stops
 * it. A wait that ends unheard, or is called off, never comes here.
 */
export function notifyWaitOver(sessionId: string, title: string, body: string): void {
  show(title, body, { kind: 'session', sessionId }, 'asked');
}

/**
 * `announced`: what the turn was about has already been shown as a
 * notification of its own (a wait that ended), so a plain "finished" would
 * only say it twice. A question, a blocker or a failure still shows.
 */
export function notifySessionDone(row: SessionRow, options: { backgroundWork?: boolean; announced?: boolean } = {}): void {
  const failed = row.status === 'error';
  // The agent's report says how the turn ended (shared/turn-report.ts): a
  // question or blocker is input the user owes; a turn with nothing to change
  // gives them nothing to act on. "in_progress" is quiet only while a task is
  // alive: with none, nothing will wake the agent to report later.
  const report = failed ? null : parseTurnReport(row.turn_report);
  if (report?.outcome === 'nothing_to_do') return;
  if (report?.outcome === 'in_progress' && options.backgroundWork) return;
  if (report && report.outcome !== 'in_progress') {
    show(
      report.outcome === 'question' ? 'Agent needs your input' : `Agent is ${turnReportLabel(report.outcome).toLowerCase()}`,
      `${row.title || 'Untitled thread'}: ${report.question || report.summary}`,
      { kind: 'session', sessionId: row.id },
      'input',
    );
    return;
  }
  if (options.announced && !failed) return;
  show(
    failed ? 'Agent run failed' : 'Agent run finished',
    row.title || 'Untitled thread',
    { kind: 'session', sessionId: row.id }
  );
}

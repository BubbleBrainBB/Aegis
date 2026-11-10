import { rendererStateStorage } from './renderer-state-storage';
import type { ClaudeModelConfig, ClaudeModelInfo } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeModel';
const CONTEXT_1M_STORAGE_KEY = 'cowork.preferredClaudeContext1m';

// The aliases the runner keeps as aliases (claude-model-selection.ts). Any other
// bare value Claude Code lists is left out of the picker; its models are still
// offered by id.
const CLAUDE_SHORT_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

function parseClaudeShortAlias(model: string | null | undefined): 'sonnet' | 'opus' | 'haiku' | null {
  const normalized = canonicalizeClaudeModel(model);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  return CLAUDE_SHORT_ALIASES.has(lower) ? (lower as 'sonnet' | 'opus' | 'haiku') : null;
}

export function canonicalizeClaudeModel(model: string | null | undefined): string | null {
  const normalized = model?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\[1m\]$/i, '');
}

type ClaudeModelVersion = { family: string; major: number; minor: number | null };

// Reads any 'claude-<family>-<major>[-<minor>]' id, so a new family or
// generation needs no change here. A trailing date ('-20251001') is not a minor.
function parseClaudeModelFamily(model: string | null | undefined): ClaudeModelVersion | null {
  const normalized = canonicalizeClaudeModel(model);
  if (!normalized) return null;
  const match = normalized.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=-|$)/i);
  if (!match) return null;
  return { family: match[1].toLowerCase(), major: Number(match[2]), minor: match[3] ? Number(match[3]) : null };
}

function isNewerClaudeVersion(a: ClaudeModelVersion, b: ClaudeModelVersion): boolean {
  return a.major > b.major || (a.major === b.major && (a.minor ?? 0) > (b.minor ?? 0));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function loadPreferredClaudeModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = rendererStateStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return canonicalizeClaudeModel(raw);
}

export function savePreferredClaudeModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    rendererStateStorage.removeItem(STORAGE_KEY);
    return;
  }
  rendererStateStorage.setItem(STORAGE_KEY, canonicalizeClaudeModel(model) || model);
}

export function loadPreferredClaudeContext1m(): boolean {
  if (typeof window === 'undefined') return false;
  return rendererStateStorage.getItem(CONTEXT_1M_STORAGE_KEY) === 'true';
}

export function savePreferredClaudeContext1m(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(CONTEXT_1M_STORAGE_KEY, enabled ? 'true' : 'false');
}

export function supportsClaude1mContext(model?: string | null): boolean {
  const alias = parseClaudeShortAlias(model);
  if (alias === 'sonnet' || alias === 'opus') {
    return true;
  }
  const parsed = parseClaudeModelFamily(model);
  if (!parsed) return false;
  return parsed.family === 'sonnet' || parsed.family === 'opus';
}

export function isOfficialClaudeModel(model?: string | null): boolean {
  const normalized = canonicalizeClaudeModel(model) || model?.trim() || '';
  if (!normalized) return false;
  return normalized.startsWith('claude-') || CLAUDE_SHORT_ALIASES.has(normalized.toLowerCase());
}

// The row Claude Code lists for a model; a '[1m]' row stands in when it is the only one.
function listedClaudeModel(model: string, listed?: readonly ClaudeModelInfo[] | null): ClaudeModelInfo | undefined {
  return (
    listed?.find((entry) => entry.id === model) ??
    listed?.find((entry) => canonicalizeClaudeModel(entry.id) === model)
  );
}

// The version an entry stands for: its own for a model id; for an alias, the
// one Claude Code (`listed`, ClaudeModelConfig.listed) says it resolves to.
function resolveClaudeModelVersion(
  model: string,
  listed?: readonly ClaudeModelInfo[] | null
): ClaudeModelVersion | null {
  const alias = parseClaudeShortAlias(model);
  if (!alias) return parseClaudeModelFamily(model);
  const resolved = parseClaudeModelFamily(listedClaudeModel(alias, listed)?.resolvedModel);
  return resolved?.family === alias ? resolved : null;
}

/**
 * The name shown for a model, read from its id ('claude-fable-5-2' → 'Fable
 * 5.2'), or for an alias from the id it resolves to. Claude Code's own display
 * name is used only when the id has no version to read: the name is not
 * always the full one (a CLI that cannot see the account says just 'Opus').
 */
export function formatClaudeModelLabel(model: string, listed?: readonly ClaudeModelInfo[] | null): string {
  const normalized = canonicalizeClaudeModel(model) || model.trim();
  const version = resolveClaudeModelVersion(normalized, listed);
  if (version) {
    const number = version.minor === null ? `${version.major}` : `${version.major}.${version.minor}`;
    return `${capitalize(version.family)} ${number}`;
  }

  const alias = parseClaudeShortAlias(normalized);
  if (alias) return `${capitalize(alias)} (latest)`;
  return listedClaudeModel(normalized, listed)?.label || model;
}

// Collapse each Claude family to its newest entry and drop superseded versions.
// Versions are read from the ids, so a newer generation or a new family wins
// with no model list to maintain. An alias counts as the version Claude Code
// says it resolves to (`listed`), or as the newest when that is unknown, and
// wins a tie with the id it stands for, since it keeps tracking the newest.
// Entries with no version (third-party ids) pass through untouched, and
// anything in `protectedModels` (e.g. the currently selected model) is kept.
function collapseClaudeFamiliesToLatest(
  models: string[],
  protectedModels: Set<string> = new Set(),
  listed?: readonly ClaudeModelInfo[] | null
): string[] {
  const versionOf = (model: string): ClaudeModelVersion | null => {
    const alias = parseClaudeShortAlias(model);
    return resolveClaudeModelVersion(model, listed) ?? (alias ? { family: alias, major: Infinity, minor: null } : null);
  };

  const latestByFamily = new Map<string, { id: string; version: ClaudeModelVersion; alias: boolean }>();
  for (const model of models) {
    const version = versionOf(model);
    if (!version) continue;
    const alias = parseClaudeShortAlias(model) !== null;
    const current = latestByFamily.get(version.family);
    const newer = !current || isNewerClaudeVersion(version, current.version);
    const sameAsAlias = current && alias && !current.alias && !isNewerClaudeVersion(current.version, version);
    if (newer || sameAsAlias) latestByFamily.set(version.family, { id: model, version, alias });
  }

  return models.filter((model) => {
    if (protectedModels.has(model)) return true;
    const version = versionOf(model);
    return !version || latestByFamily.get(version.family)?.id === model;
  });
}

/**
 * The listed family alias a concrete model id stands for. A session records
 * the id the CLI resolved an alias to ("haiku" → "claude-haiku-5-5"); the
 * picker lists the alias, so the id would otherwise match nothing. Only when
 * no listed version of that family is newer: an older pinned id stays itself.
 */
export function listedClaudeAliasFor(model: string | null | undefined, listed: readonly string[]): string | null {
  const parsed = parseClaudeModelFamily(model);
  if (!parsed) return null;
  const alias = listed.find((value) => parseClaudeShortAlias(value) === parsed.family);
  if (!alias) return null;
  const newer = listed.some((value) => {
    const other = parseClaudeModelFamily(value);
    return other?.family === parsed.family && isNewerClaudeVersion(other, parsed);
  });
  return newer ? null : alias;
}

export function buildClaudeModelOptions(
  config: ClaudeModelConfig,
  extraModels: Array<string | null | undefined> = []
): string[] {
  const normalizedConfigValues = [config.defaultModel, ...config.options]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());
  const normalizedExtras = extraModels
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());

  const all = Array.from(new Set([...normalizedConfigValues, ...normalizedExtras]));
  return collapseClaudeFamiliesToLatest(all, new Set(normalizedExtras), config.listed);
}

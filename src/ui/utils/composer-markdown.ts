/**
 * Live Markdown styling for the composer. The composer stays a plain-text
 * editor: syntax characters remain in the DOM and only receive styles, so
 * serialization, caret offsets and the sent prompt are unchanged. Completed
 * syntax hides its markers until the caret moves back into it (Typora-style).
 */
export const MD_MARKER = 1;
export const MD_STRONG = 2;
export const MD_EM = 4;
export const MD_STRIKE = 8;
export const MD_CODE = 16;
export const MD_CODE_BLOCK = 32;
export const MD_LINK = 64;
export const MD_QUOTE = 128;
export const MD_LIST = 256;
export const MD_H1 = 512;
export const MD_H2 = 1024;
export const MD_H3 = 2048;

const CLASS_NAMES: Array<[number, string]> = [
  [MD_MARKER, 'marker'],
  [MD_STRONG, 'strong'],
  [MD_EM, 'em'],
  [MD_STRIKE, 'strike'],
  [MD_CODE, 'code'],
  [MD_CODE_BLOCK, 'codeblock'],
  [MD_LINK, 'link'],
  [MD_QUOTE, 'quote'],
  [MD_LIST, 'list'],
  [MD_H1, 'h1'],
  [MD_H2, 'h2'],
  [MD_H3, 'h3'],
];

/**
 * A completed syntax element whose markers hide while the caret is outside.
 * Inline tokens reveal for `start <= caret < end` (so the caret right after
 * a closing marker keeps it hidden); block tokens reveal anywhere on the line.
 */
export interface MarkdownToken {
  start: number;
  end: number;
  block: boolean;
}

export interface MarkdownStyles {
  /** Style flags per UTF-16 unit. */
  flags: Uint16Array;
  /** Index into `tokens` for hideable marker units, otherwise -1. */
  tokenOf: Int32Array;
  tokens: MarkdownToken[];
}

// Atomic chips (mentions, links, slash tokens) are masked with an object
// replacement char so their raw text can never open or close Markdown syntax.
const ATOMIC = '\uFFFC';
// Syntax characters already claimed by an earlier inline rule.
const USED = '\u0000';

export function markdownClassName(flags: number): string {
  let className = 'composer-md';
  for (const [flag, name] of CLASS_NAMES) {
    if (flags & flag) className += ` composer-md--${name}`;
  }
  return className;
}

export function isMarkdownTokenActive(token: MarkdownToken, caret: number): boolean {
  return token.block ? caret >= token.start && caret <= token.end : caret >= token.start && caret < token.end;
}

interface Marker {
  mark: (start: number, end: number, flags: number) => void;
  /** Marks hideable syntax `[start, end)` belonging to `token`. */
  hide: (start: number, end: number, flags: number, token: number) => void;
  token: (start: number, end: number, block: boolean) => number;
}

const INLINE_PAIRS: Array<{ re: RegExp; flags: number; marker: number }> = [
  { re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/g, flags: MD_STRONG, marker: 2 },
  { re: /(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, flags: MD_STRONG, marker: 2 },
  { re: /~~(?=\S)(.+?)(?<=\S)~~/g, flags: MD_STRIKE, marker: 2 },
  { re: /\*(?=[^\s*])(.+?)(?<=[^\s*])\*/g, flags: MD_EM, marker: 1 },
  { re: /(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, flags: MD_EM, marker: 1 },
];

function markInline(line: string, offset: number, { mark, hide, token }: Marker): void {
  const chars = line.split('');
  const consume = (start: number, end: number) => chars.fill(USED, start, end);
  const matches = (re: RegExp) => Array.from(chars.join('').matchAll(re));

  for (const match of matches(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
    const start = match.index!;
    const end = start + match[0].length;
    const ticks = match[1]!.length;
    if (match[0].includes(ATOMIC)) continue;
    const id = token(offset + start, offset + end, false);
    hide(offset + start, offset + start + ticks, 0, id);
    hide(offset + end - ticks, offset + end, 0, id);
    mark(offset + start + ticks, offset + end - ticks, MD_CODE);
    consume(start, end);
  }

  for (const match of matches(/\[([^\]\n\u0000]+)\]\(([^)\s\u0000]*)\)/g)) {
    const start = match.index!;
    const labelEnd = start + 1 + match[1]!.length;
    const end = start + match[0].length;
    const id = token(offset + start, offset + end, false);
    hide(offset + start, offset + start + 1, 0, id);
    mark(offset + start + 1, offset + labelEnd, MD_LINK);
    hide(offset + labelEnd, offset + end, 0, id);
    consume(start, start + 1);
    consume(labelEnd, end);
  }

  for (const { re, flags, marker } of INLINE_PAIRS) {
    for (const match of matches(re)) {
      const start = match.index!;
      const end = start + match[0].length;
      const id = token(offset + start, offset + end, false);
      hide(offset + start, offset + start + marker, 0, id);
      hide(offset + end - marker, offset + end, 0, id);
      mark(offset + start + marker, offset + end - marker, flags);
      consume(start, start + marker);
      consume(end - marker, end);
    }
  }
}

/**
 * Markdown styles for `value`. `atomicRanges` are excluded from syntax
 * matching (their flags are still set when they sit inside a styled span,
 * which callers ignore).
 */
export function computeMarkdownStyles(
  value: string,
  atomicRanges: ReadonlyArray<{ start: number; end: number }> = []
): MarkdownStyles {
  const flags = new Uint16Array(value.length);
  const tokenOf = new Int32Array(value.length).fill(-1);
  const tokens: MarkdownToken[] = [];
  const marker: Marker = {
    mark: (start, end, flag) => {
      for (let index = start; index < end; index += 1) flags[index] |= flag;
    },
    hide: (start, end, flag, token) => {
      for (let index = start; index < end; index += 1) {
        flags[index] |= MD_MARKER | flag;
        tokenOf[index] = token;
      }
    },
    token: (start, end, block) => tokens.push({ start, end, block }) - 1,
  };
  const { mark, hide, token } = marker;
  let text = value;
  if (atomicRanges.length > 0) {
    const chars = value.split('');
    for (const range of atomicRanges) chars.fill(ATOMIC, range.start, range.end);
    text = chars.join('');
  }

  let fence: string | null = null;
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const start = lineStart;
    const end = start + line.length;
    lineStart = end + 1;

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes =
        fenceMatch &&
        fenceMatch[1]![0] === fence[0] &&
        fenceMatch[1]!.length >= fence.length &&
        !line.slice(fenceMatch[0].length).trim();
      mark(start, end, closes ? MD_MARKER | MD_CODE_BLOCK : MD_CODE_BLOCK);
      if (closes) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      mark(start, end, MD_MARKER | MD_CODE_BLOCK);
      continue;
    }

    let body = 0;
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const headingFlag = level === 1 ? MD_H1 : level === 2 ? MD_H2 : MD_H3;
      mark(start, end, headingFlag);
      if (heading[0].length < line.length) hide(start, start + heading[0].length, 0, token(start, end, true));
      else mark(start, end, MD_MARKER);
      body = heading[0].length;
    } else {
      const quote = /^ {0,3}>[ \t]?/.exec(line);
      if (quote) {
        hide(start, start + quote[0].length, MD_QUOTE, token(start, end, true));
        mark(start + quote[0].length, end, MD_QUOTE);
        body = quote[0].length;
      }
      const list = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(line.slice(body));
      if (list) {
        mark(start + body, start + body + list[0].length, MD_LIST);
        body += list[0].length;
      }
    }
    markInline(line.slice(body), start + body, marker);
  }
  return { flags, tokenOf, tokens };
}

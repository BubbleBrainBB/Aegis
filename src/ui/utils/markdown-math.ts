import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
// Bring in the math token names and the processor's parser data.
import type {} from 'micromark-extension-math';
import type {} from 'remark-parse';
import type { Construct, Extension, State, TokenizeContext, Tokenizer } from 'micromark-util-types';
import type { Pluggable, Processor } from 'unified';

const DOLLAR = 36;
const BACKSLASH = 92;

const isAsciiAlphanumeric = (code: number | null) =>
  code !== null && ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122));
const isLineEnding = (code: number | null) => code !== null && code < -2;
// Micromark codes for a space, a tab and the virtual spaces that pad a tab.
const isSpace = (code: number | null) => code === 32 || code === -2 || code === -1;
const canOpenAfter = (code: number | null) => code !== DOLLAR && !isAsciiAlphanumeric(code);

// An amount followed by a word, as in "$20 in US$" or "$5 a day (US$)". One
// letter alone stays math: "$2 x$".
const LEADING_AMOUNT = /^[\d.,]+[kKmMbB]?\s+(?:[A-Za-z]\s+)?[A-Za-z]{2}/;

/**
 * Single-dollar math, limited to spans that do not read as dollar amounts or
 * shell variables. The opening `$` has no letter or digit before it and no
 * space after it; the closing `$` has no space before it and no letter or digit
 * after it. A span stays on one line.
 *
 * It emits the tokens of micromark-extension-math, so mdast-util-math builds
 * the node. Parsing `$` here, not rewriting the source, keeps code spans and
 * fences out of it.
 */
const tokenizeInlineMath: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  const self = this;
  let body: ReturnType<typeof effects.enter>;

  const start: State = (code) => {
    // `previous` below doesn't guard this: micromark tries every `$` construct
    // once any one of them accepts the character before.
    if (!canOpenAfter(self.previous)) return nok(code);
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    effects.consume(code);
    effects.exit('mathTextSequence');
    return open;
  };

  const open: State = (code) => {
    if (code === null || code === DOLLAR || isSpace(code) || isLineEnding(code)) return nok(code);
    body = effects.enter('mathTextData');
    return data(code);
  };

  const data: State = (code) => {
    if (code === null || isLineEnding(code)) return nok(code);
    if (code === DOLLAR) {
      if (isSpace(self.previous)) return nok(code);
      effects.exit('mathTextData');
      if (LEADING_AMOUNT.test(self.sliceSerialize(body))) return nok(code);
      effects.enter('mathTextSequence');
      effects.consume(code);
      effects.exit('mathTextSequence');
      return close;
    }
    if (code === BACKSLASH) {
      effects.consume(code);
      return escaped;
    }
    effects.consume(code);
    return data;
  };

  const escaped: State = (code) => {
    if (code === DOLLAR || code === BACKSLASH) {
      effects.consume(code);
      return data;
    }
    return data(code);
  };

  const close: State = (code) => {
    if (code === DOLLAR || isAsciiAlphanumeric(code)) return nok(code);
    effects.exit('mathText');
    return ok(code);
  };

  return start;
};

const inlineMath: Construct = {
  name: 'inlineMathWithoutCurrency',
  tokenize: tokenizeInlineMath,
  previous: canOpenAfter,
};

function remarkInlineMath(this: Processor) {
  const data = this.data();
  const extension: Extension = { text: { [DOLLAR]: inlineMath } };
  (data.micromarkExtensions ??= []).push(extension);
}

// remark-math's own single-dollar rule reads any two dollar amounts in a
// paragraph as math, so it only handles `$$x$$` here.
export const markdownRemarkPlugins: Pluggable[] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkInlineMath,
];

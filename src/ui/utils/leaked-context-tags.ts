// Models sometimes echo context tags they were given, such as Claude's
// `<budget:remaining_tokens>15000000</budget:remaining_tokens>`. They mean
// nothing to the user; the chat drops them before rendering, including a tag
// still streaming in.
const COMPLETE = /<budget:([a-z_]+)>[^<]*<\/budget:\1>\s*/gi;
const STRAY_CLOSE = /<\/budget:[a-z_]+>\s*/gi;
const OPEN_AT_END = /<budget:[a-z_]+>[^<]*$/i;
const PARTIAL_OPEN_AT_END = /<(?:b(?:u(?:d(?:g(?:e(?:t(?::[a-z_]*)?)?)?)?)?)?)?$/i;

export function stripLeakedContextTags(text: string, streaming = false): string {
  if (!text.includes('<')) return text;
  let next = text.replace(COMPLETE, '').replace(STRAY_CLOSE, '');
  next = next.replace(OPEN_AT_END, '');
  // `<bud` mid-stream may be the start of the tag; hold it back until it resolves.
  if (streaming) next = next.replace(PARTIAL_OPEN_AT_END, '');
  return next;
}

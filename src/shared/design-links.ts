/** A board named in an agent's reply: `[Pricing](aegis://designs/<documentId>/<boardId>)`. */
export function parseDesignLink(value: string): { documentId: string; boardId: string } | null {
  // Match the entire value: a link only ever points at a board, nothing else in it is read.
  const match = /^aegis:\/\/designs\/([\w-]+)\/([\w-]+)$/.exec(value);
  return match ? { documentId: match[1], boardId: match[2] } : null;
}

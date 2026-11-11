/**
 * With summarized thinking, Claude returns the prose a model wrote ahead of a
 * tool call as a `thinking` block whose signature the server tags block_kind
 * "narration". It is what the model said to the user, not its reasoning: an
 * answer written before a report_status call arrives this way.
 *
 * The CLI lists these blocks per frame in `narration_block_indexes`; the
 * runner copies that onto the block as `narration`. Messages stored before
 * that carry only the signature, so its envelope is read as a fallback.
 */

type BlockLike = { type: string; thinking?: unknown; signature?: unknown; narration?: unknown };

/** A listed block with no text gets ordinary thinking treatment, as the CLI documents. */
export function isNarrationBlock(
  block: BlockLike
): block is BlockLike & { type: 'thinking'; thinking: string } {
  if (block.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking.trim()) return false;
  return block.narration === true || signatureBlockKind(block.signature) === 'narration';
}

/** Marks the blocks a Claude assistant frame lists in `narration_block_indexes`. */
export function markNarrationBlocks<T extends { content?: unknown }>(message: T, indexes: unknown): T {
  if (!Array.isArray(indexes) || indexes.length === 0 || !Array.isArray(message.content)) return message;
  const listed = new Set(indexes);
  return {
    ...message,
    content: message.content.map((block, index) =>
      listed.has(index) && block && typeof block === 'object' && (block as BlockLike).type === 'thinking'
        ? { ...block, narration: true }
        : block
    ),
  };
}

/**
 * Marks the narration blocks of a stored message from their signatures, for a
 * copy that is about to lose them (the one sent to another device).
 */
export function markNarrationFromSignatures<T extends { content?: unknown }>(message: T): T {
  if (!Array.isArray(message.content)) return message;
  const indexes = message.content.flatMap((block, index) =>
    block && typeof block === 'object' && isNarrationBlock(block as BlockLike) ? [index] : []
  );
  return markNarrationBlocks(message, indexes);
}

/** A narration block's prose, for readers that take a reply's text blocks; undefined for any other block. */
export function narrationText(block: unknown): string | undefined {
  return block && typeof block === 'object' && isNarrationBlock(block as BlockLike)
    ? (block as { thinking: string }).thinking.trim()
    : undefined;
}

// The envelope is protobuf: field 2 holds a message whose field 1 holds the
// block's metadata, with the kind as the string in field 8. They open the
// signature, so its head is enough.
const SIGNATURE_HEAD_CHARS = 128;

/** The server's block_kind for a thinking signature ("thinking", "narration"); undefined when it cannot be read. */
export function signatureBlockKind(signature: unknown): string | undefined {
  if (typeof signature !== 'string' || signature.length < 8) return undefined;
  let binary: string;
  try {
    binary = atob(signature.slice(0, SIGNATURE_HEAD_CHARS));
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const metadata = readField(readField(bytes, 2, true), 1);
  const kind = readField(metadata, 8);
  if (!kind) return undefined;
  let text = '';
  for (const byte of kind) {
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * The bytes of the first length-delimited field `wanted`. `allowCut` accepts a
 * field that runs past the bytes at hand (only the signature's head is decoded).
 */
function readField(bytes: Uint8Array | undefined, wanted: number, allowCut = false): Uint8Array | undefined {
  if (!bytes) return undefined;
  let offset = 0;
  const varint = (): number | undefined => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (offset >= bytes.length) return undefined;
      const byte = bytes[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return undefined;
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag === undefined) return undefined;
    const wireType = tag & 7;
    if (wireType === 0) {
      if (varint() === undefined) return undefined;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 2) {
      const length = varint();
      if (length === undefined) return undefined;
      const end = offset + length;
      if (tag >>> 3 === wanted) {
        if (end > bytes.length && !allowCut) return undefined;
        return bytes.subarray(offset, Math.min(end, bytes.length));
      }
      offset = end;
    } else {
      return undefined;
    }
  }
  return undefined;
}

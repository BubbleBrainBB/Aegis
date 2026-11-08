import { getGeneratedMediaKind, type GeneratedMediaItem } from '../../shared/generated-media';

/**
 * MiniMax Code ends answers that produce files with a delivery block its own
 * client turns into attachments:
 *
 *   <deliver-assets>
 *   <media type="image" src="/abs/shot.png" name="shot.png" />
 *   <media type="file" src="/abs/report.md" caption="Summary" />
 *   </deliver-assets>
 *
 * Images and videos join the turn's media gallery; other files become file
 * links where the block was. Blocks inside code are text, not deliveries.
 */
export interface DeliveredAsset {
  src: string;
  type: string;
  name?: string;
  caption?: string;
  deleted: boolean;
}

const BLOCK = /^[ \t]*<(deliver-assets|deliver_assets)\b[^>]*>([\s\S]*?)<\/\1\s*>[ \t]*$/gim;
const OPEN_TAIL = /^[ \t]*<(?:deliver-assets|deliver_assets)\b[\s\S]*$/im;
const MEDIA = /<media\b([^>]*?)\/?>/gi;
const ATTRIBUTE = /([\w-]+)\s*=\s*(["'])(.*?)\2/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
const OPEN_TAG = '<deliver-assets';

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseMedia(body: string): DeliveredAsset[] {
  const assets: DeliveredAsset[] = [];
  for (const match of body.matchAll(MEDIA)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1].matchAll(ATTRIBUTE)) {
      attributes[attribute[1].toLowerCase()] = decodeEntities(attribute[3]);
    }
    const src = attributes.src?.trim();
    if (!src) continue;
    assets.push({
      src,
      type: attributes.type?.toLowerCase() || getGeneratedMediaKind(src) || 'file',
      name: attributes.name || undefined,
      caption: attributes.caption || undefined,
      deleted: attributes.deleted === 'true',
    });
  }
  return assets;
}

/** Applies `replace` to the text outside fenced code blocks. */
function outsideFences(text: string, replace: (segment: string) => string): string {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    result += replace(text.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return result + replace(text.slice(last));
}

function isLocalPath(src: string): boolean {
  return src.startsWith('/') || /^[A-Za-z]:[\\/]/.test(src);
}

function galleryKind(asset: DeliveredAsset): GeneratedMediaItem['kind'] | null {
  if (asset.deleted || !isLocalPath(asset.src)) return null;
  const kind = getGeneratedMediaKind(asset.src);
  return kind && (asset.type === kind || asset.type === 'file' || !asset.type) ? kind : null;
}

/** Images and videos an answer delivers, for the turn's media gallery. */
export function extractDeliveredMedia(text: string): GeneratedMediaItem[] {
  if (!text.includes('deliver')) return [];
  const items: GeneratedMediaItem[] = [];
  outsideFences(text, (segment) => {
    for (const block of segment.matchAll(BLOCK)) {
      for (const asset of parseMedia(block[2])) {
        const kind = galleryKind(asset);
        if (kind) items.push({ path: asset.src, kind });
      }
    }
    return segment;
  });
  return items;
}

function escapeLabel(value: string): string {
  return value.replace(/([[\]\\])/g, '\\$1');
}

function basename(src: string): string {
  return src.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || src;
}

function assetLine(asset: DeliveredAsset): string {
  const label = escapeLabel(asset.name || basename(asset.src));
  const caption = asset.caption ? ` — ${asset.caption}` : '';
  if (asset.deleted) return `- ~~${label}~~ (deleted)${caption}`;
  const target = `<${asset.src}>`;
  const embed = getGeneratedMediaKind(asset.src) === 'image' && asset.type !== 'file' ? '!' : '';
  return `- ${embed}[${label}](${target})${caption}`;
}

/**
 * Replace delivery blocks with Markdown: files become links, images and videos
 * the gallery already shows are dropped. While an answer streams, a block that
 * has not closed yet is hidden instead of flashing as raw tags.
 */
export function renderDeliverAssets(text: string, inGallery: (path: string) => boolean): string {
  if (!text.includes('deliver') && !text.endsWith('<')) return text;
  const rendered = outsideFences(text, (segment) => segment
    .replace(BLOCK, (_block, _tag, body: string) => parseMedia(body)
      .filter((asset) => !(galleryKind(asset) && inGallery(asset.src)))
      .map(assetLine)
      .join('\n'))
    .replace(OPEN_TAIL, ''));
  // A tag still arriving token by token: "<deli", "<deliver-a"…
  for (let length = OPEN_TAG.length - 1; length >= 2; length -= 1) {
    if (rendered.endsWith(OPEN_TAG.slice(0, length))) return rendered.slice(0, -length).trimEnd();
  }
  return rendered.trimEnd();
}

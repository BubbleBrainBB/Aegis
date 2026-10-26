import { nativeImage } from "electron";
import { lstatSync, readFileSync } from "fs";
import { basename, extname, isAbsolute } from "path";

/**
 * Images for a design's boards: a file the agent made or found (a generated
 * image, a photo, a logo), a data URL, or bytes the user dropped or pasted.
 * Raster images wider or taller than MAX_SIDE are scaled down; SVG, WebP and
 * GIF are kept as they are. Stored per design (repository.addAsset) and used
 * on boards as aegis-asset:<id>.
 */
export interface DesignImage {
  bytes: Buffer;
  mime: string;
  name: string;
  width?: number;
  height?: number;
}

const MAX_SIDE = 2400;
const MAX_INPUT = 25_000_000;
const MAX_KEPT = 4_000_000;
/** What a design stores per image (repository MAX_ASSET_BYTES): larger files are re-encoded. */
const MAX_STORED = 8_000_000;
/** Decoding allocates width × height × 4 bytes: refuse pixel bombs before decoding. */
const MAX_PIXELS = 50_000_000;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

function svgSize(svg: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const num = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)(?:px)?"`, "i").exec(tag)?.[1]) || undefined;
  const box = /viewBox="[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"/i.exec(tag);
  return { width: num("width") ?? (box ? Number(box[1]) : undefined), height: num("height") ?? (box ? Number(box[2]) : undefined) };
}

/** The pixel size an image's header declares (PNG, JPEG, GIF, WebP), or null when it can't be read. */
function declaredSize(b: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && b.length >= 24 && b.readUInt32BE(12) === 0x49484452) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (mime === "image/gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (mime === "image/webp" && b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // Start of frame (any SOFn except DHT, JPG and DAC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function prepareDesignImage(input: { path?: string; dataUrl?: string; bytes?: Uint8Array; mime?: string; name?: string }): DesignImage {
  let bytes: Buffer;
  let mime: string;
  let name = input.name ?? "image";
  if (input.path) {
    if (!isAbsolute(input.path)) throw new Error("Give the image's absolute path.");
    const st = lstatSync(input.path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("That path is not an image file.");
    if (st.size > MAX_INPUT) throw new Error("That image is over 25 MB.");
    mime = MIME_BY_EXT[extname(input.path).toLowerCase()] ?? "";
    if (!mime) throw new Error("Images must be .png, .jpg, .webp, .gif or .svg.");
    bytes = readFileSync(input.path);
    name = input.name ?? basename(input.path);
  } else if (input.dataUrl) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/.exec(input.dataUrl);
    if (!m) throw new Error("The data URL must be a base64 PNG, JPEG, WebP, GIF or SVG image.");
    mime = m[1];
    bytes = Buffer.from(m[2], "base64");
  } else if (input.bytes && input.mime) {
    mime = input.mime;
    bytes = Buffer.from(input.bytes);
  } else throw new Error("Give a path, a data URL or image bytes.");
  if (bytes.length > MAX_INPUT) throw new Error("That image is over 25 MB.");

  if (mime === "image/svg+xml") {
    if (bytes.length > 1_000_000) throw new Error("An SVG image must be at most 1 MB.");
    const text = bytes.toString("utf8");
    if (!/<svg\b/i.test(text)) throw new Error("That file is not an SVG image.");
    return { bytes, mime, name, ...svgSize(text) };
  }
  const declared = declaredSize(bytes, mime);
  if (declared && declared.width * declared.height > MAX_PIXELS)
    throw new Error(`That image is ${declared.width} × ${declared.height} pixels; images must be at most ${MAX_PIXELS / 1_000_000} megapixels.`);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) {
    // GIF and WebP stay as they are (an animated GIF would lose its frames);
    // anything else that doesn't decode isn't an image.
    if ((mime === "image/gif" || mime === "image/webp") && bytes.length <= MAX_KEPT) return { bytes, mime, name };
    throw new Error("That file could not be read as an image.");
  }
  const size = image.getSize();
  if (size.width * size.height > MAX_PIXELS) throw new Error(`That image is ${size.width} × ${size.height} pixels; images must be at most ${MAX_PIXELS / 1_000_000} megapixels.`);
  const kept = mime === "image/png" || mime === "image/jpeg" ? MAX_STORED : MAX_KEPT;
  if (Math.max(size.width, size.height) <= MAX_SIDE && bytes.length <= kept) return { bytes, mime, name, ...size };
  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: "best" }) : image;
  const out = resized.getSize();
  // PNG keeps transparency; photos (JPEG) stay JPEG; a PNG too big to store becomes a JPEG.
  if (mime === "image/png" || mime === "image/gif" || mime === "image/webp") {
    const png = resized.toPNG();
    if (png.length <= MAX_STORED) return { bytes: png, mime: "image/png", name, ...out };
  }
  return { bytes: resized.toJPEG(85), mime: "image/jpeg", name, ...out };
}

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
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

function svgSize(svg: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const num = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)(?:px)?"`, "i").exec(tag)?.[1]) || undefined;
  const box = /viewBox="[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"/i.exec(tag);
  return { width: num("width") ?? (box ? Number(box[1]) : undefined), height: num("height") ?? (box ? Number(box[2]) : undefined) };
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
    const text = bytes.toString("utf8");
    if (!/<svg\b/i.test(text)) throw new Error("That file is not an SVG image.");
    if (bytes.length > 1_000_000) throw new Error("An SVG image must be at most 1 MB.");
    return { bytes, mime, name, ...svgSize(text) };
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) {
    // GIF and WebP stay as they are (an animated GIF would lose its frames);
    // anything else that doesn't decode isn't an image.
    if ((mime === "image/gif" || mime === "image/webp") && bytes.length <= MAX_KEPT) return { bytes, mime, name };
    throw new Error("That file could not be read as an image.");
  }
  const size = image.getSize();
  if (Math.max(size.width, size.height) <= MAX_SIDE && (mime === "image/png" || mime === "image/jpeg" || bytes.length <= MAX_KEPT))
    return { bytes, mime, name, ...size };
  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: "best" }) : image;
  const out = resized.getSize();
  // PNG keeps transparency; photos (JPEG) stay JPEG.
  const png = mime === "image/png" || mime === "image/gif" || mime === "image/webp";
  return { bytes: png ? resized.toPNG() : resized.toJPEG(85), mime: png ? "image/png" : "image/jpeg", name, ...out };
}

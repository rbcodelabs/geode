import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { ImageReadResult, SupportedRasterMime } from "./image-ipc";
import { ImageCleanupUncertainError } from "../shared/image-cleanup";
export interface AuthorizedImageRequest { root: string; expectedRoot: string; path: string; current(): boolean; limit?: number }
export interface ImageFileHandle {
  stat(): Promise<Stats>;
  read(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface ImageReadIo {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<Stats>;
  open(value: string, flags: number): Promise<ImageFileHandle>;
  allocate(size: number): Uint8Array<ArrayBuffer>;
}
export const imageReadIo: ImageReadIo = { realpath: fs.realpath, stat: fs.stat, open: fs.open, allocate: size => new Uint8Array(size) };
/** Header-family admission only: a later native decoder can still reject these bytes. */
export function rasterHeaderMime(bytes: Uint8Array, extension: string): SupportedRasterMime {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, value: string) => offset + value.length <= bytes.length
    && [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const u32 = (offset: number, little = false) => view.getUint32(offset, little);
  const reject = (): never => { throw new Error("Unsupported or mismatched raster header."); };
  switch (extension.toLowerCase()) {
    case "png":
      if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)
        || u32(8) !== 13 || !text(12, "IHDR")) return reject();
      return "image/png";
    case "jpg": case "jpeg":
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[3] === 0) return reject();
      return "image/jpeg";
    case "gif":
      if (bytes.length < 13 || !text(0, "GIF87a") && !text(0, "GIF89a")) return reject();
      return "image/gif";
    case "webp": {
      if (bytes.length < 20 || !text(0, "RIFF") || !text(8, "WEBP") || u32(4, true) + 8 !== bytes.length) return reject();
      const length = u32(16, true), end = 20 + length + (length & 1);
      if (end > bytes.length) return reject();
      if (text(12, "VP8L") && length >= 5 && bytes[20] === 47) return "image/webp";
      if (text(12, "VP8X") && length === 10) return "image/webp";
      if (text(12, "VP8 ") && length >= 10 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return "image/webp";
      return reject();
    }
    case "bmp": {
      if (bytes.length < 26 || !text(0, "BM") || u32(2, true) !== bytes.length) return reject();
      const dib = u32(14, true), pixelOffset = u32(10, true);
      if (dib !== 12 && dib < 40 || 14 + dib > bytes.length || pixelOffset < 14 + dib || pixelOffset > bytes.length) return reject();
      return "image/bmp";
    }
    case "avif": {
      if (bytes.length < 16 || !text(4, "ftyp")) return reject();
      let length = u32(0), brand = 8;
      if (length === 1) {
        if (bytes.length < 24) return reject();
        const extended = view.getBigUint64(8);
        if (extended > BigInt(bytes.length) || extended > BigInt(Number.MAX_SAFE_INTEGER)) return reject();
        length = Number(extended); brand = 16;
      }
      if (length < brand + 8 || length > bytes.length || (length - brand) % 4 !== 0) return reject();
      const avif = (at: number) => text(at, "avif") || text(at, "avis");
      if (avif(brand)) return "image/avif";
      for (let offset = brand + 8; offset < length; offset += 4) if (avif(offset)) return "image/avif";
      return reject();
    }
    default: return reject();
  }
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const rasterExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
/** Narrow bounded reader. No legacy binary API, registration or renderer fallback. */
export async function readAuthorizedImage(request: AuthorizedImageRequest, io: ImageReadIo = imageReadIo): Promise<ImageReadResult> {
  const { root, expectedRoot, path: relative, current } = request;
  const limit = request.limit ?? MAX_IMAGE_BYTES;
  if (typeof root !== "string" || !root || root.length > 4096 || !path.isAbsolute(root) || root !== expectedRoot || root.includes("\0")
    || typeof relative !== "string" || relative.length > 4096 || !relative || /^[a-z][a-z0-9+.-]*:/i.test(relative)
    || /^[\\/]/.test(relative) || /[\\\0]/.test(relative) || relative.startsWith("@ext/")
    || relative.split("/").some(part => !part || part === "." || part === "..") || typeof current !== "function"
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IMAGE_BYTES) throw new Error("Invalid image read boundary.");
  const extension = path.extname(relative).slice(1).toLowerCase();
  if (!rasterExtensions.has(extension)) throw new Error("Unsupported raster extension.");
  const check = () => { if (current() !== true) throw new Error("Image read authority changed or cancelled."); };
  const observed = async <T>(operation: Promise<T>): Promise<T> => { const value = await operation; check(); return value; };
  check();
  const canonicalRoot = await observed(io.realpath(root));
  const rootStat = await observed(io.stat(canonicalRoot));
  if (!rootStat.isDirectory()) throw new Error("Image root is not a directory.");
  const lexicalTarget = path.resolve(root, relative);
  const target = await observed(io.realpath(lexicalTarget));
  const contained = path.relative(canonicalRoot, target);
  if (!contained || contained === ".." || contained.startsWith(".." + path.sep) || path.isAbsolute(contained)) throw new Error("Image escapes its canonical root.");
  const stat = await observed(io.stat(target));
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > limit) throw new Error("Image is empty, oversized or not a regular file.");
  // Capture the handle before checking authority: a stale open still owns cleanup.
  const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let result: ImageReadResult | undefined, failed = false, primary: unknown;
  const verifyPath = async () => {
    if (await observed(io.realpath(root)) !== canonicalRoot) throw new Error("Image root changed.");
    const nowRoot = await observed(io.stat(canonicalRoot));
    if (!nowRoot.isDirectory() || nowRoot.dev !== rootStat.dev || nowRoot.ino !== rootStat.ino) throw new Error("Image root identity changed.");
    if (await observed(io.realpath(lexicalTarget)) !== target) throw new Error("Image target changed.");
    const nowPath = await observed(io.stat(target));
    if (!nowPath.isFile() || !sameFile(stat, nowPath)) throw new Error("Image file identity or bytes changed.");
  };
  try {
    check();
    const verify = async () => {
      await verifyPath();
      const nowHandle = await observed(handle.stat());
      if (!nowHandle.isFile() || !sameFile(stat, nowHandle)) throw new Error("Image file identity or bytes changed.");
    };
    await verify();
    const bytes = io.allocate(stat.size);
    if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== stat.size || bytes.buffer.byteLength !== stat.size) throw new Error("Invalid image output allocation.");
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(READ_CHUNK_BYTES, bytes.length - offset);
      const { bytesRead } = await observed(handle.read(bytes, offset, length, offset));
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > length) throw new Error("Image truncated or invalid read result.");
      offset += bytesRead;
    }
    // One separate overflow byte never makes the <=32MiB output allocation cap+1.
    const overflow = io.allocate(1);
    const { bytesRead } = await observed(handle.read(overflow, 0, 1, stat.size));
    if (bytesRead !== 0) throw new Error("Image grew during its bounded read.");
    await verify();
    result = { bytes: bytes.buffer, mime: rasterHeaderMime(bytes, extension) };
  } catch (error) { failed = true; primary = error; }
  try { await handle.close(); }
  catch (cleanup) {
    throw new ImageCleanupUncertainError(failed ? [primary, cleanup] : [cleanup]);
  }
  if (failed) throw primary;
  // Close is another asynchronous boundary. Recheck successful publication without
  // touching the now-closed handle; this is a point-in-time check, not an atomic FS snapshot.
  await verifyPath();
  check();
  return result!;
}

/**
 * Minimal, defensive ZIP reader/writer for vault packs (ADR 0050).
 *
 * Why hand-rolled instead of a dependency: a vault pack needs exactly the
 * "stored" and "deflate" methods, and the safety checks the ADR requires
 * (symlinks, zip-slip names, declared-size and ratio limits, no zip64, no
 * encryption) need the central directory's metadata *before* any bytes are
 * inflated. Node's built-in `zlib` already does the compression; the container
 * format is ~100 lines. This avoids adding a dependency to the main-process
 * bundle (esbuild just bundles `node:zlib` as an external builtin) and keeps
 * the whole parser reviewable in one file.
 *
 * This layer knows nothing about vault-pack layout; see ./vault-pack.ts.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Maximum number of entries (files + directories). */
  maxEntries: number;
  /** Maximum total uncompressed bytes across all entries. */
  maxTotalBytes: number;
  /** Maximum uncompressed bytes for a single entry. */
  maxEntryBytes: number;
  /** Maximum uncompressed:compressed ratio for an entry larger than `ratioFloorBytes`. */
  maxRatio: number;
  /** Entries at or below this size are exempt from the ratio check (tiny files compress absurdly well)... */
  ratioFloorBytes: number;
  /** ...unless the archive expands to more than this in total, when the ratio check applies to every entry. */
  ratioAlwaysAboveTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
  ratioAlwaysAboveTotalBytes: 16 * 1024 * 1024,
};

export interface ZipEntry {
  /** Normalized, validated name. Directories keep their trailing "/". */
  name: string;
  isDirectory: boolean;
  data: Buffer;
  compressedSize: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** Case/normalization-insensitive key: two names with the same key collide on macOS/Windows file systems. */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Reject names that could escape the extraction root or be ambiguous across
 * platforms (case-insensitive and Unicode-normalizing file systems, Windows
 * reserved device names, alternate data streams, trailing dot/space trimming).
 */
export function assertSafeEntryName(rawName: string): string {
  if (!rawName) throw new ZipError("Archive entry has an empty name");
  if (/[\u0000-\u001f\u007f]/.test(rawName)) throw new ZipError(`Archive entry name contains a control character: ${JSON.stringify(rawName)}`);
  if (rawName.includes("\\")) throw new ZipError(`Archive entry name contains a backslash: "${rawName}"`);
  if (rawName.startsWith("/") || /^[A-Za-z]:/.test(rawName)) {
    throw new ZipError(`Archive entry has an absolute path: "${rawName}"`);
  }
  const isDirectory = rawName.endsWith("/");
  const segments = (isDirectory ? rawName.slice(0, -1) : rawName).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ZipError(`Archive entry has an unsafe path segment: "${rawName}"`);
    }
    if (Buffer.byteLength(segment) > 255) throw new ZipError(`Archive entry path segment is too long: "${rawName}"`);
    if (segment.includes(":")) throw new ZipError(`Archive entry name contains ":": "${rawName}"`);
    if (/[. ]$/.test(segment)) throw new ZipError(`Archive entry name ends in a dot or space: "${rawName}"`);
    if (WINDOWS_RESERVED.test(segment)) throw new ZipError(`Archive entry uses a reserved device name: "${rawName}"`);
  }
  return rawName;
}

interface ZipEntryMeta {
  name: string;
  isDirectory: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

interface ZipDirectory {
  entries: ZipEntryMeta[];
  cdOffset: number;
}

/**
 * Validates the central directory (names, types, flags, declared sizes and
 * every limit) without inflating anything.
 */
function readDirectory(buf: Buffer, limits: ZipLimits): ZipDirectory {
  if (buf.length < 22) throw new ZipError("Not a zip archive (too small)");

  // End of central directory record: scan backwards past the optional comment.
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - MAX_COMMENT);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a zip archive (no end-of-central-directory record)");

  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || cdDisk !== 0) throw new ZipError("Multi-disk archives are not supported");
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("Zip64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`Archive has too many entries (${entryCount} > ${limits.maxEntries})`);
  }
  if (cdOffset + cdSize > eocd) throw new ZipError("Corrupt archive (central directory out of bounds)");

  const entries: ZipEntryMeta[] = [];
  const seen = new Set<string>();
  let pos = cdOffset;
  let totalBytes = 0;

  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > cdOffset + cdSize || buf.readUInt32LE(pos) !== SIG_CD) {
      throw new ZipError("Corrupt archive (bad central directory entry)");
    }
    const madeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ZipError("Corrupt archive (central directory entry out of bounds)");

    const name = assertSafeEntryName(buf.toString("utf8", pos + 46, pos + 46 + nameLen));
    const isDirectory = name.endsWith("/");

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("Zip64 entries are not supported");
    }
    if (flags & 0x1 || flags & 0x40) throw new ZipError(`Encrypted entries are not supported: "${name}"`);
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method}: "${name}"`);

    // Unix file type lives in the high 16 bits of the external attributes when
    // the archive was made on a Unix host (versionMadeBy high byte === 3).
    if (madeBy >> 8 === 3) {
      const fileType = (externalAttrs >>> 16) & 0o170000;
      if (fileType === 0o120000) throw new ZipError(`Archive contains a symbolic link: "${name}"`);
      if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
        throw new ZipError(`Archive contains a special file: "${name}"`);
      }
    }
    if (externalAttrs & 0x400) throw new ZipError(`Archive contains a reparse point: "${name}"`);

    const key = foldName(isDirectory ? name.slice(0, -1) : name);
    if (seen.has(key)) throw new ZipError(`Archive has a duplicate entry: "${name}"`);
    seen.add(key);

    if (size > limits.maxEntryBytes) throw new ZipError(`Entry is too large (${size} bytes): "${name}"`);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipError(`Archive expands to more than ${limits.maxTotalBytes} bytes`);
    }
    if (isDirectory && size !== 0) throw new ZipError(`Directory entry has content: "${name}"`);

    entries.push({ name, isDirectory, method, crc, compressedSize, size, localOffset });
    pos = next;
  }

  // Ratio check after the total is known: small entries are exempt only while the archive stays small overall.
  const checkAll = totalBytes > limits.ratioAlwaysAboveTotalBytes;
  for (const e of entries) {
    if ((checkAll || e.size > limits.ratioFloorBytes) && e.size / Math.max(e.compressedSize, 1) > limits.maxRatio) {
      throw new ZipError(`Entry has a suspicious compression ratio: "${e.name}"`);
    }
  }
  return { entries, cdOffset };
}

function inflateEntry(buf: Buffer, e: ZipEntryMeta, cdOffset: number): Buffer {
  if (e.isDirectory) return Buffer.alloc(0);
  const { name, method, compressedSize, size, localOffset } = e;
  if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new ZipError(`Corrupt archive (bad local header): "${name}"`);
  }
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + localNameLen + localExtraLen;
  const end = start + compressedSize;
  if (end > cdOffset) throw new ZipError(`Corrupt archive (entry data out of bounds): "${name}"`);
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (method === 0) {
    if (compressedSize !== size) throw new ZipError(`Corrupt archive (stored size mismatch): "${name}"`);
    data = Buffer.from(raw);
  } else {
    try {
      // Bounded by the *declared* size so a lying header can't inflate past the checked limits.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE") throw new ZipError(`Entry expands past its declared size: "${name}"`);
      throw new ZipError(`Corrupt compressed data: "${name}"`);
    }
    if (data.length !== size) throw new ZipError(`Corrupt archive (size mismatch): "${name}"`);
  }
  if (crc32(data) !== e.crc) throw new ZipError(`Checksum mismatch: "${name}"`);
  return data;
}

/**
 * Parses and fully validates `buf`. Throws `ZipError` on any structural problem
 * or limit violation; never writes anything. Every entry's contents are
 * inflated (bounded by its declared size) and CRC-checked.
 */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const { entries, cdOffset } = readDirectory(buf, limits);
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory, data: inflateEntry(buf, e, cdOffset), compressedSize: e.compressedSize }));
}

/**
 * Reads ONE entry by exact name after validating the whole directory, without
 * inflating any other entry. Used to list packs cheaply (manifest only).
 */
export function readZipEntry(buf: Buffer, name: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Buffer | null {
  const { entries, cdOffset } = readDirectory(buf, limits);
  const meta = entries.find((e) => e.name === name);
  return meta ? inflateEntry(buf, meta, cdOffset) : null;
}

export interface ZipWriteEntry {
  name: string;
  data: Buffer;
  /** Unix mode bits (default 0o100644). Exposed so tests can craft hostile archives. */
  mode?: number;
}

/** Writes a deterministic zip (fixed timestamps, unix attributes, deflate where it helps). */
export function writeZip(entries: ZipWriteEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const isDirectory = entry.name.endsWith("/");
    const deflated = isDirectory ? Buffer.alloc(0) : deflateRawSync(entry.data);
    const useDeflate = !isDirectory && deflated.length < entry.data.length;
    const payload = isDirectory ? Buffer.alloc(0) : useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const mode = entry.mode ?? (isDirectory ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time 00:00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((mode << 16) >>> 0), 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

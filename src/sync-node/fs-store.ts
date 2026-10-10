import { createHash, type Hash } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, truncate, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { APPEND_ONLY_PROTOCOL, SYNC_MAX_FILE_BYTES, type AppendOnlySession, type AppendOnlySyncProvider, type BlobRef, type HistoryRecord, type HistoryScan, type VaultDescriptor } from "../sync-core/history-types";
import { abortError, SyncStoreError } from "./store-errors";
import { withStoreLock } from "./store-lock";

/**
 * Hub store: an append-only history session over a plain directory.
 *
 *   <store>/descriptor.json      immutable VaultDescriptor (one vault per store)
 *   <store>/blobs/<sha256>       immutable, content-addressed blobs (id === sha256)
 *   <store>/records/<id>.json    immutable records (canonical JSON)
 *   <store>/index.log            append-only newline-separated record ids; the ONLY
 *                                thing that makes a record visible to scan()
 *   <store>/.lock/               cross-process single-writer lock (see store-lock.ts)
 *
 * ## Durability / ordering guarantees
 *
 * Blob commit: bytes stream into `blobs/.tmp-*` while being hashed; at commit the
 * size and sha256 are checked, the temp file is fsync'd, atomically renamed to
 * `blobs/<sha256>`, and `blobs/` is fsync'd. A reader therefore sees either no
 * blob or the complete verified one — never a partial blob. A crash leaves at
 * worst an invisible `.tmp-*` file (reaped when older than an hour on open).
 *
 * Record append (under the writer lock), strictly in this order:
 *   1. referenced blob exists with the declared size (else `invalid-record`);
 *   2. record bytes -> `records/.tmp-*`, fsync, `link()` to `records/<id>.json`
 *      (atomic and exclusive, EEXIST if present: the O_EXCL semantics without a
 *      torn-file window), unlink the temp, fsync `records/`;
 *   3. only then `<id>\n` is appended to index.log and fsync'd (plus the store
 *      directory when index.log was just created).
 * So a record becomes visible only after its record file and every blob it
 * references are durable. A crash between 2 and 3 leaves an orphan record file
 * that no scan can see; the caller's retry (identical record) finds it, verifies
 * it is byte-for-byte the same payload, and completes step 3. A crash mid-3 can
 * leave a torn final index line (no trailing "\n"): readers ignore an unterminated
 * tail and the next writer truncates it before appending.
 *
 * Retry rules (ADR-0016): the same recordId with the identical payload is an
 * idempotent success; a differing payload is a `conflict` and nothing is written.
 * The scan cursor is the decimal byte offset into index.log of the first
 * unconsumed line. A cursor beyond the end (store replaced/truncated) yields
 * `reset: true` and a rescan from 0 — the engine unions, never discards.
 */
export const STORE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const SCAN_PAGE = 500;
const INDEX_READ_WINDOW = 1024 * 1024;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[a-f0-9]{64}$/;

export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  return value;
}

const hex = (value: Buffer) => value.toString("hex");
function uuidFrom(label: string): string {
  const h = hex(createHash("sha256").update(label).digest()).slice(0, 32).split("");
  h[12] = "4"; h[16] = "89ab"[parseInt(h[16], 16) & 3];
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function isVaultDescriptor(value: unknown): value is VaultDescriptor {
  const d = value as VaultDescriptor | null;
  return !!d && typeof d === "object" && d.schema === 1 && d.protocol === APPEND_ONLY_PROTOCOL && [d.vaultId, d.rootId, d.descriptorId, d.name].every(v => typeof v === "string" && v.length > 0);
}

async function fsyncDir(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try { handle = await open(path, "r"); await handle.sync(); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw error; // directories cannot be opened/synced on some platforms
  } finally { await handle?.close(); }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.length) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten;
}

let tmpCounter = 0;
const tmpName = () => `.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Writes `bytes` durably to a temp file and atomically, exclusively links it at `target`. Resolves false when `target` exists. */
async function linkNew(dir: string, target: string, bytes: Uint8Array): Promise<boolean> {
  const tmp = join(dir, tmpName());
  const handle = await open(tmp, "wx", 0o644);
  try { await writeAll(handle, bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { await unlink(tmp).catch(() => {}); await fsyncDir(dir); }
}

const notFound = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw abortError(signal); };

/** Streaming blob upload: bytes are hashed and written as they arrive; nothing is buffered beyond one chunk. */
export class FsBlobWriter {
  private hash: Hash | null = createHash("sha256");
  private received = 0;
  private handle: FileHandle | null = null;
  private tmpPath: string | null = null;
  private done = false;
  /** @internal */
  constructor(private readonly blobsDir: string, readonly sha256: string, readonly size: number, private readonly existing: boolean) { }

  static async begin(blobsDir: string, sha256: string, size: number): Promise<FsBlobWriter> {
    if (!SHA_RE.test(sha256)) throw new SyncStoreError("invalid-request", "Invalid blob sha256");
    if (!Number.isSafeInteger(size) || size < 0) throw new SyncStoreError("invalid-request", "Invalid blob size");
    if (size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", `Blob exceeds ${SYNC_MAX_FILE_BYTES} bytes`);
    let existing = false;
    try { existing = (await stat(join(blobsDir, sha256))).size === size; } catch (error) { if (!notFound(error)) throw error; }
    const writer = new FsBlobWriter(blobsDir, sha256, size, existing);
    if (!existing) {
      writer.tmpPath = join(blobsDir, tmpName());
      writer.handle = await open(writer.tmpPath, "wx", 0o644);
    }
    return writer;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.done) throw new SyncStoreError("invalid-request", "Blob upload already finished");
    this.received += chunk.length;
    if (this.received > this.size) { await this.abort(); throw new SyncStoreError("size-mismatch", "Blob data exceeds the declared size"); }
    this.hash!.update(chunk);
    if (this.handle) {
      try { await writeAll(this.handle, chunk); } catch (error) { await this.abort(); throw error; }
    }
  }

  async commit(): Promise<BlobRef> {
    if (this.done) throw new SyncStoreError("invalid-request", "Blob upload already finished");
    const digest = this.hash!.digest("hex");
    if (this.received !== this.size) { await this.abort(); throw new SyncStoreError("size-mismatch", `Blob has ${this.received} bytes, expected ${this.size}`); }
    if (digest !== this.sha256) { await this.abort(); throw new SyncStoreError("hash-mismatch", "Blob bytes do not match the declared sha256"); }
    try {
      if (this.handle) {
        await this.handle.sync();
        await this.handle.close();
        this.handle = null;
        await rename(this.tmpPath!, join(this.blobsDir, this.sha256));
        this.tmpPath = null;
        await fsyncDir(this.blobsDir);
      }
    } catch (error) { await this.abort(); throw error; }
    this.done = true;
    return { id: this.sha256, sha256: this.sha256, size: this.size };
  }

  async abort(): Promise<void> {
    if (this.handle) { await this.handle.close().catch(() => {}); this.handle = null; }
    if (this.tmpPath) { await unlink(this.tmpPath).catch(() => {}); this.tmpPath = null; }
    this.done = true;
    this.hash = null;
  }
}

export interface ScanPage { records: unknown[]; cursor: string; more: boolean; reset: boolean; status: "complete" | "partial" }

export class FsStoreSession implements AppendOnlySession {
  readonly root: string;
  private readonly blobsDir: string;
  private readonly recordsDir: string;
  private readonly indexPath: string;
  constructor(root: string, readonly descriptor: VaultDescriptor) {
    this.root = root;
    this.blobsDir = join(root, "blobs");
    this.recordsDir = join(root, "records");
    this.indexPath = join(root, "index.log");
  }

  /** Reaps abandoned temp files from crashed uploads/appends. Best effort; never touches visible data. */
  async reapTemp(): Promise<void> {
    for (const dir of [this.blobsDir, this.recordsDir, this.root]) {
      let names: string[] = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith(".tmp-")) continue;
        try { if (Date.now() - (await stat(join(dir, name))).mtimeMs > TMP_MAX_AGE_MS) await unlink(join(dir, name)); } catch { /* raced */ }
      }
    }
  }

  // --- blobs -------------------------------------------------------------

  beginBlob(input: { sha256: string; size: number }): Promise<FsBlobWriter> { return FsBlobWriter.begin(this.blobsDir, input.sha256, input.size); }

  async putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef> {
    checkSignal(signal);
    if (input.data.byteLength !== input.size) throw new SyncStoreError("size-mismatch", "Blob data length differs from the declared size");
    const writer = await this.beginBlob(input);
    try {
      const bytes = new Uint8Array(input.data);
      for (let offset = 0; offset < bytes.length; offset += STORE_CHUNK_BYTES) {
        checkSignal(signal);
        await writer.write(bytes.subarray(offset, Math.min(bytes.length, offset + STORE_CHUNK_BYTES)));
      }
      checkSignal(signal);
      return await writer.commit();
    } catch (error) { await writer.abort(); throw error; }
  }

  private blobPath(id: string): string {
    if (!SHA_RE.test(id)) throw new SyncStoreError("invalid-request", "Invalid blob id");
    return join(this.blobsDir, id);
  }

  /** At most STORE_CHUNK_BYTES per call. */
  async readBlobRange(id: string, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
    checkSignal(signal);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > STORE_CHUNK_BYTES) throw new SyncStoreError("invalid-request", "Invalid blob range");
    let handle: FileHandle;
    try { handle = await open(this.blobPath(id), "r"); } catch (error) { if (notFound(error)) throw new SyncStoreError("not-found", "Blob not found"); throw error; }
    try {
      const size = (await handle.stat()).size;
      if (offset > size) throw new SyncStoreError("invalid-request", "Blob range out of bounds");
      const want = Math.min(length, size - offset), out = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) { const { bytesRead } = await handle.read(out, got, want - got, offset + got); if (!bytesRead) break; got += bytesRead; }
      return out.subarray(0, got);
    } finally { await handle.close(); }
  }

  async blobSize(id: string): Promise<number> {
    try { return (await stat(this.blobPath(id))).size; } catch (error) { if (notFound(error)) throw new SyncStoreError("not-found", "Blob not found"); throw error; }
  }

  async readBlob(ref: BlobRef, signal: AbortSignal): Promise<ArrayBuffer> {
    checkSignal(signal);
    if (ref.id !== ref.sha256) throw new SyncStoreError("invalid-request", "Blob id must equal its sha256");
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", "Blob reference exceeds the size limit");
    const size = await this.blobSize(ref.id);
    if (size !== ref.size) throw new SyncStoreError("size-mismatch", "Stored blob size differs from the reference");
    if (size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", "Stored blob exceeds the size limit");
    const out = new Uint8Array(size), hash = createHash("sha256");
    for (let offset = 0; offset < size; offset += STORE_CHUNK_BYTES) {
      checkSignal(signal);
      const part = await this.readBlobRange(ref.id, offset, STORE_CHUNK_BYTES, signal);
      hash.update(part); out.set(part, offset);
    }
    if (hash.digest("hex") !== ref.sha256) throw new SyncStoreError("hash-mismatch", "Stored blob is corrupt");
    return out.buffer;
  }

  // --- records -----------------------------------------------------------

  private recordPath(recordId: string): string {
    if (typeof recordId !== "string" || !ID_RE.test(recordId)) throw new SyncStoreError("invalid-record", "Invalid record id");
    return join(this.recordsDir, `${recordId}.json`);
  }

  private async readIndexText(): Promise<string> {
    try { return await readFile(this.indexPath, "utf8"); } catch (error) { if (notFound(error)) return ""; throw error; }
  }

  /** Drops an unterminated final index line left by a crash mid-append. Caller holds the lock. */
  private async repairIndexTail(): Promise<void> {
    let size: number;
    try { size = (await stat(this.indexPath)).size; } catch (error) { if (notFound(error)) return; throw error; }
    if (!size) return;
    const handle = await open(this.indexPath, "r");
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 10) return;
      const text = await readFile(this.indexPath);
      await truncate(this.indexPath, text.lastIndexOf(10) + 1);
    } finally { await handle.close(); }
  }

  /** Everything appendRecord checks before touching the log; shared with appendRecords. */
  private async validateRecord(record: HistoryRecord): Promise<{ path: string; bytes: Buffer }> {
    if (!record || typeof record !== "object" || record.schema !== 1) throw new SyncStoreError("invalid-record", "Unsupported record schema");
    if (record.vaultId !== this.descriptor.vaultId) throw new SyncStoreError("invalid-record", "Record belongs to a different vault");
    const path = this.recordPath(record.recordId);
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    if (bytes.length > MAX_RECORD_BYTES) throw new SyncStoreError("invalid-record", "Record too large");
    if (record.blob !== undefined) {
      if (record.blob.id !== record.blob.sha256 || !SHA_RE.test(record.blob.sha256)) throw new SyncStoreError("invalid-record", "Blob reference is not content-addressed");
      let size: number;
      try { size = await this.blobSize(record.blob.id); } catch (error) { if (error instanceof SyncStoreError && error.code === "not-found") throw new SyncStoreError("invalid-record", "Record references a blob that is not in the store"); throw error; }
      if (size !== record.blob.size) throw new SyncStoreError("invalid-record", "Record blob size differs from the stored blob");
    }
    return { path, bytes };
  }

  async appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void> {
    checkSignal(signal);
    const { path, bytes } = await this.validateRecord(record);
    await withStoreLock(this.root, signal, async () => {
      checkSignal(signal);
      await this.repairIndexTail();
      const created = await linkNew(this.recordsDir, path, bytes);
      if (!created) {
        let existing: unknown;
        try { existing = JSON.parse(await readFile(path, "utf8")); } catch { throw new SyncStoreError("conflict", "An unreadable record already exists under this id"); }
        if (canonicalJson(existing) !== canonicalJson(record)) throw new SyncStoreError("conflict", "A different record already exists under this id");
        if (("\n" + await this.readIndexText()).includes(`\n${record.recordId}\n`)) return; // fully published already
      }
      const fresh = await stat(this.indexPath).then(() => false, () => true);
      const handle = await open(this.indexPath, "a", 0o644);
      try { await writeAll(handle, Buffer.from(`${record.recordId}\n`)); await handle.sync(); } finally { await handle.close(); }
      if (fresh) await fsyncDir(this.root);
    });
  }

  /**
   * Appends records in order under ONE writer-lock hold and ONE index append + fsync, which is what
   * makes a large first upload cheap. The ordering guarantee is unchanged and per record: every record
   * file (and every blob it references) is durable before any of the batch's index lines is written, so
   * a record is visible to scan() only once everything it needs is durable. Stops at the first record
   * that fails and still publishes the records before it; `appended` is that prefix length. A crash
   * mid-batch leaves orphan record files and at most a torn index tail, both handled exactly as in
   * appendRecord, and a retry of the same batch is idempotent.
   */
  async appendRecords(records: HistoryRecord[], signal: AbortSignal): Promise<{ appended: number; error?: unknown }> {
    checkSignal(signal);
    const prepared: Array<{ record: HistoryRecord; path: string; bytes: Buffer }> = [];
    let failure: unknown;
    for (const record of records) {
      try { prepared.push({ record, ...await this.validateRecord(record) }); } catch (error) { if (signal.aborted) throw error; failure = error; break; }
    }
    if (!prepared.length) return failure === undefined ? { appended: 0 } : { appended: 0, error: failure };
    let ok = 0;
    await withStoreLock(this.root, signal, async () => {
      checkSignal(signal);
      await this.repairIndexTail();
      const lines: string[] = [];
      let indexText: string | undefined;
      for (const item of prepared) {
        try {
          const created = await linkNew(this.recordsDir, item.path, item.bytes);
          if (!created) {
            let existing: unknown;
            try { existing = JSON.parse(await readFile(item.path, "utf8")); } catch { throw new SyncStoreError("conflict", "An unreadable record already exists under this id"); }
            if (canonicalJson(existing) !== canonicalJson(item.record)) throw new SyncStoreError("conflict", "A different record already exists under this id");
            indexText ??= "\n" + await this.readIndexText();
            if (indexText.includes(`\n${item.record.recordId}\n`) || lines.includes(item.record.recordId)) { ok++; continue; } // fully published already
          }
          lines.push(item.record.recordId);
          ok++;
        } catch (error) { if (signal.aborted) throw error; failure = error; break; }
      }
      if (!lines.length) return;
      checkSignal(signal);
      const fresh = await stat(this.indexPath).then(() => false, () => true);
      const handle = await open(this.indexPath, "a", 0o644);
      try { await writeAll(handle, Buffer.from(lines.map(id => id + "\n").join(""))); await handle.sync(); } finally { await handle.close(); }
      if (fresh) await fsyncDir(this.root);
    });
    return failure === undefined ? { appended: ok } : { appended: ok, error: failure };
  }

  /** One bounded page of the index. Lock-free: index lines only ever grow by whole, fsync'd appends. */
  async scanPage(cursor: string | undefined, limit: number, signal: AbortSignal): Promise<ScanPage> {
    checkSignal(signal);
    let offset = 0, reset = false;
    if (cursor !== undefined) { if (/^\d+$/.test(cursor)) offset = Number(cursor); else reset = true; }
    let size = 0;
    try { size = (await stat(this.indexPath)).size; } catch (error) { if (!notFound(error)) throw error; }
    if (offset > size) { offset = 0; reset = true; }
    const records: unknown[] = [];
    let consumed = offset;
    if (size > offset) {
      const handle = await open(this.indexPath, "r");
      try {
        const buffer = Buffer.alloc(Math.min(size - offset, INDEX_READ_WINDOW));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const complete = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
        if (complete === 0 && bytesRead === buffer.length && buffer.length === INDEX_READ_WINDOW) throw new SyncStoreError("invalid-record", "Corrupt index: line too long");
        let start = 0;
        while (start < complete && records.length < limit) {
          checkSignal(signal);
          const end = buffer.indexOf(10, start), id = buffer.toString("utf8", start, end);
          let parsed: unknown;
          try { parsed = JSON.parse(await readFile(this.recordPath(id), "utf8")); } catch (error) {
            if (records.length === 0 && consumed === offset) throw new SyncStoreError("invalid-record", `Index references unreadable record ${id}`, { cause: error });
            return { records, cursor: String(consumed), more: true, reset, status: "partial" };
          }
          records.push(parsed);
          consumed = offset + end + 1;
          start = end + 1;
        }
      } finally { await handle.close(); }
    }
    return { records, cursor: String(consumed), more: consumed < size && records.length > 0, reset, status: "complete" };
  }

  async scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan> {
    const all: unknown[] = [];
    let next = cursor, reset = false, first = true;
    for (;;) {
      let page: ScanPage;
      try { page = await this.scanPage(next, SCAN_PAGE, signal); } catch (error) {
        if (signal.aborted) return { status: "cancelled", records: all };
        throw error;
      }
      if (first) { reset = page.reset; first = false; }
      all.push(...page.records);
      next = page.cursor;
      if (page.status === "partial") return { status: "partial", records: all, cursor: next, ...(reset ? { reset } : {}) };
      if (!page.more) return { status: "complete", records: all, cursor: next, ...(reset ? { reset } : {}) };
    }
  }

  async close(): Promise<void> { }
}

export class FsStoreProvider implements AppendOnlySyncProvider {
  readonly id = "fs-store";
  readonly name = "Hub store (directory)";
  readonly protocol = APPEND_ONLY_PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  constructor(readonly storePath: string) { }

  private async readDescriptor(): Promise<VaultDescriptor | null> {
    let raw: string;
    try { raw = await readFile(join(this.storePath, "descriptor.json"), "utf8"); } catch (error) { if (notFound(error)) return null; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new SyncStoreError("invalid-record", "descriptor.json is not valid JSON"); }
    if (!isVaultDescriptor(parsed)) throw new SyncStoreError("invalid-record", "descriptor.json is not a valid vault descriptor");
    return parsed;
  }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> {
    checkSignal(signal);
    const descriptor = await this.readDescriptor();
    return descriptor ? [descriptor] : [];
  }

  /** Ids derive from `operationId`, so a retry after a lost response returns the same descriptor. */
  async createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> {
    checkSignal(signal);
    if (typeof input?.name !== "string" || !input.name || typeof input.operationId !== "string" || !input.operationId) throw new SyncStoreError("invalid-request", "createVault needs a name and operationId");
    const descriptor: VaultDescriptor = {
      schema: 1, protocol: APPEND_ONLY_PROTOCOL, name: input.name,
      vaultId: uuidFrom(`vault:${input.operationId}`), rootId: uuidFrom(`root:${input.operationId}`), descriptorId: uuidFrom(`descriptor:${input.operationId}`),
    };
    await mkdir(join(this.storePath, "blobs"), { recursive: true });
    await mkdir(join(this.storePath, "records"), { recursive: true });
    await fsyncDir(this.storePath);
    if (!await linkNew(this.storePath, join(this.storePath, "descriptor.json"), Buffer.from(canonicalJson(descriptor) + "\n"))) {
      const existing = await this.readDescriptor();
      if (!existing || canonicalJson(existing) !== canonicalJson(descriptor)) throw new SyncStoreError("conflict", "This store already holds a different vault");
      return existing;
    }
    return descriptor;
  }

  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<FsStoreSession> {
    checkSignal(signal);
    const descriptor = await this.readDescriptor();
    if (!descriptor) throw new SyncStoreError("not-found", "No vault in this store");
    const b = context.binding;
    if (b.vaultId !== descriptor.vaultId || b.rootId !== descriptor.rootId || b.descriptorId !== descriptor.descriptorId) throw new SyncStoreError("not-found", "Binding does not match the store's vault");
    await mkdir(join(this.storePath, "blobs"), { recursive: true });
    await mkdir(join(this.storePath, "records"), { recursive: true });
    const session = new FsStoreSession(this.storePath, descriptor);
    void session.reapTemp();
    return session;
  }
}

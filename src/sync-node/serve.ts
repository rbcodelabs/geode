import { SYNC_MAX_FILE_BYTES } from "../sync-core/history-types";
import { FsBlobWriter, FsStoreProvider, FsStoreSession, STORE_CHUNK_BYTES } from "./fs-store";
import { FrameParser, FrameWriter, MAX_FRAME_BYTES, MAX_HEADER_BYTES, PROTOCOL_NAME, PROTOCOL_VERSION, type Frame, type WritableLike } from "./rpc-framing";
import { SyncStoreError } from "./store-errors";

/**
 * Server half of the stdio store protocol (see rpc-framing.ts for framing).
 *
 * Requests : { type:"req", id:<number>, method, params, bytes? }  [+ binary frame]
 * Responses: { type:"res", id, ok:true, result, bytes? }          [+ binary frame]
 *            { type:"res", id, ok:false, error:{ code, message, retryable } }
 * Cancel   : { type:"abort", target:<id> }  (no reply of its own; the target request
 *            fails with `aborted` if it had not already finished)
 *
 * Methods: hello, discover, createVault, open, scan, putBlobStart, putBlobChunk,
 * putBlobCommit, putBlobAbort, readBlobRange, appendRecord, and the optional additions
 * putBlob (whole blob of at most one frame in a single request) and appendRecords (an
 * ordered batch, stops at the first failure and reports how many were appended). The
 * hello reply lists the optional additions under `features` plus `maxUploads`; a client
 * only uses what it sees, so old clients and old servers keep working unchanged.
 * Requests take effect in arrival order, so a client may pipeline many requests without
 * waiting for replies. The one exception is putBlob, which may overlap other putBlobs (it
 * still waits for every earlier request, and every later non-putBlob request waits for it). `hello` must come first.
 * One connection serves one opened vault session.
 *
 * stdout carries protocol frames ONLY; everything diagnostic goes through `log`
 * (the CLI wires that to stderr). A framing violation (garbled JSON, oversize
 * header or frame) is answered with a named error and ends the connection:
 * the byte stream cannot be resynchronised. It never throws out of serveStore.
 * A request that is well framed but invalid gets an error response and the
 * connection continues. EOF mid-frame is treated as a dropped client: staged
 * uploads are discarded (their temp files removed), no partial blob is published.
 */
export interface ServeStats { peakBuffered: number; framesIn: number; maxFrameIn: number; framesOut: number }

export interface ServeOptions {
  store: string;
  input: AsyncIterable<Uint8Array>;
  output: WritableLike;
  log?: (message: string) => void;
  stats?: ServeStats;
  /** Test seam: behave as a server that predates the optional additions (no `features`, no putBlob/appendRecords, 4 uploads). */
  legacy?: boolean;
}

const MAX_UPLOADS = 16;
const MAX_BATCH_RECORDS = 256;
/** Advertised in the hello reply; a client talking to an older server sees none of these and uses the original methods only. */
const FEATURES = { putBlob: true, appendRecords: true } as const;
const SCAN_LIMIT = 200;

export async function serveStore(options: ServeOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const stats = options.stats ?? { peakBuffered: 0, framesIn: 0, maxFrameIn: 0, framesOut: 0 };
  const provider = new FsStoreProvider(options.store);
  const out = new FrameWriter(options.output);
  const parser = new FrameParser();
  const inflight = new Map<number, AbortController>();
  const uploads = new Map<string, FsBlobWriter>();
  // Requests run in arrival order (a pipelined open/putBlobStart/chunk sequence is deterministic) except that one-shot putBlobs overlap each other;
  // only `abort` is out of band, and it takes effect on queued and running requests alike.
  let queue: Promise<void> = Promise.resolve();
  const overlapping = new Set<Promise<void>>();
  let session = null as FsStoreSession | null;
  let greeted = false, uploadSeq = 0, fatal = false;

  const respondOk = (id: number, result: unknown, body?: Uint8Array) => { stats.framesOut++; return out.send({ type: "res", id, ok: true, result }, body); };
  const respondError = (id: number | null, error: unknown) => {
    const wire = toStoreError(error, log);
    return out.send({ type: "res", id, ok: false, error: wire.toWire() });
  };

  const needSession = () => { if (!session) throw new SyncStoreError("invalid-request", "No vault session is open on this connection"); return session; };
  const str = (value: unknown, name: string) => { if (typeof value !== "string") throw new SyncStoreError("invalid-request", `${name} must be a string`); return value; };
  const int = (value: unknown, name: string) => { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SyncStoreError("invalid-request", `${name} must be an integer`); return value; };
  const upload = (value: unknown) => { const writer = uploads.get(str(value, "upload")); if (!writer) throw new SyncStoreError("not-found", "Unknown upload"); return writer; };

  const maxUploads = options.legacy ? 4 : MAX_UPLOADS;
  async function handle(method: string, params: Record<string, unknown>, body: Buffer | undefined, signal: AbortSignal): Promise<{ result: unknown; body?: Uint8Array }> {
    if (options.legacy && (method === "putBlob" || method === "appendRecords")) throw new SyncStoreError("invalid-request", `Unknown method ${method}`);
    if (method === "hello") {
      if (params.protocol !== PROTOCOL_NAME || params.version !== PROTOCOL_VERSION) throw new SyncStoreError("protocol", `Unsupported protocol ${String(params.protocol)} v${String(params.version)}; server speaks ${PROTOCOL_NAME} v${PROTOCOL_VERSION}`);
      greeted = true;
      return { result: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, maxFrameBytes: MAX_FRAME_BYTES, maxFileBytes: SYNC_MAX_FILE_BYTES, ...(options.legacy ? {} : { maxUploads, features: FEATURES }) } };
    }
    if (!greeted) throw new SyncStoreError("protocol", "hello must be the first request");
    switch (method) {
      case "discover": return { result: { vaults: await provider.discover(signal) } };
      case "createVault": return { result: { descriptor: await provider.createVault({ name: str(params.name, "name"), operationId: str(params.operationId, "operationId") }, signal) } };
      case "open": {
        session = await provider.open({ binding: params.binding as never, deviceId: typeof params.deviceId === "string" ? params.deviceId : "" }, signal);
        return { result: { descriptor: session.descriptor } };
      }
      case "scan": {
        const s = needSession();
        let limit = Math.max(1, Math.min(SCAN_LIMIT, typeof params.limit === "number" ? Math.floor(params.limit) : SCAN_LIMIT));
        const cursor = params.cursor === undefined || params.cursor === null ? undefined : str(params.cursor, "cursor");
        for (;;) { // shrink the page until the encoded response fits the header cap
          const page = await s.scanPage(cursor, limit, signal);
          if (limit === 1 || JSON.stringify(page).length < MAX_HEADER_BYTES / 2) return { result: page };
          limit = Math.max(1, limit >> 1);
        }
      }
      case "putBlobStart": {
        needSession();
        if (uploads.size >= maxUploads) throw new SyncStoreError("invalid-request", "Too many concurrent uploads");
        const writer = await needSession().beginBlob({ sha256: str(params.sha256, "sha256"), size: int(params.size, "size") });
        const id = `u${++uploadSeq}`;
        uploads.set(id, writer);
        return { result: { upload: id } };
      }
      case "putBlob": {
        // Start, data and commit in one request: the same writer, hashing, fsync and rename as the three-step path.
        const size = int(params.size, "size");
        if (size > 0 && (!body || body.length !== size)) throw new SyncStoreError("size-mismatch", "putBlob needs exactly one binary frame holding the whole blob");
        if (size === 0 && body?.length) throw new SyncStoreError("size-mismatch", "Blob data exceeds the declared size");
        const writer = await needSession().beginBlob({ sha256: str(params.sha256, "sha256"), size });
        try { if (body?.length) await writer.write(body); return { result: { ref: await writer.commit() } }; } catch (error) { await writer.abort(); throw error; }
      }
      case "putBlobChunk": {
        const writer = upload(params.upload);
        if (!body || !body.length) throw new SyncStoreError("invalid-request", "putBlobChunk requires a binary frame");
        try { await writer.write(body); } catch (error) { uploads.delete(params.upload as string); throw error; }
        return { result: {} };
      }
      case "putBlobCommit": {
        const id = str(params.upload, "upload"), writer = upload(id);
        uploads.delete(id);
        return { result: { ref: await writer.commit() } };
      }
      case "putBlobAbort": {
        const id = str(params.upload, "upload"), writer = uploads.get(id);
        uploads.delete(id);
        await writer?.abort();
        return { result: {} };
      }
      case "readBlobRange": {
        const length = int(params.length, "length");
        if (length > STORE_CHUNK_BYTES) throw new SyncStoreError("invalid-request", "Range exceeds the frame limit");
        const data = await needSession().readBlobRange(str(params.id, "id"), int(params.offset, "offset"), length, signal);
        return { result: { length: data.length }, body: data };
      }
      case "appendRecord": {
        await needSession().appendRecord(params.record as never, signal);
        return { result: {} };
      }
      case "appendRecords": {
        const s = needSession();
        if (!Array.isArray(params.records) || params.records.length > MAX_BATCH_RECORDS) throw new SyncStoreError("invalid-request", `records must be an array of at most ${MAX_BATCH_RECORDS}`);
        const { appended, error } = await s.appendRecords(params.records as never, signal);
        return { result: error === undefined ? { appended } : { appended, error: toStoreError(error, log).toWire() } };
      }
      default: throw new SyncStoreError("invalid-request", `Unknown method ${method}`);
    }
  }

  function dispatch(frame: Frame): void {
    stats.framesIn++;
    if (frame.body) stats.maxFrameIn = Math.max(stats.maxFrameIn, frame.body.length);
    const header = frame.header;
    if (header.type === "abort") { if (typeof header.target === "number") inflight.get(header.target)?.abort(); return; }
    const id = header.type === "req" && typeof header.id === "number" ? header.id : null;
    if (id === null || typeof header.method !== "string") { void respondError(id, new SyncStoreError("invalid-request", "Malformed request")); return; }
    if (inflight.has(id)) { void respondError(id, new SyncStoreError("invalid-request", "Duplicate request id")); return; }
    const controller = new AbortController();
    inflight.set(id, controller);
    const params = header.params && typeof header.params === "object" && !Array.isArray(header.params) ? header.params as Record<string, unknown> : {};
    // A one-shot putBlob touches nothing but its own content-addressed temp file, so it may overlap other
    // putBlobs; it still waits for everything that arrived before it, and every other request waits for it.
    const overlap = header.method === "putBlob" && greeted && !options.legacy;
    const task = (overlap ? queue : Promise.all([queue, ...overlapping]).then(() => {})).then(async () => {
      try {
        if (controller.signal.aborted) throw new SyncStoreError("aborted", "Request aborted");
        const { result, body } = await handle(header.method as string, params, frame.body, controller.signal);
        if (controller.signal.aborted) throw new SyncStoreError("aborted", "Request aborted");
        await respondOk(id, result, body);
      } catch (error) { await respondError(id, controller.signal.aborted ? new SyncStoreError("aborted", "Request aborted") : error); }
      finally { inflight.delete(id); }
    });
    if (overlap) { overlapping.add(task); void task.finally(() => overlapping.delete(task)); }
    else queue = task;
  }

  try {
    for await (const chunk of options.input) {
      const frames: Frame[] = [];
      let violation: unknown;
      try { parser.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), frames); } catch (error) { violation = error; }
      stats.peakBuffered = Math.max(stats.peakBuffered, parser.peakBuffered);
      for (const frame of frames) dispatch(frame);
      if (violation) {
        log(`fatal framing error: ${(violation as Error).message}`);
        await Promise.all([queue, ...overlapping]); // earlier requests answer first, then the named framing error
        await respondError(null, violation);
        fatal = true;
        break;
      }
    }
    if (!fatal && !parser.atBoundary) log("input ended mid-frame; discarding partial request");
  } catch (error) {
    log(`input error: ${(error as Error).message}`);
  } finally {
    // EOF (client gone or finished): requests already received still run to completion (an append
    // is never torn by a disconnect); then anything left open — uploads — is discarded.
    await Promise.all([queue, ...overlapping]);
    await Promise.allSettled([...uploads.values()].map(writer => writer.abort()));
    uploads.clear();
    await (session as FsStoreSession | null)?.close();
  }
}

function toStoreError(error: unknown, log: (message: string) => void): SyncStoreError {
  if (error instanceof SyncStoreError) return error;
  const e = error as NodeJS.ErrnoException;
  if (e?.name === "AbortError") return new SyncStoreError("aborted", "Request aborted");
  log(`internal error: ${e?.stack ?? String(error)}`);
  return new SyncStoreError("internal", e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? error));
}

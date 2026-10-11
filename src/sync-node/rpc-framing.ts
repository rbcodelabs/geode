import { SyncStoreError } from "./store-errors";

/**
 * Wire framing for the stdio store protocol.
 *
 * Every message is one UTF-8 JSON header line terminated by "\n". If the header
 * carries `bytes: n` (n > 0), exactly n raw bytes follow the newline immediately
 * (a length-prefixed binary frame: no base64, no escaping). A blob moves as a
 * sequence of such frames of at most MAX_FRAME_BYTES each.
 *
 * Limits are enforced while parsing, before any large allocation: an oversize
 * header line or a declared frame length above the cap raises `frame-too-large`,
 * unparseable JSON or a bad `bytes` field raises `bad-frame`. Either leaves the
 * byte stream unrecoverable, so callers treat them as fatal for the connection
 * (and report them by name) — they never throw out of the process.
 */
export const PROTOCOL_NAME = "geode-store-rpc";
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

export interface Frame { header: Record<string, unknown>; body?: Buffer }

export class FrameParser {
  private mode: "line" | "body" = "line";
  private lineParts: Buffer[] = [];
  private lineLength = 0;
  private header: Record<string, unknown> | null = null;
  private need = 0;
  private bodyParts: Buffer[] = [];
  private bodyLength = 0;
  /** High-water mark of bytes held by the parser (header line or partial frame). */
  peakBuffered = 0;

  /**
   * Appends every complete frame in `chunk` to `frames`. On a framing violation it throws, but frames
   * completed earlier in the same chunk are already in `frames`, so the caller can still serve them.
   */
  push(chunk: Buffer, frames: Frame[] = []): Frame[] {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.mode === "line") {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        this.lineLength += end - offset;
        if (this.lineLength > MAX_HEADER_BYTES) throw new SyncStoreError("frame-too-large", `Header line exceeds ${MAX_HEADER_BYTES} bytes`);
        this.lineParts.push(chunk.subarray(offset, end));
        this.peakBuffered = Math.max(this.peakBuffered, this.lineLength);
        if (newline < 0) break;
        offset = newline + 1;
        const line = Buffer.concat(this.lineParts).toString("utf8");
        this.lineParts = []; this.lineLength = 0;
        const header = this.parseHeader(line);
        const bytes = header.bytes === undefined ? 0 : header.bytes;
        if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) throw new SyncStoreError("bad-frame", "Invalid frame length");
        if (bytes > MAX_FRAME_BYTES) throw new SyncStoreError("frame-too-large", `Frame of ${bytes} bytes exceeds ${MAX_FRAME_BYTES}`);
        if (bytes === 0) frames.push({ header });
        else { this.mode = "body"; this.header = header; this.need = bytes; this.bodyParts = []; this.bodyLength = 0; }
      } else {
        const take = Math.min(this.need, chunk.length - offset);
        this.bodyParts.push(chunk.subarray(offset, offset + take));
        this.bodyLength += take; this.need -= take; offset += take;
        this.peakBuffered = Math.max(this.peakBuffered, this.bodyLength);
        if (this.need === 0) {
          frames.push({ header: this.header!, body: this.bodyParts.length === 1 ? this.bodyParts[0] : Buffer.concat(this.bodyParts) });
          this.mode = "line"; this.header = null; this.bodyParts = []; this.bodyLength = 0;
        }
      }
    }
    return frames;
  }

  private parseHeader(line: string): Record<string, unknown> {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new SyncStoreError("bad-frame", "Header line is not valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyncStoreError("bad-frame", "Header line is not a JSON object");
    return parsed as Record<string, unknown>;
  }

  /** True when the stream ended exactly on a message boundary. */
  get atBoundary(): boolean { return this.mode === "line" && this.lineLength === 0; }
}

/** Header line plus optional binary frame, as separate buffers (the frame is never copied). */
export function encodeFrame(header: Record<string, unknown>, body?: Uint8Array): Buffer[] {
  if (body && body.length > MAX_FRAME_BYTES) throw new SyncStoreError("frame-too-large", "Frame exceeds the protocol limit");
  const line = Buffer.from(JSON.stringify(body && body.length ? { ...header, bytes: body.length } : header) + "\n", "utf8");
  if (line.length > MAX_HEADER_BYTES) throw new SyncStoreError("frame-too-large", "Header exceeds the protocol limit");
  return body && body.length ? [line, Buffer.from(body.buffer, body.byteOffset, body.byteLength)] : [line];
}

export interface WritableLike {
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  once(event: "drain" | "error" | "close", listener: (...args: any[]) => void): unknown;
  on?(event: "error", listener: (...args: any[]) => void): unknown;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

/** Serialises writes and honours backpressure; a failed/closed sink makes later sends no-ops. */
export class FrameWriter {
  private tail: Promise<void> = Promise.resolve();
  closed = false;
  constructor(private readonly sink: WritableLike) { sink.on?.("error", () => { this.closed = true; }); sink.once("close", () => { this.closed = true; }); }
  private dead(): boolean { return this.closed || this.sink.destroyed === true || this.sink.writableEnded === true; }
  private drained(): Promise<void> {
    return new Promise<void>(resolve => {
      const sink = this.sink;
      if (this.dead()) return resolve();
      const done = () => { for (const event of ["drain", "close", "error"]) sink.off?.(event, done); resolve(); };
      sink.once("drain", done); sink.once("close", done); sink.once("error", done);
    });
  }
  send(header: Record<string, unknown>, body?: Uint8Array): Promise<void> {
    const parts = encodeFrame(header, body);
    this.tail = this.tail.then(async () => {
      for (const part of parts) {
        if (this.dead()) { this.closed = true; return; }
        try {
          if (!this.sink.write(part)) await this.drained();
        } catch { this.closed = true; return; }
      }
    });
    return this.tail;
  }
}

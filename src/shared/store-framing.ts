import { MAX_FRAME_BYTES, MAX_HEADER_BYTES } from "./store-protocol";
import { SyncStoreError } from "./store-errors";

/**
 * Browser-safe port of src/sync-node/rpc-framing.ts (same wire format, same limits, same error codes): a UTF-8 JSON
 * header line, then `bytes` raw bytes when the header declares a body. Uint8Array only: no Buffer, no node: imports, so
 * it runs in the renderer and the iOS web view. tests/unit/sync-http-store.test.ts feeds both parsers the same streams.
 */
export interface WireFrame { header: Record<string, unknown>; body?: Uint8Array }

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export class BytesFrameParser {
  private mode: "line" | "body" = "line";
  private lineParts: Uint8Array[] = [];
  private lineLength = 0;
  private header: Record<string, unknown> | null = null;
  private need = 0;
  private bodyParts: Uint8Array[] = [];
  private bodyLength = 0;
  peakBuffered = 0;

  /** Appends every complete frame in `chunk` to `frames`. Throws on a framing violation; frames completed earlier in the chunk are already in `frames`. */
  push(chunk: Uint8Array, frames: WireFrame[] = []): WireFrame[] {
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
        const line = textDecoder.decode(concat(this.lineParts, this.lineLength));
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
          frames.push({ header: this.header!, body: concat(this.bodyParts, this.bodyLength) });
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

  get atBoundary(): boolean { return this.mode === "line" && this.lineLength === 0; }
}

/** Header line plus optional binary frame, as separate buffers (the body is never copied). */
export function encodeBytesFrame(header: Record<string, unknown>, body?: Uint8Array): Uint8Array[] {
  if (body && body.length > MAX_FRAME_BYTES) throw new SyncStoreError("frame-too-large", "Frame exceeds the protocol limit");
  const line = textEncoder.encode(JSON.stringify(body && body.length ? { ...header, bytes: body.length } : header) + "\n");
  if (line.length > MAX_HEADER_BYTES) throw new SyncStoreError("frame-too-large", "Header exceeds the protocol limit");
  return body && body.length ? [line, body] : [line];
}

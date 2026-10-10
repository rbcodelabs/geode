import { PassThrough } from "node:stream";
import { FrameParser } from "../../src/sync-node/rpc-framing";
import { RpcStoreProvider, serveStore, type StoreTransport } from "../../src/sync-node/index";

/**
 * An in-process serveStore peer behind an artificial link: every byte written in either direction is
 * delivered `oneWayMs` later, in order (so RTT = 2 x oneWayMs). Bandwidth is not modelled, only latency.
 * Request headers crossing the link are tallied by method in `counts`.
 */
export interface LatencyLink { provider: RpcStoreProvider; counts: Record<string, number>; requests(): number; connections(): number }

export function latencyProvider(store: string, oneWayMs: number, options: { serve?: (o: Parameters<typeof serveStore>[0]) => Promise<void> } = {}): LatencyLink {
  const counts: Record<string, number> = {};
  let connections = 0;
  const provider = new RpcStoreProvider((): StoreTransport => {
    connections++;
    const toServer = new PassThrough(), fromServer = new PassThrough(), clientIn = new PassThrough();
    const parser = new FrameParser();
    const delay = (target: PassThrough, chunk: Uint8Array) => { const copy = Buffer.from(chunk); if (oneWayMs <= 0) target.write(copy); else setTimeout(() => target.write(copy), oneWayMs); };
    const output = {
      write(chunk: Uint8Array, callback?: (error?: Error | null) => void) {
        try { for (const frame of parser.push(Buffer.from(chunk))) if (frame.header.type === "req") counts[String(frame.header.method)] = (counts[String(frame.header.method)] ?? 0) + 1; } catch { /* the server will name the violation */ }
        delay(toServer, chunk); callback?.(); return true;
      },
      once: (event: string, listener: (...a: any[]) => void) => { toServer.once(event as never, listener); return output; },
      on: (event: string, listener: (...a: any[]) => void) => { toServer.on(event as never, listener); return output; },
      off: (event: string, listener: (...a: any[]) => void) => { toServer.off(event, listener); return output; },
      get destroyed() { return toServer.destroyed; },
      get writableEnded() { return toServer.writableEnded; },
    };
    fromServer.on("data", (chunk: Buffer) => delay(clientIn, chunk));
    fromServer.on("end", () => setTimeout(() => clientIn.end(), oneWayMs));
    void (options.serve ?? serveStore)({ store, input: toServer, output: fromServer }).finally(() => fromServer.end());
    return { input: clientIn, output: output as never, close: () => { toServer.end(); } };
  });
  return { provider, counts, requests: () => Object.values(counts).reduce((a, b) => a + b, 0), connections: () => connections };
}

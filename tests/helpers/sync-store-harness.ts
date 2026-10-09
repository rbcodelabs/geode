import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { build } from "esbuild";
import { RpcStoreProvider, serveStore, type ServeStats, type StoreTransport } from "../../src/sync-node/index";
import type { BlobRef, HistoryRecord, VaultDescriptor } from "../../src/sync-core/history-types";

export const never = new AbortController().signal;
export const tmpStore = () => mkdtempSync(join(tmpdir(), "geode-store-"));
export const rm = (path: string) => rmSync(path, { recursive: true, force: true });
export const sha = (data: Uint8Array | ArrayBuffer) => createHash("sha256").update(data instanceof ArrayBuffer ? new Uint8Array(data) : data).digest("hex");
export const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

export function record(vaultId: string, id: string, blob?: BlobRef, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return { schema: 1, vaultId, recordId: id, operationId: id + "-op", deviceId: "dev", entityId: "e-" + id, namespace: "content", parents: [], kind: "file", deleted: false, location: { parentId: null, name: id + ".md" }, ...(blob ? { blob } : {}), ...extra };
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1 << 20) randomFillSync(out.subarray(i, Math.min(size, i + (1 << 20))));
  return out;
}

export function inProcessProvider(store: string, stats?: ServeStats): RpcStoreProvider {
  return new RpcStoreProvider(() => {
    const toServer = new PassThrough(), fromServer = new PassThrough();
    void serveStore({ store, input: toServer, output: fromServer, ...(stats ? { stats } : {}) }).finally(() => fromServer.end());
    return { input: fromServer, output: toServer, close: () => { toServer.end(); } } satisfies StoreTransport;
  });
}

let bundleDir: string | undefined;
/** Bundles the child entry once per test file. */
export async function childBundle(): Promise<string> {
  if (bundleDir) return join(bundleDir, "child.cjs");
  bundleDir = mkdtempSync(join(tmpdir(), "geode-store-bundle-"));
  await build({ entryPoints: [resolve(__dirname, "sync-store-child.ts")], outfile: join(bundleDir, "child.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent" });
  return join(bundleDir, "child.cjs");
}
export function cleanBundle() { if (bundleDir) rm(bundleDir); bundleDir = undefined; }

export interface Child { proc: ChildProcess; transport: StoreTransport; stderr: () => string; exited: Promise<number | null> }
export async function spawnServe(store: string): Promise<Child> {
  const proc = spawn(process.execPath, ["--expose-gc", await childBundle(), "serve", store], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin!.on("error", () => { });
  let err = "";
  proc.stderr!.on("data", d => { err += d; });
  const exited = new Promise<number | null>(done => proc.on("close", code => done(code)));
  return { proc, stderr: () => err, exited, transport: { input: proc.stdout!, output: proc.stdin!, close: () => { proc.stdin!.destroy(); } } };
}
export function childProvider(store: string, children: Child[] = []): RpcStoreProvider {
  return new RpcStoreProvider(async () => { const child = await spawnServe(store); children.push(child); return child.transport; });
}
export async function runAppender(store: string, prefix: string, count: number): Promise<void> {
  const proc = spawn(process.execPath, [await childBundle(), "append", store, prefix, String(count)], { stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; proc.stderr!.on("data", d => { err += d; });
  const code = await new Promise<number | null>(done => proc.on("close", done));
  if (code !== 0) throw new Error(`appender ${prefix} failed (${code}): ${err}`);
}

export async function newVault(provider: { createVault(i: { name: string; operationId: string }, s: AbortSignal): Promise<VaultDescriptor> }): Promise<VaultDescriptor> {
  return provider.createVault({ name: "hub", operationId: "op-1" }, never);
}
export { mkdirSync };

import type { GuardedMutation, GuardedMutationResult } from "../shared/sync-safety";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withPathLock } from "./path-lock";
import { isPortableAssetPath } from "../shared/portable-assets";
export interface ApplyDependencies { trash(path: string): Promise<void>; assertContext?(): void; checkpoint?(name: string): Promise<void>; }
interface Receipt { path: string; expectedHash: string | null; desiredHash: string | null; kind: GuardedMutation["kind"]; state: "prepared" | "applied"; }
const MAX_BYTES = 100 * 1024 * 1024;
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function ensureDurableDirectory(target: string): Promise<void> {
  const missing: string[] = []; let current = target;
  while (true) {
    const stat = await fs.stat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat) { if (!stat.isDirectory()) throw new Error("Recovery parent is not a directory"); break; }
    missing.push(current); const parent = path.dirname(current); if (parent === current) throw new Error("Missing filesystem root"); current = parent;
  }
  for (const directory of missing.reverse()) {
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const parent = await fs.open(path.dirname(directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
  }
}

export async function durableWrite(target: string, data: Uint8Array): Promise<void> {
  const staging = `${target}.tmp-${randomUUID()}`;
  const file = await fs.open(staging, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await fs.rename(staging, target);
  const directory = await fs.open(path.dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function snapshot(target: string): Promise<{ hash: string | null; bytes?: Buffer }> {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return { hash: null };
  if (stat.isSymbolicLink()) throw new Error("Sync cannot apply to symbolic links");
  if (stat.isDirectory()) return { hash: "folder" };
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("File exceeds 100 MiB or is unsupported");
  const bytes = await fs.readFile(target); if (bytes.byteLength > MAX_BYTES) throw new Error("File exceeds 100 MiB");
  return { hash: hash(bytes), bytes };
}

async function checkPath(root: string, relative: string, portable = false): Promise<string> {
  if (!relative || relative.includes("\\") || relative.includes("\0") || relative.normalize("NFC") !== relative || relative.split("/").some((segment, index) => !segment || segment === "." || segment === ".." || segment.startsWith(".") && !(portable && index === 0 && segment === ".geode"))) throw new Error("Unsafe sync path");
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error("Unsafe sync path");
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error("Sync cannot traverse symbolic links");
  }
  return target;
}

export async function applyGuardedMutation(root: string, recoveryRoot: string, input: GuardedMutation, deps: ApplyDependencies): Promise<GuardedMutationResult> {
  if (!/^[0-9a-f-]{36}$/i.test(input.operationId)) throw new Error("Invalid sync operation identity");
  if (!["write", "trash", "mkdir"].includes(input.kind)) throw new Error("Invalid sync mutation");
  if (input.kind === "write" && !(input.data instanceof ArrayBuffer)) throw new Error("Sync write bytes required");
  if (input.data && input.data.byteLength > MAX_BYTES) throw new Error("File exceeds 100 MiB");
  root = await fs.realpath(root);
  const portable = input.namespace === "portable-config";
  if (portable && !isPortableAssetPath(input.path)) throw new Error("Invalid portable asset path");
  const physicalPath = portable ? ".geode/" + input.path : input.path;
  const receiptIdentity = `${input.namespace ?? "content"}:${input.path}`;
  const target = await checkPath(root, physicalPath, portable);
  const desiredHash = input.kind === "write" ? hash(new Uint8Array(input.data!)) : input.kind === "mkdir" ? "folder" : null;
  const recoveryPath = path.join(recoveryRoot, input.operationId);
  return withPathLock([root, target], async () => {
    deps.assertContext?.(); await checkPath(root, physicalPath, portable);
    const receiptFile = path.join(recoveryPath, "intent.json");
    let receipt: Receipt | null = await fs.readFile(receiptFile, "utf8").then(text => JSON.parse(text) as Receipt).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    const current = await snapshot(target);
    if (receipt) {
      if (receipt.path !== receiptIdentity || receipt.desiredHash !== desiredHash || receipt.expectedHash !== input.expectedHash || receipt.kind !== input.kind) throw new Error("Sync operation identity was reused with different content");
      if (current.hash === desiredHash) {
        receipt.state = "applied"; await durableWrite(receiptFile, Buffer.from(JSON.stringify(receipt)));
        return { status: "already-applied", hash: desiredHash, recoveryPath };
      }
      if (receipt.state === "applied") throw new Error("Local file changed after sync application");
    }
    if (current.hash !== input.expectedHash) throw new Error("Local file changed before sync application");
    if (current.hash === "folder" && (input.kind !== "trash" || (await fs.readdir(target)).length)) throw new Error("Sync cannot replace a folder or delete live descendants");
    await ensureDurableDirectory(recoveryPath);
    if (!receipt) {
      if (current.bytes) await durableWrite(path.join(recoveryPath, "before"), current.bytes);
      receipt = { path: receiptIdentity, expectedHash: input.expectedHash, desiredHash, kind: input.kind, state: "prepared" };
      await durableWrite(receiptFile, Buffer.from(JSON.stringify(receipt)));
    }
    await deps.checkpoint?.("prepared"); deps.assertContext?.();
    const staging = path.join(path.dirname(target), `.geode-sync-${input.operationId}`);
    if (input.kind === "write") { await ensureDurableDirectory(path.dirname(target)); await durableWrite(staging, new Uint8Array(input.data!)); }
    await deps.checkpoint?.("staged");
    await checkPath(root, physicalPath, portable);
    if ((await snapshot(target)).hash !== input.expectedHash) throw new Error("Local file changed while sync prepared recovery");
    if (current.hash === "folder" && (await fs.readdir(target)).length) throw new Error("Folder acquired live descendants");
    deps.assertContext?.();
    if (input.kind === "write") await fs.rename(staging, target);
    else if (input.kind === "mkdir") await fs.mkdir(target, { recursive: true });
    else if (current.hash !== null) await deps.trash(target);
    const parent = await fs.open(path.dirname(target), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    await deps.checkpoint?.("committed"); deps.assertContext?.();
    receipt.state = "applied"; await durableWrite(receiptFile, Buffer.from(JSON.stringify(receipt)));
    await deps.checkpoint?.("acknowledged");
    return { status: "applied", hash: desiredHash, recoveryPath };
  });
}

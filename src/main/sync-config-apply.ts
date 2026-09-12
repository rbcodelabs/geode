import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parsePortableConfig, projectPortableConfig, serializePortableConfig } from "../shared/portable-config";
import type { GuardedMutation, GuardedMutationResult } from "../shared/sync-safety";
import { DEFAULT_SYNC_SCOPE } from "../renderer/sync/scope";
import { withPathLock } from "./path-lock";
import { durableWrite, ensureDurableDirectory } from "./sync-apply";
const hash = (bytes: ArrayBuffer) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

export async function applyPortableMutation(root: string, recoveryRoot: string, input: GuardedMutation, deps: { assertContext?(): void }): Promise<GuardedMutationResult> {
  if (input.kind !== "write" || !input.data || !/^[0-9a-f-]{36}$/.test(input.operationId)) throw new Error("Invalid portable configuration mutation");
  const document = parsePortableConfig(input.path, input.data);
  const desiredHash = hash(serializePortableConfig(document));
  const source = document.name === "hotkeys.json" ? "hotkeys" : document.name === "daily-notes.json" ? "daily-notes" : "app";
  root = await fs.realpath(root);
  const folder = path.join(root, ".geode"); const target = path.join(folder, source + ".json");
  const recoveryPath = path.join(recoveryRoot, input.operationId);
  const safePath = async () => {
    for (const entry of [folder, target]) {
      const stat = await fs.lstat(entry).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error("Portable settings cannot traverse symbolic links");
    }
  };
  return withPathLock([root, target], async () => {
    deps.assertContext?.(); await safePath();
    const read = async (): Promise<Record<string, unknown>> => {
      const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) return {};
      if (stat.size > 1024 * 1024) throw new Error("Local settings exceed portable read limit");
      const value = JSON.parse(await fs.readFile(target, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local configuration");
      return value;
    };
    const category = async (raw: Record<string, unknown>) => {
      const documents = await projectPortableConfig({ read: async () => raw }, {
        ...DEFAULT_SYNC_SCOPE, mainSettings: document.name === "editor.json", appearance: document.name === "appearance.json",
        hotkeys: document.name === "hotkeys.json", corePlugins: document.name === "daily-notes.json",
      });
      return serializePortableConfig(documents[0]);
    };
    const before = await category(await read());
    const receiptFile = path.join(recoveryPath, "intent.json");
    const receipt = await fs.readFile(receiptFile, "utf8").then(JSON.parse).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (receipt && (receipt.category !== input.path || receipt.expectedHash !== input.expectedHash || receipt.desiredHash !== desiredHash)) throw new Error("Portable operation identity was reused");
    if (receipt && hash(before) === desiredHash) return { status: "already-applied", hash: desiredHash, recoveryPath };
    if (hash(before) !== input.expectedHash || receipt?.state === "applied") throw new Error("Portable settings changed before application");
    await ensureDurableDirectory(recoveryPath);
    const intent = { category: input.path, expectedHash: input.expectedHash, desiredHash, state: "prepared" };
    if (!receipt) { await durableWrite(path.join(recoveryPath, "before"), new Uint8Array(before)); await durableWrite(receiptFile, Buffer.from(JSON.stringify(intent))); }
    await safePath(); const latest = await read();
    if (hash(await category(latest)) !== input.expectedHash) throw new Error("Portable settings changed while preparing recovery");
    deps.assertContext?.(); await ensureDurableDirectory(folder);
    await durableWrite(target, Buffer.from(JSON.stringify({ ...latest, ...document.value }, null, 2)));
    deps.assertContext?.(); await durableWrite(receiptFile, Buffer.from(JSON.stringify({ ...intent, state: "applied" })));
    return { status: "applied", hash: desiredHash, recoveryPath };
  });
}

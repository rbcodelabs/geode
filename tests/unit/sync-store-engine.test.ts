import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { HistoryController, type HistoryControllerPorts, type HistoryControllerState, type HistoryLocalResource, type HistoryOperation } from "../../src/sync-core/history-controller";
import type { AppendOnlySession, AppendOnlySyncProvider } from "../../src/sync-core/history-types";
import { FsStoreProvider } from "../../src/sync-node/index";
import { childProvider, cleanBundle, inProcessProvider, never, rm, tmpStore, type Child } from "../helpers/sync-store-harness";

afterAll(() => cleanBundle());
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const hash = (d: ArrayBuffer) => createHash("sha256").update(new Uint8Array(d)).digest("hex");

/** A device: an in-memory vault + in-memory controller state, wired to a real hub session. */
function device(vaultId: string, session: AppendOnlySession, initial: Record<string, string> = {}) {
  const files = new Map<string, ArrayBuffer>(Object.entries(initial).map(([p, t]) => [p, enc(t)]));
  const folders = new Set<string>();
  for (const p of files.keys()) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/")); }
  let state: HistoryControllerState | null = null;
  const operations = new Map<string, HistoryOperation>(), staged = new Map<string, ArrayBuffer>(), applied = new Set<string>();
  const deviceId = randomUUID();
  const ports: HistoryControllerPorts = {
    load: async () => state ? clone(state) : null, save: async next => { state = clone(next); },
    loadOperations: async () => [...operations.values()].map(clone), saveOperation: async op => { operations.set(op.id, clone(op)); },
    snapshot: async () => ({
      authoritative: true, scopeKey: "all", excluded: [], blocked: [],
      entries: [...[...folders].map(path => ({ namespace: "content" as const, path, kind: "folder" as const })), ...[...files].map(([path, data]): HistoryLocalResource => ({ namespace: "content", path, kind: "file", sha256: hash(data), size: data.byteLength }))],
    }),
    read: async r => files.get(r.path)!.slice(0),
    stage: async (id, data) => { staged.set(id, data.slice(0)); return id; }, readStage: async key => staged.get(key)!.slice(0),
    apply: async input => {
      if (applied.has(input.operationId)) return;
      const current = files.has(input.path) ? hash(files.get(input.path)!) : folders.has(input.path) ? "folder" : null;
      if (current !== input.expectedHash) throw new Error("guard mismatch");
      if (input.deleted) { if (input.kind === "folder") folders.delete(input.path); else files.delete(input.path); }
      else if (input.kind === "folder") folders.add(input.path);
      else files.set(input.path, input.data!.slice(0));
      applied.add(input.operationId);
    },
    isIncluded: () => true, assertContext: () => { }, newId: () => randomUUID(),
  };
  const controller = new HistoryController({ vaultId, deviceId, bindingKey: `${deviceId}:${vaultId}`, session, ports });
  return {
    files, folders, controller,
    set: (p: string, t: string) => files.set(p, enc(t)),
    text: (p: string) => files.has(p) ? new TextDecoder().decode(files.get(p)) : undefined,
    sync: async (approve = false) => { await controller.preview(never); return controller.run(approve ? { approvePreview: true } : {}, never); },
  };
}

interface Hub { provider: AppendOnlySyncProvider; store: string; cleanup(): Promise<void> }
const hubs: Array<[string, () => Hub]> = [
  ["FsStore", () => { const store = tmpStore(); return { provider: new FsStoreProvider(store), store, cleanup: async () => rm(store) }; }],
  ["RpcStore over in-process pipes", () => { const store = tmpStore(), provider = inProcessProvider(store); return { provider, store, cleanup: async () => { await provider.close(); rm(store); } }; }],
  ["RpcStore over a child process", () => {
    const store = tmpStore(), children: Child[] = [], provider = childProvider(store, children);
    return { provider, store, cleanup: async () => { await provider.close(); await Promise.all(children.map(c => c.exited)); rm(store); } };
  }],
];

for (const [name, make] of hubs) describe(`two HistoryControllers converge through ${name}`, () => {
  it("replicates creates, edits, deletes and folders; surfaces a conflict head on concurrent edits", async () => {
    const hub = make();
    try {
      const binding = await hub.provider.createVault({ name: "wiki", operationId: "engine-op" }, never);
      const open = (id: string) => hub.provider.open({ binding, deviceId: id }, never);
      const A = device(binding.vaultId, await open("A"), { "a.md": "one", "dir/b.md": "two" });
      const B = device(binding.vaultId, await open("B"));

      // create
      await A.sync(true);
      await B.sync(true);
      expect(B.text("a.md")).toBe("one");
      expect(B.text("dir/b.md")).toBe("two");
      expect(B.folders.has("dir")).toBe(true);

      // edit propagates
      A.set("a.md", "edited by A");
      await A.sync();
      const afterEdit = await B.sync();
      expect(afterEdit.conflicts).toEqual([]);
      expect(B.text("a.md")).toBe("edited by A");

      // delete propagates, in the other direction too
      B.files.delete("dir/b.md");
      await B.sync();
      await A.sync();
      expect(A.text("dir/b.md")).toBeUndefined();
      expect(B.text("a.md")).toBe("edited by A");

      // converged: both devices are quiescent against the hub
      expect((await A.sync()).upToDate).toBe(true);
      expect((await B.sync()).upToDate).toBe(true);

      // concurrent edits from the same base never pick a clock winner: two heads, a conflict, no data loss
      A.set("a.md", "A concurrent");
      B.set("a.md", "B concurrent");
      expect((await A.sync()).conflicts).toEqual([]);
      const seenByB = await B.sync();
      expect(seenByB.conflicts).toHaveLength(1);
      expect(seenByB.conflicts[0]).toMatchObject({ path: "a.md" });
      expect(A.text("a.md")).toBe("A concurrent");
      expect(B.text("a.md")).toBe("B concurrent");
      const seenByA = await A.sync();
      expect(seenByA.conflicts).toHaveLength(1);

      // the hub itself holds both branches
      const verify = await (await open("verify")).scan(undefined, never);
      expect(verify.status).toBe("complete");
      const byParents = new Map<string, string[]>();
      for (const r of verify.records as Array<{ recordId: string; location: { name: string }; parents: string[] }>)
        if (r.location.name === "a.md" && r.parents.length) byParents.set(JSON.stringify(r.parents), [...(byParents.get(JSON.stringify(r.parents)) ?? []), r.recordId]);
      expect([...byParents.values()].some(ids => ids.length === 2)).toBe(true); // two sibling heads off one parent
    } finally { await hub.cleanup(); }
  }, 60_000);
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompassProvider, TRASH_FOLDER } from "../../src/renderer/internal-plugins/compass-sync/provider";
import { SyncCoordinator } from "../../src/renderer/sync/coordinator";
import type { HostServices } from "../../src/renderer/host/contracts";
import { FakeCompassServer } from "../helpers/fake-compass-server";

/**
 * The full Geode flow (preview -> approve -> run -> later runs) with the real SyncCoordinator, the real Compass
 * provider and an in-process Compass server. Only the vault filesystem is in memory.
 */
function vaultHost(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, value]) => [path, new TextEncoder().encode(value)]));
  const folders = new Set<string>();
  const trashed: string[] = [];
  const mtimes = new Map<string, number>([...files.keys()].map((path) => [path, 1]));
  const entries = () => {
    const dirs = new Set(folders);
    for (const path of files.keys()) for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i));
    return [
      ...[...dirs].map((path) => ({ path, isFolder: true, ctime: 1, mtime: 1, size: 0 })),
      ...[...files].map(([path, bytes]) => ({ path, isFolder: false, ctime: 1, mtime: mtimes.get(path) ?? 1, size: bytes.byteLength })),
    ];
  };
  const state = new Map<string, unknown>();
  const host = {
    capabilities: {}, runtime: {}, vaultRegistry: {},
    vaultFiles: {
      list: async () => entries(),
      read: async (path: string) => new TextDecoder().decode(files.get(path)),
      readBinary: async (path: string) => files.get(path)!.buffer.slice(0),
      write: async () => ({ ctime: 1, mtime: 1, size: 0 }),
      writeBinary: async (path: string, bytes: ArrayBuffer) => {
        files.set(path, new Uint8Array(bytes));
        const mtime = (mtimes.get(path) ?? 1) + 1;
        mtimes.set(path, mtime);
        return { ctime: 1, mtime, size: bytes.byteLength };
      },
      mkdir: async (path: string) => void folders.add(path),
      trash: async (path: string) => { files.delete(path); trashed.push(path); },
      rename: async () => {}, settleMutation: async () => {},
      exists: async (path: string) => files.has(path) || folders.has(path),
      onChange: () => () => {},
      reconcileScan: async () => ({ status: "complete" as const, entries: entries() }),
    },
    deviceState: { read: async (key: string) => state.get(key) ?? null, write: async (key: string, value: unknown) => void state.set(key, structuredClone(value)), remove: async (key: string) => void state.delete(key) },
    secrets: { available: false }, config: {}, metadataIndex: {}, navigation: {}, plugins: {},
  } as unknown as HostServices;
  return {
    host, trashed,
    text: (path: string) => (files.has(path) ? new TextDecoder().decode(files.get(path)) : undefined),
    write: (path: string, value: string) => { files.set(path, new TextEncoder().encode(value)); mtimes.set(path, (mtimes.get(path) ?? 1) + 1); },
    remove: (path: string) => { files.delete(path); },
    paths: () => [...files.keys()].sort(),
  };
}

let server: FakeCompassServer;
beforeEach(async () => { server = new FakeCompassServer(); await server.start(); });
afterEach(() => server.stop());

async function connect(vault: ReturnType<typeof vaultHost>, over: { useDelta?: boolean } = {}) {
  const provider = createCompassProvider({ connection: async () => ({ baseUrl: server.baseUrl, workspaceId: server.workspaceId, token: server.token, ...over }) });
  const coordinator = new SyncCoordinator(vault.host, () => "/vault");
  coordinator.register("compass-sync", provider);
  await coordinator.activate(provider.id);
  return coordinator;
}

describe("Compass through the real sync coordinator", () => {
  it("previews, requires approval, then syncs Markdown only and leaves other files alone", async () => {
    const vault = vaultHost({ "Local.md": "local", "Folder/Deep.md": "deep", "photo.png": "not markdown", "Conflict.md": "mine" });
    server.seed("Remote", "remote");
    server.seed("Conflict", "theirs");
    const coordinator = await connect(vault);

    const preview = await coordinator.preview();
    expect(preview).toMatchObject({ uploads: 2, downloads: 1, deletes: 0, conflicts: 1, skipped: 0, requiresApproval: true });
    expect(server.paths()).toEqual(["Conflict", "Remote"]);
    await expect(coordinator.run()).rejects.toThrow(/Preview this exact first sync/);

    await coordinator.run({ approvePreview: true });
    expect(server.paths()).toEqual(["Conflict", "Folder", "Folder/Deep", "Local", "Remote"]);
    expect(server.contentOf("Folder/Deep")).toBe("deep");
    expect(vault.text("Remote.md")).toBe("remote");
    expect(vault.text("photo.png")).toBe("not markdown");
    expect(server.paths().some((path) => path.includes("photo"))).toBe(false);
    expect(vault.text("Conflict.md")).toBe("mine");
    expect(await coordinator.listConflicts()).toHaveLength(1);

    // Steady state: nothing to do.
    expect(await coordinator.preview()).toMatchObject({ uploads: 0, downloads: 0, deletes: 0 });
  });

  it("propagates local edits, remote edits and conflicts with revision checks", async () => {
    const vault = vaultHost({ "A.md": "a1", "B.md": "b1" });
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });

    vault.write("A.md", "a2");
    server.edit("B", "b2");
    await coordinator.run();
    expect(server.contentOf("A")).toBe("a2");
    expect(vault.text("B.md")).toBe("b2");

    vault.write("A.md", "a3 local");
    server.edit("A", "a3 remote");
    await coordinator.run();
    const [conflict] = await coordinator.listConflicts();
    expect(conflict.path).toBe("A.md");
    expect(vault.text("A.md")).toBe("a3 local");
    expect(server.contentOf("A")).toBe("a3 remote");
    await coordinator.resolveConflict(conflict.id, "accept-remote");
    expect(vault.text("A.md")).toBe("a3 remote");
  });

  it("moves a locally deleted note into the Compass trash folder and keeps it recoverable", async () => {
    const vault = vaultHost({ "Doomed.md": "precious" });
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });

    vault.remove("Doomed.md");
    expect(await coordinator.preview()).toMatchObject({ deletes: 1 });
    await coordinator.run();
    const recovered = server.paths().find((path) => path.endsWith("/Doomed"))!;
    expect(recovered.startsWith(`${TRASH_FOLDER}/`)).toBe(true);
    expect(server.contentOf(recovered)).toBe("precious");
    // The trash is invisible to later scans: nothing is downloaded back, nothing is deleted again.
    expect(await coordinator.preview()).toMatchObject({ uploads: 0, downloads: 0, deletes: 0, conflicts: 0 });
  });

  it("moves a note deleted on Compass to the local trash", async () => {
    const vault = vaultHost({ "Gone.md": "bye" });
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    server.removeBehindBack("Gone");
    await coordinator.run();
    expect(vault.trashed).toEqual(["Gone.md"]);
  });

  it("never deletes anything from a partial, cursorless or unavailable scan", async () => {
    const vault = vaultHost({ "Keep.md": "keep" });
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    for (const stage of [() => { server.partial = true; }, () => { server.partial = false; server.nullCursor = true; }, () => { server.nullCursor = false; server.disabled = true; }]) {
      stage();
      await expect(coordinator.run()).rejects.toThrow(/complete remote scan is required/);
      expect(vault.text("Keep.md")).toBe("keep");
    }
    server.disabled = false;
    expect(server.paths()).toEqual(["Keep"]);
  });

  it("follows many pages and survives a stale continuation mid-sync", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) server.seed(`Note ${i}`, `n${i}`);
    server.pageSize = 3;
    server.staleContinuations = 1;
    const vault = vaultHost(files);
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    expect(vault.paths()).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `Note ${i}.md`));
  });

  it("skips a file whose name collides with an unsyncable Compass item instead of blocking the run, and does not retry it", async () => {
    const vault = vaultHost({ "Whiteboard Canvas.md": "std note", "Extra.md": "extra" });
    server.outOfScope.add("Whiteboard Canvas");
    server.seed("Remote", "r");
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    expect(vault.text("Remote.md")).toBe("r");
    expect(server.contentOf("Extra")).toBe("extra");
    expect(coordinator.getStatus().message).toMatch(/Whiteboard Canvas\.md.*not syncable/);
    const attempts = () => server.requests.filter((r) => r.method === "POST" && r.body?.path === "Whiteboard Canvas.md").length;
    expect(attempts()).toBe(1);
    expect(await coordinator.preview()).toMatchObject({ uploads: 0, skipped: 1 });
    await coordinator.run();
    expect(attempts()).toBe(1);
    vault.write("Whiteboard Canvas.md", "edited");
    await coordinator.run();
    expect(attempts()).toBe(2);
    expect(vault.text("Remote.md")).toBe("r");
  });

  it("does not download a folder-turned-leaf as an empty note, yet keeps syncing a deliberately empty uploaded note", async () => {
    server.addFrontmatter = true;
    server.seed("Dir/Child", "child body");
    const vault = vaultHost({ "Empty.md": "" });
    const coordinator = await connect(vault);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    expect(vault.text("Dir/Child.md")).toContain("child body");
    expect(server.paths()).toContain("Empty");

    server.removeBehindBack("Dir/Child");
    server.makeLeaf("Dir");
    await coordinator.run();
    expect(vault.paths()).not.toContain("Dir.md");
    // The empty note was uploaded earlier: later scans must keep it, not read it as deleted.
    expect(vault.text("Empty.md")).toBe("");
    expect(vault.trashed).toEqual(["Dir/Child.md"]);
    await coordinator.run();
    expect(vault.text("Empty.md")).toBe("");
    // And it still syncs as a file once it gets content.
    vault.write("Empty.md", "now with text");
    await coordinator.run();
    expect(server.contentOf("Empty")).toBe("now with text");
  });

  it("works with delta scans, including deletions arriving as tombstones", async () => {
    const vault = vaultHost({ "Edit.md": "e1", "Gone.md": "g" });
    const coordinator = await connect(vault, { useDelta: true });
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    server.edit("Edit", "e2");
    server.removeBehindBack("Gone");
    await coordinator.run();
    expect(vault.text("Edit.md")).toBe("e2");
    expect(vault.trashed).toEqual(["Gone.md"]);
    expect(server.requests.filter((r) => r.path.endsWith("/scan")).some((r) => r.query.get("cursor"))).toBe(true);
  });
});

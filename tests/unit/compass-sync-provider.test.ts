import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPASS_MAX_FILE_SIZE, TRASH_FOLDER, compassExclusion, stripFrontmatter, createCompassProvider, docPathOfVault, vaultPathOfDoc, type CompassConnection } from "../../src/renderer/internal-plugins/compass-sync/provider";
import type { SyncProvider, SyncSession } from "../../src/renderer/sync/types";
import { FakeCompassServer } from "../helpers/fake-compass-server";

const text = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer as ArrayBuffer;
const decode = (data: ArrayBuffer): string => new TextDecoder().decode(data);
const signal = () => new AbortController().signal;

let server: FakeCompassServer;
let connection: Partial<CompassConnection>;
let diagnostics: string[];
beforeEach(async () => {
  server = new FakeCompassServer();
  await server.start();
  connection = {};
  diagnostics = [];
});
afterEach(() => server.stop());

function provider(): SyncProvider {
  return createCompassProvider({
    connection: async () => ({ baseUrl: server.baseUrl, workspaceId: server.workspaceId, token: server.token, ...connection }),
    onDiagnostics: (_vault, message) => diagnostics.push(message),
  });
}
async function open(): Promise<SyncSession> {
  return provider().open({ vaultId: "/vault" });
}

describe("Compass provider declaration", () => {
  it("declares the conditional-mutation-v1 contract with the server's 1 MiB limit", () => {
    expect(provider()).toMatchObject({
      id: "compass.docs", name: "Compass", protocol: "conditional-mutation-v1",
      capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true, maxFileSize: COMPASS_MAX_FILE_SIZE },
    });
  });

  it("maps paths between docs and vault files", () => {
    expect(vaultPathOfDoc("Folder/Note")).toBe("Folder/Note.md");
    expect(docPathOfVault("Folder/Note.md")).toBe("Folder/Note");
    expect(() => docPathOfVault("Folder/photo.png")).toThrow(/Markdown/);
  });

  it("excludes what a doc cannot represent instead of failing", () => {
    expect(compassExclusion("a.md")).toBeNull();
    expect(compassExclusion("a/b.md", text("# fine"))).toBeNull();
    expect(compassExclusion("photo.png")).toMatch(/Markdown/);
    expect(compassExclusion("Note.MD")).toMatch(/Markdown/);
    expect(compassExclusion(".md")).toMatch(/name/);
    expect(compassExclusion(`${TRASH_FOLDER}/x/Note.md`)).toMatch(/reserved/);
    expect(compassExclusion("bin.md", new Uint8Array([0xff, 0xfe, 0x00]).buffer)).toMatch(/UTF-8/);
    expect(provider().excludePath?.("photo.png")).toMatch(/Markdown/);
  });
});

describe("implicit leaves, unsyncable names and diagnostics", () => {
  it("strips Compass frontmatter", () => {
    expect(stripFrontmatter("---\ncompass_doc_id: x\n---\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("---\ncompass_doc_id: x\n---\n")).toBe("");
    expect(stripFrontmatter("no frontmatter\n---\nx")).toBe("no frontmatter\n---\nx");
  });

  it("flags a body-less leaf (a former folder) implicit, but not parents with children or notes with a body", async () => {
    server.addFrontmatter = true;
    server.seed("Parent/Child", "has body");
    server.seed("Former", "x");
    server.makeLeaf("Former");
    server.seed("Real", "text");
    const entries = (await (await open()).scan(undefined, signal())).entries;
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath["Former.md"].implicit).toBe(true);
    expect(byPath["Real.md"].implicit).toBeUndefined();
    expect(byPath["Parent/Child.md"].implicit).toBeUndefined();
    expect(byPath["Parent"].kind).toBe("folder");
  });

  it("probes each revision once", async () => {
    server.addFrontmatter = true;
    server.seed("Tiny", "t");
    const p = provider();
    await (await p.open({ vaultId: "v" })).scan(undefined, signal());
    const reads = () => server.requests.filter((r) => r.method === "GET" && !r.path.endsWith("/scan")).length;
    const first = reads();
    await (await p.open({ vaultId: "v" })).scan(undefined, signal());
    expect(reads()).toBe(first);
  });

  it("a create onto a name held by an out-of-scope item is an unsyncable-file error, not a generic failure", async () => {
    server.outOfScope.add("Whiteboard Canvas");
    const error = await (await open()).create({ path: "Whiteboard Canvas.md", data: text("x"), operationKey: "op-c", signal: signal() }).catch((e: Error) => e);
    expect((error as Error).name).toBe("SyncUnsyncableError");
    expect((error as Error).message).toMatch(/not syncable/);
  });

  it("does not count the intentionally hidden trash folder as unrepresentable", async () => {
    server.seed("Good", "g");
    server.seed(`${TRASH_FOLDER}/2026/Old`, "o");
    await (await open()).scan(undefined, signal());
    expect(diagnostics.join(" ")).not.toMatch(/cannot be represented/);
  });
});

describe("preflight", () => {
  it("accepts a reachable, enabled workspace", async () => {
    await expect(provider().preflight!()).resolves.toBeUndefined();
  });
  it("explains a disabled endpoint, a bad token and a missing configuration", async () => {
    server.disabled = true;
    await expect(provider().preflight!()).rejects.toThrow(/not enabled/);
    server.disabled = false;
    connection = { token: "wrong" };
    await expect(provider().preflight!()).rejects.toThrow(/rejected the access token/);
    await expect(createCompassProvider({ connection: async () => null }).preflight!()).rejects.toThrow(/not configured/);
  });
});

describe("requests", () => {
  it("sends the bearer token and the configured extra header, never in the error text", async () => {
    server.requireHeader = { name: "x-vercel-protection-bypass", value: "bypass-secret" };
    const session = await open();
    const denied = await session.scan(undefined, signal()).catch((error: Error) => error);
    expect(denied).toBeInstanceOf(Error);
    expect(String((denied as Error).message)).not.toContain(server.token);
    connection = { extraHeader: { name: "x-vercel-protection-bypass", value: "bypass-secret" } };
    const ok = await (await open()).scan(undefined, signal());
    expect(ok.status).toBe("complete");
    const last = server.requests.at(-1)!;
    expect(last.headers.authorization).toBe(`Bearer ${server.token}`);
    expect(last.headers["x-vercel-protection-bypass"]).toBe("bypass-secret");
  });

  it("rejects an unusable URL or missing credentials before any request", async () => {
    connection = { baseUrl: "ftp://example.com" };
    await expect(provider().open({ vaultId: "v" })).rejects.toThrow(/https/);
    connection = { token: "" };
    await expect(provider().open({ vaultId: "v" })).rejects.toThrow(/token/);
    expect(server.requests).toHaveLength(0);
  });
});

describe("scan", () => {
  it("follows continuations and returns the final cursor as a complete snapshot with .md paths", async () => {
    server.seed("Notes/One", "1");
    server.seed("Two", "22");
    server.seed("Three", "333");
    server.pageSize = 2;
    const result = await (await open()).scan(undefined, signal());
    expect(result).toMatchObject({ status: "complete", mode: "snapshot", cursor: server.currentCursor() });
    expect(result.entries.map((entry) => [entry.path, entry.kind]).sort()).toEqual([["Notes", "folder"], ["Notes/One.md", "file"], ["Three.md", "file"], ["Two.md", "file"]]);
    expect(result.entries.find((entry) => entry.path === "Two.md")).toMatchObject({ size: 2, revision: expect.any(String), hash: expect.any(String) });
    expect(server.requests.filter((r) => r.path.endsWith("/scan")).length).toBeGreaterThan(1);
  });

  it("does not forward a stored cursor unless delta is enabled", async () => {
    server.seed("A", "a");
    await (await open()).scan("5", signal());
    expect(server.requests.at(-1)!.query.get("cursor")).toBeNull();
  });

  it("reports partial for a partial page, for a missing cursor, and for a page that promises more without a continuation", async () => {
    server.seed("A", "a");
    server.partial = true;
    expect(await (await open()).scan(undefined, signal())).toMatchObject({ status: "partial" });
    server.partial = false;
    server.nullCursor = true;
    expect(await (await open()).scan(undefined, signal())).toMatchObject({ status: "partial" });
  });

  it("reports unavailable, not empty, when the server flag is off", async () => {
    server.disabled = true;
    expect(await (await open()).scan(undefined, signal())).toEqual({ status: "unavailable", entries: [], errorCode: "compass-sync-disabled" });
  });

  it("restarts from the first page when a continuation goes stale, and gives up after repeated staleness", async () => {
    for (const name of ["A", "B", "C", "D", "E"]) server.seed(name, name);
    server.pageSize = 2;
    server.staleContinuations = 1;
    const result = await (await open()).scan(undefined, signal());
    expect(result.status).toBe("complete");
    expect(result.entries.map((entry) => entry.path).sort()).toEqual(["A.md", "B.md", "C.md", "D.md", "E.md"]);
    server.staleContinuations = 99;
    await expect((await open()).scan(undefined, signal())).rejects.toThrow(/stale/);
  });

  it("leaves out entries a vault cannot hold (hidden, unsafe) and the trash folder, and says so", async () => {
    server.seed("Good", "g");
    server.seed(".hidden/Secret", "s");
    server.seed(`${TRASH_FOLDER}/2026/Old`, "o");
    const result = await (await open()).scan(undefined, signal());
    expect(result.entries.map((entry) => entry.path)).toEqual(["Good.md"]);
    expect(diagnostics.join(" ")).toMatch(/cannot be represented/);
  });

  it("returns cancelled when aborted", async () => {
    server.seed("A", "a");
    server.delayMs = 200;
    const controller = new AbortController();
    const pending = (await open()).scan(undefined, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({ status: "cancelled", entries: [] });
  });

  it("uses delta scans when enabled and turns trash moves and labelled tombstones into explicit tombstones", async () => {
    connection = { useDelta: true };
    server.seed("Keep", "k");
    server.seed("Dir/Gone", "g");
    const first = await (await open()).scan(undefined, signal());
    const cursor = first.cursor!;
    server.edit("Keep", "k2");
    server.removeBehindBack("Dir/Gone");
    const delta = await (await open()).scan(cursor, signal());
    expect(server.requests.at(-1)!.query.get("cursor")).toBe(cursor);
    expect(delta).toMatchObject({ status: "complete", mode: "delta" });
    expect(delta.entries.find((entry) => entry.path === "Keep.md")).toMatchObject({ kind: "file" });
    expect(delta.entries.find((entry) => entry.kind === "tombstone")).toMatchObject({ deletedPath: "Dir/Gone.md" });
  });

  it("reports a doc moved into the trash folder as a tombstone for its original path in delta mode", async () => {
    connection = { useDelta: true };
    server.seed("Dir/Note", "n");
    const session = await open();
    const first = await session.scan(undefined, signal());
    const note = first.entries.find((entry) => entry.path === "Dir/Note.md")!;
    await session.trash({ id: note.id, expectedRevision: note.revision, signal: signal() });
    const delta = await session.scan(first.cursor, signal());
    expect(delta.mode).toBe("delta");
    expect(delta.entries.filter((entry) => entry.kind === "tombstone")).toEqual([expect.objectContaining({ id: note.id, deletedPath: "Dir/Note.md" })]);
    expect(delta.entries.some((entry) => entry.path.startsWith(TRASH_FOLDER))).toBe(false);
  });

  it("redoes a delta as a full snapshot when a tombstone cannot say whether a doc or a folder was deleted", async () => {
    connection = { useDelta: true };
    server.seed("Note", "n");
    const cursor = (await (await open()).scan(undefined, signal())).cursor!;
    server.removeBehindBack("Note");
    server.tombstoneKinds = false;
    const result = await (await open()).scan(cursor, signal());
    expect(result).toMatchObject({ status: "complete", mode: "snapshot" });
    expect(result.entries).toEqual([]);
  });
});

describe("read", () => {
  it("returns UTF-8 bytes under the requested revision only", async () => {
    server.seed("Note", "héllo");
    const session = await open();
    const [entry] = (await session.scan(undefined, signal())).entries;
    expect(decode(await session.read(entry, signal()))).toBe("héllo");
    server.edit("Note", "changed");
    await expect(session.read(entry, signal())).rejects.toMatchObject({ name: "SyncPreconditionError" });
  });
  it("refuses an oversize entry before requesting its bytes", async () => {
    server.seed("Big", "x");
    const session = await open();
    const requestsBefore = server.requests.length;
    await expect(session.read({ id: server.idOf("Big"), path: "Big.md", kind: "file", revision: "1", size: COMPASS_MAX_FILE_SIZE + 1 }, signal())).rejects.toThrow(RangeError);
    expect(server.requests.length).toBe(requestsBefore);
  });
});

describe("create / update", () => {
  it("creates idempotently for an operation key and echoes it", async () => {
    const session = await open();
    const first = await session.create({ path: "Folder/Note.md", data: text("hello"), operationKey: "op-1", signal: signal() });
    const again = await session.create({ path: "Folder/Note.md", data: text("hello"), operationKey: "op-1", signal: signal() });
    expect(first).toMatchObject({ path: "Folder/Note.md", kind: "file", operationKey: "op-1" });
    expect(again.id).toBe(first.id);
    expect(server.paths()).toEqual(["Folder", "Folder/Note"]);
    expect(server.requests.find((r) => r.method === "POST")!.body).toEqual({ path: "Folder/Note.md", content: "hello", operationKey: "op-1" });
  });

  it("maps a path conflict to a normal error and refuses what Compass cannot hold", async () => {
    server.seed("Taken", "t");
    const session = await open();
    await expect(session.create({ path: "Taken.md", data: text("x"), operationKey: "op-2", signal: signal() })).rejects.toThrow(/already exists/);
    await expect(session.create({ path: "pic.png", data: text("x"), operationKey: "op-3", signal: signal() })).rejects.toThrow(/Markdown/);
    await expect(session.create({ path: "bin.md", data: new Uint8Array([0xff, 0xfe]).buffer, operationKey: "op-4", signal: signal() })).rejects.toThrow(/UTF-8/);
    await expect(session.create({ path: "big.md", data: new ArrayBuffer(COMPASS_MAX_FILE_SIZE + 1), operationKey: "op-5", signal: signal() })).rejects.toThrow(RangeError);
  });

  it("updates against the expected revision and turns a revision conflict into SyncPreconditionError", async () => {
    server.seed("Note", "v1");
    const session = await open();
    const [entry] = (await session.scan(undefined, signal())).entries;
    const updated = await session.update({ id: entry.id, path: "Note.md", data: text("v2"), expectedRevision: entry.revision, operationKey: "op-6", signal: signal() });
    expect(updated.revision).not.toBe(entry.revision);
    expect(server.contentOf("Note")).toBe("v2");
    await expect(session.update({ id: entry.id, path: "Note.md", data: text("v3"), expectedRevision: entry.revision, operationKey: "op-7", signal: signal() })).rejects.toMatchObject({ name: "SyncPreconditionError" });
    expect(server.contentOf("Note")).toBe("v2");
  });
});

describe("move", () => {
  it("moves a doc, preserving its extension mapping, and rejects stale revisions and path conflicts", async () => {
    server.seed("A", "a");
    server.seed("B", "b");
    const session = await open();
    const entries = (await session.scan(undefined, signal())).entries;
    const a = entries.find((entry) => entry.path === "A.md")!;
    const moved = await session.move({ id: a.id, path: "Dir/A2.md", expectedRevision: a.revision, signal: signal() });
    expect(moved).toMatchObject({ path: "Dir/A2.md", kind: "file" });
    expect(server.paths()).toContain("Dir/A2");
    await expect(session.move({ id: a.id, path: "Dir/A3.md", expectedRevision: a.revision, signal: signal() })).rejects.toMatchObject({ name: "SyncPreconditionError" });
    const b = entries.find((entry) => entry.path === "B.md")!;
    const error = await session.move({ id: b.id, path: "Dir/A2.md", expectedRevision: b.revision, signal: signal() }).catch((e: Error) => e);
    expect((error as Error).name).not.toBe("SyncPreconditionError");
    expect((error as Error).message).toMatch(/already exists/);
  });

  it("never moves a folder: they are implicit on Compass", async () => {
    server.seedFolder("Old");
    const session = await open();
    const folder = (await session.scan(undefined, signal())).entries[0];
    await expect(session.move({ id: folder.id, path: "New", expectedRevision: folder.revision, signal: signal() })).rejects.toThrow(/implicit|cannot be moved/);
  });

  it("sends the revision with reads and sends mutation paths with .md", async () => {
    server.seed("Dir/Note", "n");
    const session = await open();
    const [, note] = (await session.scan(undefined, signal())).entries.sort((a, b) => a.path.localeCompare(b.path));
    await session.read(note, signal());
    expect(server.requests.at(-1)!.query.get("revision")).toBe(note.revision);
    await session.trash({ id: note.id, expectedRevision: note.revision, signal: signal() });
    expect(server.requests.at(-1)!.body.path).toMatch(/^Geode Trash\/.+\/Dir\/Note\.md$/);
  });
});

describe("trash", () => {
  it("moves a doc into the reserved trash folder so it is recoverable, and the next scan no longer lists it", async () => {
    server.seed("Dir/Note", "keep me");
    const session = await open();
    const note = (await session.scan(undefined, signal())).entries.find((entry) => entry.path === "Dir/Note.md")!;
    await session.trash({ id: note.id, expectedRevision: note.revision, signal: signal() });
    const trashed = server.paths().find((path) => path.endsWith("/Dir/Note"))!;
    expect(trashed.startsWith(`${TRASH_FOLDER}/`)).toBe(true);
    expect(server.contentOf(trashed)).toBe("keep me");
    expect((await session.scan(undefined, signal())).entries.map((entry) => entry.path)).toEqual(["Dir"]);
  });

  it("rejects a stale revision without touching the doc", async () => {
    server.seed("Note", "n");
    const session = await open();
    const note = (await session.scan(undefined, signal())).entries[0];
    server.edit("Note", "newer");
    await expect(session.trash({ id: note.id, expectedRevision: note.revision, signal: signal() })).rejects.toMatchObject({ name: "SyncPreconditionError" });
    expect(server.paths()).toEqual(["Note"]);
  });

  it("hard-deletes a doc in delete mode", async () => {
    connection = { trashMode: "delete" };
    server.seed("Dir/Note", "n");
    const session = await open();
    const note = (await session.scan(undefined, signal())).entries.find((entry) => entry.path === "Dir/Note.md")!;
    await session.trash({ id: note.id, expectedRevision: note.revision, signal: signal() });
    expect(server.paths()).toEqual(["Dir"]);
  });

  it("treats removing a folder as a no-op (implicit on Compass) and never sweeps up docs added meanwhile", async () => {
    server.seedFolder("Dir");
    const session = await open();
    const dir = (await session.scan(undefined, signal())).entries[0];
    server.seed("Dir/New", "added by another device");
    const before = server.requests.length;
    await session.trash({ id: dir.id, expectedRevision: dir.revision, signal: signal() }).catch(() => {});
    expect(server.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
    expect(server.paths()).toContain("Dir/New");
  });
});

describe("abort and close", () => {
  it("rejects an in-flight mutation when its signal aborts, and refuses use after close", async () => {
    const session = await open();
    server.delayMs = 300;
    const controller = new AbortController();
    const pending = session.create({ path: "Slow.md", data: text("x"), operationKey: "op-8", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.read({ id: "x", path: "x.md", kind: "file", revision: "1" }, AbortSignal.abort())).rejects.toBeDefined();
    await session.close();
    await expect(session.scan(undefined, signal())).rejects.toThrow(/closed/);
  });

  it("close() interrupts in-flight work", async () => {
    server.seed("A", "a");
    server.delayMs = 300;
    const session = await open();
    const pending = session.scan(undefined, signal());
    setTimeout(() => void session.close(), 20);
    expect(await pending).toEqual({ status: "cancelled", entries: [] });
  });
});

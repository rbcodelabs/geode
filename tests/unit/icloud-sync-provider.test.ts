import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conflictOriginalName,
  createIcloudProvider,
  ErrorCodes,
  ICLOUD_CAPABILITIES,
  normalizeRelPath,
  realNameOfPlaceholder,
  TRANSFER_CHUNK_BYTES,
  type IcloudDiagnostics,
  type IcloudProviderOptions,
} from "../../src/renderer/internal-plugins/icloud-sync/provider";
import { vaultFolderName } from "../../src/renderer/internal-plugins/icloud-sync/folders";
import type { SyncRemoteEntry, SyncSession } from "../../src/renderer/sync/types";
import { createFakeHarness, createNodeHarness, type IcloudHarness } from "../helpers/icloud-harness";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const signal = () => new AbortController().signal;

/**
 * The provider's contract suite. It runs against the in-memory fake bridge AND the real Node `fs` bridge on a
 * temp directory, so the provider is held to the bridge contract and nothing else; the Node leg is the PR #381
 * suite carried over (same assertions, same failure modes).
 */
describe.each([
  ["fake bridge", createFakeHarness],
  ["node fs bridge", createNodeHarness],
] as Array<[string, () => IcloudHarness]>)("iCloud provider over the %s", (_name, makeHarness) => {
  let h: IcloudHarness;
  let sessions: SyncSession[];

  beforeEach(() => {
    h = makeHarness();
    sessions = [];
  });
  afterEach(async () => {
    await Promise.all(sessions.map((s) => s.close()));
    h.cleanup();
  });

  async function open(options: Partial<IcloudProviderOptions> = {}, vaultId = "vault-1") {
    const provider = createIcloudProvider({ bridge: h.bridge, placeholderWaitMs: 50, placeholderPollMs: 5, ...options });
    const session = await provider.open({ vaultId });
    sessions.push(session);
    return session;
  }
  async function scanFiles(session: SyncSession) {
    const result = await session.scan(undefined, signal());
    return { result, byPath: new Map(result.entries.map((e) => [e.path, e])) };
  }
  const expectPrecondition = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toMatchObject({ name: "SyncPreconditionError" });
  };
  const update = (session: SyncSession, entry: SyncRemoteEntry, content: string, key = "u1") =>
    (session as any).update({ id: entry.id, path: entry.path, data: enc(content), expectedRevision: entry.revision, signal: signal(), operationKey: key });

  describe("provider declaration", () => {
    it("declares the agreed conditional-mutation-v1 capabilities", () => {
      const provider = createIcloudProvider({ bridge: h.bridge });
      expect(provider.protocol).toBe("conditional-mutation-v1");
      expect(provider.id).toBe("icloud");
      expect(provider.capabilities).toMatchObject({ ...ICLOUD_CAPABILITIES, delta: false });
      expect(provider.capabilities.maxFileSize).toBeGreaterThan(0);
    });
  });

  describe("scan", () => {
    it("fails closed as unavailable when the container is missing, and says why", async () => {
      h.makeUnavailable();
      const diagnostics: IcloudDiagnostics[] = [];
      const session = await open({ onDiagnostics: (_v, d) => diagnostics.push(d) });
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
      expect(diagnostics.at(-1)?.problems.join(" ")).toMatch(/container|test directory/i);
    });

    it("lists files and folders as a complete snapshot, NFC-normalised, without junk, trash or state", async () => {
      const session = await open();
      await session.scan(undefined, signal()); // creates the folder + marker
      h.put("a.md", "a");
      h.put("Folder/b.md", "b");
      // APFS (the only real target) folds NFD/NFC names together; other filesystems do not, so only decompose the name on macOS.
      h.put(h.kind === "node" && process.platform === "darwin" ? "café.md" : "café.md", "nfd");
      h.put(".DS_Store", "junk");
      h.put("Folder/.DS_Store", "junk");
      h.put("._a.md", "appledouble");
      h.put(".geode-tmp-leftover", "tmp");
      h.put(".geode-trash/old/x.md", "trashed");
      const { result, byPath } = await scanFiles(session);
      expect(result.status).toBe("complete");
      expect(result.mode).toBe("snapshot");
      expect(result.cursor).toBeTruthy();
      expect([...byPath.keys()].sort()).toEqual(["Folder", "Folder/b.md", "a.md", "café.md"]);
      expect(byPath.get("Folder")?.kind).toBe("folder");
      expect(byPath.get("a.md")).toMatchObject({ kind: "file", size: 1 });
      expect(byPath.get("a.md")?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("does not treat a missing marker on a populated folder as an authoritative empty/complete snapshot", async () => {
      h.putRaw("a.md", "a"); // folder has content but no .geode-sync/marker.json
      const session = await open();
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", entries: [], errorCode: ErrorCodes.markerMissing });
      expect(h.exists(".geode-sync/marker.json")).toBe(false);
    });

    it("returns cancelled for an aborted scan", async () => {
      const session = await open();
      const controller = new AbortController();
      controller.abort();
      expect(await session.scan(undefined, controller.signal)).toMatchObject({ status: "cancelled", entries: [] });
    });

    it("lists oversize files with their size but never hashes them", async () => {
      const session = await open({ maxFileSize: 4 });
      await session.scan(undefined, signal());
      h.put("big.bin", "12345678");
      const { byPath } = await scanFiles(session);
      expect(byPath.get("big.bin")?.size).toBe(8);
      expect(byPath.get("big.bin")?.hash).toBeUndefined();
    });

    it("reports the container vanishing mid-scan as unavailable, never an empty snapshot", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.put("a.md", "a");
      h.makeUnavailable();
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
    });
  });

  describe("evicted iCloud placeholders", () => {
    it("recognises placeholder names", () => {
      expect(realNameOfPlaceholder(".Note.md.icloud")).toBe("Note.md");
      expect(realNameOfPlaceholder("Note.md.icloud")).toBeNull();
      expect(realNameOfPlaceholder(".icloud")).toBeNull();
    });

    it("requests a download and reports partial (no cursor) while a placeholder stays unresolved", async () => {
      const diagnostics: IcloudDiagnostics[] = [];
      const session = await open({ onDiagnostics: (_v, d) => diagnostics.push(d) });
      await session.scan(undefined, signal());
      h.put("ok.md", "ok");
      h.evict("Sub/Evicted.md");
      const result = await session.scan(undefined, signal());
      expect(result.status).toBe("partial");
      expect(result.errorCode).toBe(ErrorCodes.placeholders);
      expect(result.cursor).toBeUndefined();
      expect(result.entries.map((e) => e.path)).toEqual(["Sub", "ok.md"]); // the evicted file is neither listed nor implied deleted
      expect(h.downloads).toContain("Sub/Evicted.md");
      expect(diagnostics.at(-1)?.unresolvedPlaceholders).toEqual(["Sub/Evicted.md"]);
    });

    it("returns a complete scan including the file once the download materialises it", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.evict("Evicted.md");
      h.onDownload((folder, rel) => h.materialise(rel, "now here", folder));
      const { result, byPath } = await scanFiles(session);
      expect(result.status).toBe("complete");
      expect(byPath.get("Evicted.md")?.size).toBe(8);
    });

    it("stays partial when the download request itself fails", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.evict("Evicted.md");
      h.onDownload(() => {
        throw new Error("brctl missing");
      });
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", errorCode: ErrorCodes.placeholders });
    });

    it("refuses to read or update an evicted file instead of treating it as missing", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.evict("Gone.md");
      const entry: SyncRemoteEntry = { id: "p:Gone.md", path: "Gone.md", kind: "file", revision: "1:1:x" };
      await expect(session.read(entry, signal())).rejects.toThrow(/downloading/);
      await expect(update(session, entry, "x")).rejects.toThrow(/downloading/);
      expect(h.downloads).toContain("Gone.md");
    });
  });

  describe("iCloud conflict copies", () => {
    it("recognises conflict-shaped names", () => {
      expect(conflictOriginalName("Note 2.md")).toBe("Note.md");
      expect(conflictOriginalName("Note 12")).toBe("Note");
      expect(conflictOriginalName("Note.md")).toBeNull();
      expect(conflictOriginalName("Note2.md")).toBeNull();
    });

    it("withholds a conflict copy, reports partial, and keeps the original listed", async () => {
      const diagnostics: IcloudDiagnostics[] = [];
      const session = await open({ onDiagnostics: (_v, d) => diagnostics.push(d) });
      await session.scan(undefined, signal());
      h.put("Note.md", "winner");
      h.put("Note 2.md", "loser");
      const result = await session.scan(undefined, signal());
      expect(result.status).toBe("partial");
      expect(result.errorCode).toBe(ErrorCodes.conflictCopies);
      expect(result.cursor).toBeUndefined();
      expect(result.entries.map((e) => e.path)).toEqual(["Note.md"]);
      expect(diagnostics.at(-1)?.conflictCopies).toEqual([{ path: "Note 2.md", original: "Note.md" }]);
    });

    it("treats a numbered name with no matching original as an ordinary file", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.put("Chapter 2.md", "real chapter");
      const { result, byPath } = await scanFiles(session);
      expect(result.status).toBe("complete");
      expect(byPath.has("Chapter 2.md")).toBe(true);
    });

    it("does not flag a conflict-shaped path that Geode itself created", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      h.put("Chapter.md", "one");
      await session.create({ path: "Chapter 2.md", data: enc("two"), operationKey: "op-ch2", signal: signal() });
      const { result, byPath } = await scanFiles(session);
      expect(result.status).toBe("complete");
      expect(byPath.has("Chapter 2.md")).toBe(true);
    });
  });

  describe("conditional update", () => {
    it("replaces bytes atomically and returns a new revision when the revision matches", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      const after = await update(session, before, "v2");
      expect(after.revision).not.toBe(before.revision);
      expect(after.operationKey).toBe("u1");
      expect(dec(await session.read(after, signal()))).toBe("v2");
      expect(h.names().some((n) => n.startsWith(".geode-tmp-"))).toBe(false);
    });

    it("throws SyncPreconditionError and leaves the file untouched on a stale revision", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      h.putRaw("a.md", "other device wrote this"); // another device changed it
      await expectPrecondition(update(session, before, "mine"));
      expect(h.text("a.md")).toBe("other device wrote this");
      expect(h.names().some((n) => n.startsWith(".geode-tmp-"))).toBe(false);
    });

    it("detects a same-size, same-mtime content change through the hash", async () => {
      const session = await open();
      h.put("a.md", "AAAA");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      if (h.kind === "node") {
        const abs = path.join((h as any).documents, h.folder, "a.md");
        const stat = fs.statSync(abs);
        fs.writeFileSync(abs, "BBBB");
        fs.utimesSync(abs, stat.atime, stat.mtime);
      } else {
        // The fake's clock always advances on write; model the same-mtime case by restoring the listed revision's mtime.
        const fake = (h as any).fake;
        const node = fake.nodes.get(`${h.folder}/a.md`);
        fake.nodes.set(`${h.folder}/a.md`, { ...node, bytes: new TextEncoder().encode("BBBB") });
      }
      await expectPrecondition(update(session, before, "mine"));
    });

    it("rejects when the file was deleted remotely", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      h.rm("a.md");
      await expectPrecondition(update(session, before, "x"));
    });

    it("rejects content over maxFileSize before writing", async () => {
      const session = await open({ maxFileSize: 4 });
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      await expect(update(session, before, "too large")).rejects.toThrow(RangeError);
    });

    it("discards the staged write when the publish is refused", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      h.putRaw("a.md", "changed");
      await expectPrecondition(update(session, before, "mine"));
      if (h.kind === "fake") expect((h as any).fake.pendingWrites).toBe(0);
    });
  });

  describe("read", () => {
    it("returns the bytes for a current entry and rejects a stale revision", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const entry = (await scanFiles(session)).byPath.get("a.md")!;
      expect(dec(await session.read(entry, signal()))).toBe("v1");
      h.putRaw("a.md", "v2!");
      await expectPrecondition(session.read(entry, signal()));
    });

    it("reads a file larger than one transfer chunk in ranges and verifies it end to end", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      const big = "x".repeat(TRANSFER_CHUNK_BYTES + 1234) + "END";
      h.put("big.txt", big);
      const entry = (await scanFiles(session)).byPath.get("big.txt")!;
      const bytes = await session.read(entry, signal());
      expect(bytes.byteLength).toBe(big.length);
      expect(dec(bytes).endsWith("END")).toBe(true);
    });

    it("rejects reading a file that vanished", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const entry = (await scanFiles(session)).byPath.get("a.md")!;
      h.rm("a.md");
      await expectPrecondition(session.read(entry, signal()));
    });
  });

  describe("idempotent create", () => {
    it("returns the same entry for a replayed operationKey without rewriting", async () => {
      const session = await open();
      const first = await session.create({ path: "Dir/new.md", data: enc("hello"), operationKey: "op-1", signal: signal() });
      const second = await session.create({ path: "Dir/new.md", data: enc("hello"), operationKey: "op-1", signal: signal() });
      expect(second).toEqual(first);
      expect(first.operationKey).toBe("op-1");
      expect(dec(await session.read(first, signal()))).toBe("hello");
    });

    it("writes large creates in bounded chunks", async () => {
      const session = await open();
      const big = "y".repeat(TRANSFER_CHUNK_BYTES * 2 + 5);
      const created = await session.create({ path: "big.txt", data: enc(big), operationKey: "op-big", signal: signal() });
      expect(created.size).toBe(big.length);
      expect(h.text("big.txt")).toBe(big);
    });

    it("recovers an interrupted create (record written, file present) and replays idempotently from a new session", async () => {
      const one = await open();
      const first = await one.create({ path: "n.md", data: enc("x"), operationKey: "op-2", signal: signal() });
      await one.close();
      const two = await open();
      expect(await two.create({ path: "n.md", data: enc("x"), operationKey: "op-2", signal: signal() })).toEqual(first);
    });

    it("completes a create whose pending record was written but whose file never landed", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      const key = createHash("sha256").update("op-3").digest("hex");
      const sha = createHash("sha256").update("payload").digest("hex");
      h.putRaw(`.geode-sync/ops/${key}.json`, JSON.stringify({ path: "n.md", sha256: sha, committed: false }));
      const entry = await session.create({ path: "n.md", data: enc("payload"), operationKey: "op-3", signal: signal() });
      expect(dec(await session.read(entry, signal()))).toBe("payload");
    });

    it("never overwrites an existing file for a different operationKey", async () => {
      const session = await open();
      h.put("n.md", "existing");
      await expectPrecondition(session.create({ path: "n.md", data: enc("new"), operationKey: "op-4", signal: signal() }));
      expect(h.text("n.md")).toBe("existing");
    });

    it("does not resurrect a file when a committed create is replayed after the file was deleted", async () => {
      const session = await open();
      await session.create({ path: "n.md", data: enc("x"), operationKey: "op-5", signal: signal() });
      h.rm("n.md");
      await expectPrecondition(session.create({ path: "n.md", data: enc("x"), operationKey: "op-5", signal: signal() }));
      expect(h.exists("n.md")).toBe(false);
    });

    it("rejects an operationKey replayed against a different path", async () => {
      const session = await open();
      await session.create({ path: "a.md", data: enc("x"), operationKey: "op-6", signal: signal() });
      await expectPrecondition(session.create({ path: "b.md", data: enc("x"), operationKey: "op-6", signal: signal() }));
    });

    it("rejects oversize content", async () => {
      const session = await open({ maxFileSize: 3 });
      await expect(session.create({ path: "n.md", data: enc("four"), operationKey: "op-7", signal: signal() })).rejects.toThrow(RangeError);
    });

    it("fails closed when the create record is still evicted rather than duplicating the create", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      const key = createHash("sha256").update("op-8").digest("hex");
      h.evict(`.geode-sync/ops/${key}.json`);
      await expect(session.create({ path: "n.md", data: enc("x"), operationKey: "op-8", signal: signal() })).rejects.toThrow(/downloading/);
      expect(h.exists("n.md")).toBe(false);
    });
  });

  describe("move", () => {
    it("renames atomically (creating parents) and returns the new entry", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      const moved = (await session.move({ id: before.id, path: "New/Place/a.md", expectedRevision: before.revision, signal: signal() })) as SyncRemoteEntry;
      expect(moved.path).toBe("New/Place/a.md");
      expect(moved.hash).toBe(before.hash);
      expect(h.exists("a.md")).toBe(false);
    });

    it("rejects a stale revision without moving", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      h.putRaw("a.md", "changed");
      await expectPrecondition(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: signal() }));
      expect(h.exists("a.md")).toBe(true);
      expect(h.exists("b.md")).toBe(false);
    });

    it("refuses to overwrite an existing target", async () => {
      const session = await open();
      h.put("a.md", "v1");
      h.put("b.md", "other");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      await expectPrecondition(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: signal() }));
      expect(h.text("b.md")).toBe("other");
    });

    it("moves a folder when the folder revision matches", async () => {
      const session = await open();
      h.put("D/x.md", "x");
      const dir = (await scanFiles(session)).byPath.get("D")!;
      await session.move({ id: dir.id, path: "E", expectedRevision: dir.revision, signal: signal() });
      expect(h.exists("E/x.md")).toBe(true);
    });

    it("refuses to move a folder into itself", async () => {
      const session = await open();
      h.put("D/x.md", "x");
      const dir = (await scanFiles(session)).byPath.get("D")!;
      await expect(session.move({ id: dir.id, path: "D/Inner", expectedRevision: dir.revision, signal: signal() })).rejects.toThrow(/into itself/);
    });
  });

  describe("trash", () => {
    it("moves the file into .geode-trash, preserving its path, and excludes it from later scans", async () => {
      const session = await open();
      h.put("Dir/a.md", "keep me recoverable");
      const before = (await scanFiles(session)).byPath.get("Dir/a.md")!;
      await session.trash({ id: before.id, expectedRevision: before.revision, signal: signal() });
      expect(h.exists("Dir/a.md")).toBe(false);
      const buckets = h.names(".geode-trash");
      expect(buckets).toHaveLength(1);
      expect(h.text(`.geode-trash/${buckets[0]}/Dir/a.md`)).toBe("keep me recoverable");
      const { result, byPath } = await scanFiles(session);
      expect(result.status).toBe("complete");
      expect([...byPath.keys()]).toEqual(["Dir"]);
    });

    it("rejects a stale revision and keeps the file", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      h.putRaw("a.md", "v2!");
      await expectPrecondition(session.trash({ id: before.id, expectedRevision: before.revision, signal: signal() }));
      expect(h.exists("a.md")).toBe(true);
      expect(h.exists(".geode-trash")).toBe(false);
    });

    it("refuses to trash a non-empty folder", async () => {
      const session = await open();
      h.put("D/x.md", "x");
      const dir = (await scanFiles(session)).byPath.get("D")!;
      await expectPrecondition(session.trash({ id: dir.id, expectedRevision: dir.revision, signal: signal() }));
      expect(h.exists("D/x.md")).toBe(true);
    });
  });

  describe("abort and close", () => {
    it("rejects a pre-aborted create without writing anything", async () => {
      const session = await open();
      const controller = new AbortController();
      controller.abort();
      await expect(session.create({ path: "n.md", data: enc("x"), operationKey: "op", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(h.exists("n.md")).toBe(false);
    });

    it("rejects aborted update, move, trash and read", async () => {
      const session = await open();
      h.put("a.md", "v1");
      const before = (await scanFiles(session)).byPath.get("a.md")!;
      const controller = new AbortController();
      controller.abort();
      const s = controller.signal;
      await expect((session as any).update({ id: before.id, path: "a.md", data: enc("x"), expectedRevision: before.revision, signal: s, operationKey: "k" })).rejects.toMatchObject({ name: "AbortError" });
      await expect(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: s })).rejects.toMatchObject({ name: "AbortError" });
      await expect(session.trash({ id: before.id, expectedRevision: before.revision, signal: s })).rejects.toMatchObject({ name: "AbortError" });
      await expect(session.read(before, s)).rejects.toMatchObject({ name: "AbortError" });
      expect(h.text("a.md")).toBe("v1");
    });

    it("aborts a scan that is waiting on placeholder downloads", async () => {
      const session = await open({ placeholderWaitMs: 60_000, placeholderPollMs: 10 });
      await session.scan(undefined, signal());
      h.evict("Slow.md");
      const controller = new AbortController();
      const pending = session.scan(undefined, controller.signal);
      setTimeout(() => controller.abort(), 40);
      expect(await pending).toMatchObject({ status: "cancelled" });
    });

    it("close() cancels in-flight work and rejects later calls", async () => {
      const session = await open({ placeholderWaitMs: 60_000, placeholderPollMs: 10 });
      await session.scan(undefined, signal());
      h.evict("Slow.md");
      const pending = session.scan(undefined, signal());
      setTimeout(() => void session.close(), 40);
      expect(await pending).toMatchObject({ status: "cancelled" });
      await expect(session.scan(undefined, signal())).rejects.toThrow(/closed/);
    });
  });

  describe("path safety", () => {
    it("normalises to NFC and rejects traversal and reserved names", () => {
      expect(normalizeRelPath("café/x.md")).toBe("café/x.md");
      for (const bad of ["../x", "a/../x", "/abs", "a//b", "", "a\\b", ".geode-trash/x", ".geode-sync/ops/x", ".geode-tmp-1", ".x.icloud"]) {
        expect(() => normalizeRelPath(bad), bad).toThrow();
      }
    });

    it("reports symlinks in the vault folder as an incomplete scan", async () => {
      const session = await open();
      await session.scan(undefined, signal());
      if (h.kind === "node") fs.symlinkSync("/tmp", path.join((h as any).documents, h.folder, "link"));
      else (h as any).fake.seedSymlink(h.folder, "link");
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", errorCode: ErrorCodes.symlink });
    });

    it("derives distinct, safe folder names from vault ids", async () => {
      expect(await vaultFolderName("My Vault")).toBe("My Vault");
      const a = await vaultFolderName("../evil");
      const b = await vaultFolderName(".._evil");
      expect(a).not.toContain("/");
      expect(a).not.toBe(b);
      expect(await vaultFolderName("")).toMatch(/^vault-[0-9a-f]{8}$/);
    });
  });
});

describe("iCloud provider over the node fs bridge only", () => {
  let h: ReturnType<typeof createNodeHarness>;
  beforeEach(() => {
    h = createNodeHarness();
  });
  afterEach(() => h.cleanup());

  it("refuses to write through a symlink that escapes the vault folder", async () => {
    const session = await createIcloudProvider({ bridge: h.bridge }).open({ vaultId: "vault-1" });
    await session.scan(undefined, signal());
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-outside-"));
    try {
      fs.symlinkSync(outside, path.join(h.documents, "vault-1", "link"));
      await expect(session.create({ path: "link/x.md", data: enc("x"), operationKey: "op", signal: signal() })).rejects.toThrow(/outside/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      await session.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves no temp file behind after a create", async () => {
    const session = await createIcloudProvider({ bridge: h.bridge }).open({ vaultId: "vault-1" });
    await session.create({ path: "Dir/n.md", data: enc("hello"), operationKey: "k", signal: signal() });
    await session.close();
    expect(fs.readdirSync(path.join(h.documents, "vault-1", "Dir"))).toEqual(["n.md"]);
  });
});


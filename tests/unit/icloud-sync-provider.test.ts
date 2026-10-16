import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conflictOriginalName,
  createIcloudProvider,
  ErrorCodes,
  ICLOUD_CAPABILITIES,
  normalizeRelPath,
  realNameOfPlaceholder,
  vaultFolderName,
  type IcloudDiagnostics,
  type IcloudProviderOptions,
} from "../../packages/geode-icloud-sync/src/provider";
import type { SyncRemoteEntry, SyncSession } from "../../src/renderer/sync/types";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const signal = () => new AbortController().signal;

let drive: string;
let sessions: SyncSession[];

beforeEach(() => {
  drive = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-drive-"));
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.close()));
  fs.rmSync(drive, { recursive: true, force: true });
});

async function open(options: IcloudProviderOptions = {}, vaultId = "vault-1") {
  const provider = createIcloudProvider({ icloudDrive: drive, placeholderWaitMs: 50, placeholderPollMs: 5, download: async () => {}, ...options });
  const session = await provider.open({ vaultId });
  sessions.push(session);
  return session;
}
const remoteRoot = (vaultId = "vault-1") => path.join(drive, "Geode", vaultFolderName(vaultId));
const put = (rel: string, content: string) => {
  // Content delivered by iCloud arrives with the vault marker (see the marker-missing test for the opposite case).
  const marker = path.join(remoteRoot(), ".geode-sync/marker.json");
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "{}");
  }
  const abs = path.join(remoteRoot(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
async function scanFiles(session: SyncSession) {
  const result = await session.scan(undefined, signal());
  return { result, byPath: new Map(result.entries.map((e) => [e.path, e])) };
}
const expectPrecondition = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ name: "SyncPreconditionError" });
};

describe("provider declaration", () => {
  it("declares the agreed conditional-mutation-v1 capabilities", () => {
    const provider = createIcloudProvider({ icloudDrive: drive });
    expect(provider.protocol).toBe("conditional-mutation-v1");
    expect(provider.id).toBe("icloud");
    expect(provider.capabilities).toMatchObject({ ...ICLOUD_CAPABILITIES, delta: false });
    expect(provider.capabilities.maxFileSize).toBeGreaterThan(0);
  });
});

describe("scan", () => {
  it("fails closed as unavailable when iCloud Drive is missing", async () => {
    fs.rmSync(drive, { recursive: true });
    const session = await open();
    expect(await session.scan(undefined, signal())).toMatchObject({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
  });

  it("lists files and folders as a complete snapshot, NFC-normalised, without junk, trash or state", async () => {
    const session = await open();
    await session.scan(undefined, signal()); // creates the folder + marker
    put("a.md", "a");
    put("Folder/b.md", "b");
    // APFS (the only real target) folds NFD/NFC names together; Linux does not, so only decompose the name on macOS.
    put(process.platform === "darwin" ? "cafe\u0301.md" : "caf\u00e9.md", "nfd");
    put(".DS_Store", "junk");
    put("Folder/.DS_Store", "junk");
    put("._a.md", "appledouble");
    put(".geode-tmp-leftover", "tmp");
    put(".geode-trash/old/x.md", "trashed");
    const { result, byPath } = await scanFiles(session);
    expect(result.status).toBe("complete");
    expect(result.mode).toBe("snapshot");
    expect(result.cursor).toBeTruthy();
    expect([...byPath.keys()].sort()).toEqual(["Folder", "Folder/b.md", "a.md", "caf\u00e9.md"]);
    expect(byPath.get("Folder")?.kind).toBe("folder");
    expect(byPath.get("a.md")).toMatchObject({ kind: "file", size: 1 });
    expect(byPath.get("a.md")?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not treat a missing marker on a populated folder as an authoritative empty/complete snapshot", async () => {
    fs.mkdirSync(remoteRoot(), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot(), "a.md"), "a"); // folder has content but no .geode-sync/marker.json
    const session = await open();
    expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", entries: [], errorCode: ErrorCodes.markerMissing });
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
    put("big.bin", "12345678");
    const { byPath } = await scanFiles(session);
    expect(byPath.get("big.bin")?.size).toBe(8);
    expect(byPath.get("big.bin")?.hash).toBeUndefined();
  });
});

describe("evicted iCloud placeholders", () => {
  it("recognises placeholder names", () => {
    expect(realNameOfPlaceholder(".Note.md.icloud")).toBe("Note.md");
    expect(realNameOfPlaceholder("Note.md.icloud")).toBeNull();
    expect(realNameOfPlaceholder(".icloud")).toBeNull();
  });

  it("requests a download and reports partial (no cursor) while a placeholder stays unresolved", async () => {
    const download = vi.fn(async () => {});
    const diagnostics: IcloudDiagnostics[] = [];
    const session = await open({ download, onDiagnostics: (_v, d) => diagnostics.push(d) });
    await session.scan(undefined, signal());
    put("ok.md", "ok");
    put("Sub/.Evicted.md.icloud", "plist");
    const result = await session.scan(undefined, signal());
    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe(ErrorCodes.placeholders);
    expect(result.cursor).toBeUndefined();
    expect(result.entries.map((e) => e.path)).toEqual(["Sub", "ok.md"]); // the evicted file is neither listed nor implied deleted
    expect(download).toHaveBeenCalledWith(path.join(remoteRoot(), "Sub/Evicted.md"), expect.anything());
    expect(diagnostics.at(-1)?.unresolvedPlaceholders).toEqual(["Sub/Evicted.md"]);
  });

  it("returns a complete scan including the file once the download materialises it", async () => {
    const download = vi.fn(async (abs: string) => {
      fs.writeFileSync(abs, "now here");
      fs.rmSync(path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`));
    });
    const session = await open({ download });
    await session.scan(undefined, signal());
    put(".Evicted.md.icloud", "plist");
    const { result, byPath } = await scanFiles(session);
    expect(result.status).toBe("complete");
    expect(byPath.get("Evicted.md")?.size).toBe(8);
    expect(fs.existsSync(path.join(remoteRoot(), ".Evicted.md.icloud"))).toBe(false);
  });

  it("stays partial when the download request itself fails", async () => {
    const session = await open({ download: async () => { throw new Error("brctl missing"); } });
    await session.scan(undefined, signal());
    put(".Evicted.md.icloud", "plist");
    expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", errorCode: ErrorCodes.placeholders });
  });

  it("refuses to read or update an evicted file instead of treating it as missing", async () => {
    const download = vi.fn(async () => {});
    const session = await open({ download });
    await session.scan(undefined, signal());
    put(".Gone.md.icloud", "plist");
    const entry: SyncRemoteEntry = { id: "p:Gone.md", path: "Gone.md", kind: "file", revision: "1:1:x" };
    await expect(session.read(entry, signal())).rejects.toThrow(/downloading/);
    await expect(session.update({ id: "p:Gone.md", path: "Gone.md", data: enc("x"), expectedRevision: "1:1:x", signal: signal(), operationKey: "k" })).rejects.toThrow(/downloading/);
    expect(download).toHaveBeenCalled();
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
    put("Note.md", "winner");
    put("Note 2.md", "loser");
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
    put("Chapter 2.md", "real chapter");
    const { result, byPath } = await scanFiles(session);
    expect(result.status).toBe("complete");
    expect(byPath.has("Chapter 2.md")).toBe(true);
  });

  it("does not flag a conflict-shaped path that Geode itself created", async () => {
    const session = await open();
    await session.scan(undefined, signal());
    put("Chapter.md", "one");
    await session.create({ path: "Chapter 2.md", data: enc("two"), operationKey: "op-ch2", signal: signal() });
    const { result, byPath } = await scanFiles(session);
    expect(result.status).toBe("complete");
    expect(byPath.has("Chapter 2.md")).toBe(true);
  });
});

describe("conditional update", () => {
  it("replaces bytes atomically and returns a new revision when the revision matches", async () => {
    const session = await open();
    put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    const after = await session.update({ id: before.id, path: "a.md", data: enc("v2"), expectedRevision: before.revision, signal: signal(), operationKey: "u1" });
    expect(after.revision).not.toBe(before.revision);
    expect(after.operationKey).toBe("u1");
    expect(dec(await session.read(after, signal()))).toBe("v2");
    expect(fs.readdirSync(remoteRoot()).some((n) => n.startsWith(".geode-tmp-"))).toBe(false);
  });

  it("throws SyncPreconditionError and leaves the file untouched on a stale revision", async () => {
    const session = await open();
    put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    fs.writeFileSync(path.join(remoteRoot(), "a.md"), "other device wrote this"); // another device changed it
    await expectPrecondition(session.update({ id: before.id, path: "a.md", data: enc("mine"), expectedRevision: before.revision, signal: signal(), operationKey: "u1" }));
    expect(fs.readFileSync(path.join(remoteRoot(), "a.md"), "utf8")).toBe("other device wrote this");
    expect(fs.readdirSync(remoteRoot()).some((n) => n.startsWith(".geode-tmp-"))).toBe(false);
  });

  it("detects a same-size, same-mtime content change through the hash", async () => {
    const session = await open();
    const abs = put("a.md", "AAAA");
    const stat = fs.statSync(abs);
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    fs.writeFileSync(abs, "BBBB");
    fs.utimesSync(abs, stat.atime, stat.mtime);
    await expectPrecondition(session.update({ id: before.id, path: "a.md", data: enc("mine"), expectedRevision: before.revision, signal: signal(), operationKey: "u1" }));
  });

  it("rejects when the file was deleted remotely", async () => {
    const session = await open();
    const abs = put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    fs.rmSync(abs);
    await expectPrecondition(session.update({ id: before.id, path: "a.md", data: enc("x"), expectedRevision: before.revision, signal: signal(), operationKey: "u1" }));
  });

  it("rejects content over maxFileSize before writing", async () => {
    const session = await open({ maxFileSize: 4 });
    put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    await expect(session.update({ id: before.id, path: "a.md", data: enc("too large"), expectedRevision: before.revision, signal: signal(), operationKey: "u" })).rejects.toThrow(RangeError);
  });
});

describe("read", () => {
  it("returns the bytes for a current entry and rejects a stale revision", async () => {
    const session = await open();
    const abs = put("a.md", "v1");
    const entry = (await scanFiles(session)).byPath.get("a.md")!;
    expect(dec(await session.read(entry, signal()))).toBe("v1");
    fs.writeFileSync(abs, "v2!");
    await expectPrecondition(session.read(entry, signal()));
  });
});

describe("idempotent create", () => {
  it("returns the same entry for a replayed operationKey without rewriting", async () => {
    const session = await open();
    const first = await session.create({ path: "Dir/new.md", data: enc("hello"), operationKey: "op-1", signal: signal() });
    const mtime = fs.statSync(path.join(remoteRoot(), "Dir/new.md")).mtimeMs;
    const second = await session.create({ path: "Dir/new.md", data: enc("hello"), operationKey: "op-1", signal: signal() });
    expect(second).toEqual(first);
    expect(first.operationKey).toBe("op-1");
    expect(fs.statSync(path.join(remoteRoot(), "Dir/new.md")).mtimeMs).toBe(mtime);
    expect(dec(await session.read(first, signal()))).toBe("hello");
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
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update("op-3").digest("hex");
    const sha = createHash("sha256").update("payload").digest("hex");
    fs.mkdirSync(path.join(remoteRoot(), ".geode-sync/ops"), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot(), `.geode-sync/ops/${key}.json`), JSON.stringify({ path: "n.md", sha256: sha, committed: false }));
    const entry = await session.create({ path: "n.md", data: enc("payload"), operationKey: "op-3", signal: signal() });
    expect(dec(await session.read(entry, signal()))).toBe("payload");
  });

  it("never overwrites an existing file for a different operationKey", async () => {
    const session = await open();
    put("n.md", "existing");
    await expectPrecondition(session.create({ path: "n.md", data: enc("new"), operationKey: "op-4", signal: signal() }));
    expect(fs.readFileSync(path.join(remoteRoot(), "n.md"), "utf8")).toBe("existing");
  });

  it("does not resurrect a file when a committed create is replayed after the file was deleted", async () => {
    const session = await open();
    await session.create({ path: "n.md", data: enc("x"), operationKey: "op-5", signal: signal() });
    fs.rmSync(path.join(remoteRoot(), "n.md"));
    await expectPrecondition(session.create({ path: "n.md", data: enc("x"), operationKey: "op-5", signal: signal() }));
    expect(fs.existsSync(path.join(remoteRoot(), "n.md"))).toBe(false);
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
});

describe("move", () => {
  it("renames atomically (creating parents) and returns the new entry", async () => {
    const session = await open();
    put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    const moved = (await session.move({ id: before.id, path: "New/Place/a.md", expectedRevision: before.revision, signal: signal() })) as SyncRemoteEntry;
    expect(moved.path).toBe("New/Place/a.md");
    expect(moved.hash).toBe(before.hash);
    expect(fs.existsSync(path.join(remoteRoot(), "a.md"))).toBe(false);
  });

  it("rejects a stale revision without moving", async () => {
    const session = await open();
    const abs = put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    fs.writeFileSync(abs, "changed");
    await expectPrecondition(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: signal() }));
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(path.join(remoteRoot(), "b.md"))).toBe(false);
  });

  it("refuses to overwrite an existing target", async () => {
    const session = await open();
    put("a.md", "v1");
    put("b.md", "other");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    await expectPrecondition(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: signal() }));
    expect(fs.readFileSync(path.join(remoteRoot(), "b.md"), "utf8")).toBe("other");
  });

  it("moves a folder when the folder revision matches", async () => {
    const session = await open();
    put("D/x.md", "x");
    const dir = (await scanFiles(session)).byPath.get("D")!;
    await session.move({ id: dir.id, path: "E", expectedRevision: dir.revision, signal: signal() });
    expect(fs.existsSync(path.join(remoteRoot(), "E/x.md"))).toBe(true);
  });
});

describe("trash", () => {
  it("moves the file into .geode-trash, preserving its path, and excludes it from later scans", async () => {
    const session = await open();
    put("Dir/a.md", "keep me recoverable");
    const before = (await scanFiles(session)).byPath.get("Dir/a.md")!;
    await session.trash({ id: before.id, expectedRevision: before.revision, signal: signal() });
    expect(fs.existsSync(path.join(remoteRoot(), "Dir/a.md"))).toBe(false);
    const trashed = fs.readdirSync(path.join(remoteRoot(), ".geode-trash")).map((bucket) => path.join(remoteRoot(), ".geode-trash", bucket, "Dir/a.md"));
    expect(trashed).toHaveLength(1);
    expect(fs.readFileSync(trashed[0], "utf8")).toBe("keep me recoverable");
    const { result, byPath } = await scanFiles(session);
    expect(result.status).toBe("complete");
    expect([...byPath.keys()]).toEqual(["Dir"]);
  });

  it("rejects a stale revision and keeps the file", async () => {
    const session = await open();
    const abs = put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    fs.writeFileSync(abs, "v2!");
    await expectPrecondition(session.trash({ id: before.id, expectedRevision: before.revision, signal: signal() }));
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(path.join(remoteRoot(), ".geode-trash"))).toBe(false);
  });

  it("refuses to trash a non-empty folder", async () => {
    const session = await open();
    put("D/x.md", "x");
    const dir = (await scanFiles(session)).byPath.get("D")!;
    await expectPrecondition(session.trash({ id: dir.id, expectedRevision: dir.revision, signal: signal() }));
    expect(fs.existsSync(path.join(remoteRoot(), "D/x.md"))).toBe(true);
  });
});

describe("abort and close", () => {
  it("rejects a pre-aborted create without writing anything", async () => {
    const session = await open();
    const controller = new AbortController();
    controller.abort();
    await expect(session.create({ path: "n.md", data: enc("x"), operationKey: "op", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.existsSync(path.join(remoteRoot(), "n.md"))).toBe(false);
  });

  it("rejects aborted update, move, trash and read", async () => {
    const session = await open();
    put("a.md", "v1");
    const before = (await scanFiles(session)).byPath.get("a.md")!;
    const controller = new AbortController();
    controller.abort();
    const s = controller.signal;
    await expect(session.update({ id: before.id, path: "a.md", data: enc("x"), expectedRevision: before.revision, signal: s, operationKey: "k" })).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.move({ id: before.id, path: "b.md", expectedRevision: before.revision, signal: s })).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.trash({ id: before.id, expectedRevision: before.revision, signal: s })).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.read(before, s)).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readFileSync(path.join(remoteRoot(), "a.md"), "utf8")).toBe("v1");
  });

  it("aborts a scan that is waiting on placeholder downloads", async () => {
    const session = await open({ placeholderWaitMs: 60_000, placeholderPollMs: 10 });
    await session.scan(undefined, signal());
    put(".Slow.md.icloud", "plist");
    const controller = new AbortController();
    const pending = session.scan(undefined, controller.signal);
    setTimeout(() => controller.abort(), 40);
    expect(await pending).toMatchObject({ status: "cancelled" });
  });

  it("close() cancels in-flight work and rejects later calls", async () => {
    const session = await open({ placeholderWaitMs: 60_000, placeholderPollMs: 10 });
    await session.scan(undefined, signal());
    put(".Slow.md.icloud", "plist");
    const pending = session.scan(undefined, signal());
    setTimeout(() => void session.close(), 40);
    expect(await pending).toMatchObject({ status: "cancelled" });
    await expect(session.scan(undefined, signal())).rejects.toThrow(/closed/);
  });
});

describe("path safety", () => {
  it("normalises to NFC and rejects traversal and reserved names", () => {
    expect(normalizeRelPath("café/x.md")).toBe("café/x.md");
    for (const bad of ["../x", "a/../x", "/abs", "a//b", "", "a\\b", ".geode-trash/x", ".geode-sync/ops/x", ".geode-tmp-1", ".x.icloud"]) {
      expect(() => normalizeRelPath(bad), bad).toThrow();
    }
  });

  it("refuses to write through a symlink that escapes the vault folder", async () => {
    const session = await open();
    await session.scan(undefined, signal());
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-outside-"));
    try {
      fs.symlinkSync(outside, path.join(remoteRoot(), "link"));
      await expect(session.create({ path: "link/x.md", data: enc("x"), operationKey: "op", signal: signal() })).rejects.toThrow(/outside/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports symlinks in the vault folder as an incomplete scan", async () => {
    const session = await open();
    await session.scan(undefined, signal());
    fs.symlinkSync("/tmp", path.join(remoteRoot(), "link"));
    expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", errorCode: ErrorCodes.symlink });
  });

  it("derives distinct, safe folder names from vault ids", () => {
    expect(vaultFolderName("My Vault")).toBe("My Vault");
    const a = vaultFolderName("../evil");
    const b = vaultFolderName(".._evil");
    expect(a).not.toContain("/");
    expect(a).not.toBe(b);
    expect(vaultFolderName("")).toMatch(/^vault-[0-9a-f]{8}$/);
  });
});

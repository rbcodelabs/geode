import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IcloudBridgeError, ICLOUD_CONTAINER_ID } from "../../src/shared/icloud-container";
import { containerDirName, createContainerLocator, icloudDocumentsOverride, NodeIcloudContainer, realDocumentsDir } from "../../src/sync-node/icloud-container";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
const OPTS = { maxHashBytes: 1024 * 1024 };

let documents: string;
let home: string;
beforeEach(() => {
  documents = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-node-docs-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-node-home-"));
});
afterEach(() => {
  fs.rmSync(documents, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function bridge(options: ConstructorParameters<typeof NodeIcloudContainer>[0] = {}) {
  return new NodeIcloudContainer({ locate: createContainerLocator({ env: { GEODE_ICLOUD_BASE: documents } }), platform: "linux", ...options });
}
const seed = (rel: string, content = "x") => {
  fs.mkdirSync(path.dirname(path.join(documents, rel)), { recursive: true });
  fs.writeFileSync(path.join(documents, rel), content);
};

describe("container location", () => {
  it("maps the container id to its on-disk directory (dots become ~)", () => {
    expect(ICLOUD_CONTAINER_ID).toBe("iCloud.com.rbcodelabs.geode");
    expect(containerDirName(ICLOUD_CONTAINER_ID)).toBe("iCloud~com~rbcodelabs~geode");
    expect(realDocumentsDir("/Users/me")).toBe("/Users/me/Library/Mobile Documents/iCloud~com~rbcodelabs~geode/Documents");
  });

  it("GEODE_ICLOUD_BASE replaces the Documents directory; blank means the real container", () => {
    expect(icloudDocumentsOverride({ GEODE_ICLOUD_BASE: documents })).toBe(path.resolve(documents));
    expect(icloudDocumentsOverride({ GEODE_ICLOUD_BASE: "   " })).toBeNull();
    expect(icloudDocumentsOverride({})).toBeNull();
  });

  it("uses the override when it exists, and reports container-not-found when it does not (never creating it)", async () => {
    expect(await createContainerLocator({ env: { GEODE_ICLOUD_BASE: documents } })()).toEqual({ ok: true, documentsDir: path.resolve(documents) });
    const missing = path.join(documents, "nope");
    expect(await createContainerLocator({ env: { GEODE_ICLOUD_BASE: missing } })()).toMatchObject({ ok: false, reason: "container-not-found" });
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("reports an unsupported platform off macOS", async () => {
    expect(await createContainerLocator({ env: {}, platform: "linux", home })()).toMatchObject({ ok: false, reason: "unsupported-platform" });
  });

  it("explains each way the real container can be missing, and creates nothing in the home directory", async () => {
    const locate = createContainerLocator({ env: {}, platform: "darwin", home });
    expect(await locate()).toMatchObject({ ok: false, reason: "icloud-drive-disabled" });
    fs.mkdirSync(path.join(home, "Library", "Mobile Documents"), { recursive: true });
    const noContainer = await locate();
    expect(noContainer).toMatchObject({ ok: false, reason: "container-not-found" });
    expect((noContainer as { message: string }).message).toMatch(/iOS/);
    fs.mkdirSync(path.dirname(realDocumentsDir(home)), { recursive: true });
    expect(await locate()).toMatchObject({ ok: false, reason: "container-not-found" });
    expect(fs.existsSync(realDocumentsDir(home))).toBe(false);
    fs.mkdirSync(realDocumentsDir(home));
    expect(await locate()).toEqual({ ok: true, documentsDir: realDocumentsDir(home) });
  });

  it("availability() carries the reason and message", async () => {
    const b = new NodeIcloudContainer({ locate: createContainerLocator({ env: {}, platform: "darwin", home }) });
    expect(await b.availability()).toMatchObject({ state: "unavailable", reason: "icloud-drive-disabled" });
    expect(await bridge().availability()).toEqual({ state: "available", containerId: ICLOUD_CONTAINER_ID });
  });

  it("every primitive fails with `unavailable` instead of an empty result when the container is gone", async () => {
    const b = new NodeIcloudContainer({ locate: createContainerLocator({ env: {}, platform: "darwin", home }) });
    await expect(b.listRoots()).rejects.toMatchObject({ code: "unavailable" });
    await expect(b.list("R", "")).rejects.toMatchObject({ code: "unavailable" });
    await expect(b.walk("R", "", OPTS)).rejects.toMatchObject({ code: "unavailable" });
    await expect(b.mkdir("R", "")).rejects.toMatchObject({ code: "unavailable" });
    expect(fs.existsSync(path.join(home, "Library"))).toBe(false);
  });
});

describe("path confinement", () => {
  it("rejects hostile root names and relative paths", async () => {
    const b = bridge();
    seed("R/a.md");
    for (const root of ["", ".", "..", "../x", ".hidden", "a/b", "a\\b"]) {
      await expect(b.stat(root, "a.md", OPTS), root).rejects.toMatchObject({ code: "invalid-path" });
    }
    for (const rel of ["../x", "a/../x", "/abs", "a//b", "a\\b", "./a"]) {
      await expect(b.stat("R", rel, OPTS), rel).rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it("refuses a root that is a symlink out of the container, and writes through an escaping symlink", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-node-out-"));
    try {
      fs.symlinkSync(outside, path.join(documents, "Linked"));
      await expect(bridge().stat("Linked", "a.md", OPTS)).rejects.toMatchObject({ code: "invalid-path" });
      seed("R/a.md");
      fs.symlinkSync(outside, path.join(documents, "R", "link"));
      await expect(bridge().beginWrite("R", "link/x.md")).rejects.toMatchObject({ code: "invalid-path" });
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("mkdir creates a root inside an existing Documents but never Documents itself", async () => {
    const b = bridge();
    await b.mkdir("New", "");
    await b.mkdir("New", "a/b");
    expect(fs.statSync(path.join(documents, "New", "a", "b")).isDirectory()).toBe(true);
    fs.rmSync(documents, { recursive: true });
    await expect(b.mkdir("Again", "")).rejects.toMatchObject({ code: "unavailable" });
    expect(fs.existsSync(documents)).toBe(false);
  });
});

describe("list / stat / walk", () => {
  it("reports iCloud stubs under their real name as not-downloaded; a real sibling wins", async () => {
    seed("R/.Evicted.md.icloud", "plist");
    seed("R/Both.md", "real");
    seed("R/.Both.md.icloud", "stale stub");
    seed("R/Dir/b.md");
    const entries = (await bridge().list("R", ""))!;
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("Evicted.md")).toMatchObject({ kind: "file", availability: "not-downloaded" });
    expect(byName.get("Both.md")).toMatchObject({ availability: "current" });
    expect(byName.has(".Evicted.md.icloud")).toBe(false);
    expect(byName.get("Dir")?.kind).toBe("folder");
    expect(await bridge().list("R", "missing")).toBeNull();
    expect(await bridge().list("Nope", "")).toBeNull();
  });

  it("stat gives mtime:size:sha256 for files, `folder` for folders, null for nothing, and sees a stub", async () => {
    seed("R/a.md", "hello");
    seed("R/.Gone.md.icloud", "plist");
    fs.mkdirSync(path.join(documents, "R", "D"));
    const a = (await bridge().stat("R", "a.md", OPTS))!;
    expect(a.revision).toMatch(/^\d+:5:[0-9a-f]{64}$/);
    expect(await bridge().stat("R", "D", OPTS)).toMatchObject({ kind: "folder", revision: "folder" });
    expect(await bridge().stat("R", "missing.md", OPTS)).toBeNull();
    expect(await bridge().stat("R", "Gone.md", OPTS)).toMatchObject({ kind: "file", availability: "not-downloaded", revision: "" });
    expect((await bridge().stat("R", "a.md", { maxHashBytes: 2 }))!.revision).toMatch(/^\d+:5:-$/);
  });

  it("stat refuses a symlink leaf as a precondition failure", async () => {
    seed("R/a.md");
    fs.symlinkSync("/tmp", path.join(documents, "R", "link"));
    await expect(bridge().stat("R", "link", OPTS)).rejects.toMatchObject({ code: "precondition-failed" });
  });

  it("walk is a recursive snapshot honouring skip rules, reporting stubs and symlinks", async () => {
    seed("R/a.md", "a");
    seed("R/Dir/b.md", "b");
    seed("R/Dir/.DS_Store");
    seed("R/._junk");
    seed("R/.geode-tmp-1");
    seed("R/.geode-trash/old/x.md");
    seed("R/.geode-sync/marker.json");
    seed("R/Dir/.Evicted.md.icloud");
    seed("R/..geode-trash.icloud"); // a stub of a skipped top-level name is skipped too
    fs.symlinkSync("/tmp", path.join(documents, "R", "link"));
    const result = await bridge().walk("R", "", { skipNames: [".DS_Store"], skipPrefixes: ["._", ".geode-tmp-"], skipTopLevel: [".geode-trash", ".geode-sync"], maxHashBytes: 1024 }, undefined);
    expect(result.entries.map((e) => `${e.path}:${e.availability}`).sort()).toEqual(["Dir/Evicted.md:not-downloaded", "Dir/b.md:current", "Dir:current", "a.md:current"]);
    expect(result.problems).toEqual([{ code: "symlink", message: "symlink link" }]);
  });

  it("walk lists oversize files with their size but without reading them", async () => {
    seed("R/big.bin", "12345678");
    const result = await bridge().walk("R", "", { maxHashBytes: 4 });
    expect(result.entries[0]).toMatchObject({ path: "big.bin", size: 8 });
    expect(result.entries[0].revision.endsWith(":8:-")).toBe(true);
  });

  it("walk is abortable", async () => {
    seed("R/a.md");
    const controller = new AbortController();
    controller.abort();
    await expect(bridge().walk("R", "", OPTS, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("listRoots returns visible folders only, sorted", async () => {
    seed("B/x");
    seed("A/x");
    seed(".hidden/x");
    seed("file.txt");
    expect(await bridge().listRoots()).toEqual(["A", "B"]);
  });
});

describe("read", () => {
  it("reads whole files and ranges, verifying the listed revision", async () => {
    seed("R/a.md", "0123456789");
    const b = bridge();
    const revision = (await b.stat("R", "a.md", OPTS))!.revision;
    expect(dec((await b.read("R", "a.md", { expectedRevision: revision })).bytes)).toBe("0123456789");
    expect(dec((await b.read("R", "a.md", { offset: 3, length: 4, expectedRevision: revision })).bytes)).toBe("3456");
    seed("R/a.md", "ABCDEFGHIJ"); // same size, new bytes
    await expect(b.read("R", "a.md", { offset: 3, length: 4, expectedRevision: revision })).rejects.toMatchObject({ code: "precondition-failed" });
    await expect(b.read("R", "a.md", { expectedRevision: revision })).rejects.toMatchObject({ code: "precondition-failed" });
  });

  it("enforces maxBytes, and distinguishes missing files", async () => {
    seed("R/a.md", "0123456789");
    await expect(bridge().read("R", "a.md", { maxBytes: 3 })).rejects.toMatchObject({ code: "too-large" });
    await expect(bridge().read("R", "missing.md", {})).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("staged conditional writes", () => {
  const write = async (b: NodeIcloudContainer, rel: string, content: string, precondition: Parameters<NodeIcloudContainer["commitWrite"]>[1]) => {
    const handle = await b.beginWrite("R", rel);
    await b.appendChunk(handle, enc(content.slice(0, 3)));
    await b.appendChunk(handle, enc(content.slice(3)));
    return b.commitWrite(handle, precondition, OPTS);
  };
  const tmpFiles = () => fs.readdirSync(path.join(documents, "R")).filter((n) => n.startsWith(".geode-tmp-"));
  beforeEach(() => fs.mkdirSync(path.join(documents, "R")));

  it("absent: creates parents, never replaces", async () => {
    const b = bridge();
    const stat = await write(b, "Deep/er/a.md", "hello", { absent: true });
    expect(stat).toMatchObject({ kind: "file", size: 5 });
    expect(fs.readFileSync(path.join(documents, "R/Deep/er/a.md"), "utf8")).toBe("hello");
    await expect(write(b, "Deep/er/a.md", "other", { absent: true })).rejects.toMatchObject({ code: "precondition-failed" });
    expect(fs.readFileSync(path.join(documents, "R/Deep/er/a.md"), "utf8")).toBe("hello");
    expect(fs.readdirSync(path.join(documents, "R/Deep/er"))).toEqual(["a.md"]);
  });

  it("revision: replaces only when the bytes on disk still hash to it, leaving no temp file either way", async () => {
    const b = bridge();
    seed("R/a.md", "v1");
    const before = (await b.stat("R", "a.md", OPTS))!;
    const after = await write(b, "a.md", "v2!", { revision: before.revision });
    expect(after.revision).not.toBe(before.revision);
    expect(fs.readFileSync(path.join(documents, "R/a.md"), "utf8")).toBe("v2!");
    seed("R/a.md", "someone else");
    await expect(write(b, "a.md", "mine", { revision: after.revision })).rejects.toMatchObject({ code: "precondition-failed" });
    expect(fs.readFileSync(path.join(documents, "R/a.md"), "utf8")).toBe("someone else");
    fs.rmSync(path.join(documents, "R/a.md"));
    await expect(write(b, "a.md", "mine", { revision: after.revision })).rejects.toMatchObject({ code: "precondition-failed" });
    expect(tmpFiles()).toEqual([]);
  });

  it("any: replaces unconditionally", async () => {
    seed("R/m.json", "old");
    await write(bridge(), "m.json", "new", { any: true });
    expect(fs.readFileSync(path.join(documents, "R/m.json"), "utf8")).toBe("new");
  });

  it("discardWrite and close() remove staged temp files; a handle is single-use", async () => {
    const b = bridge();
    const one = await b.beginWrite("R", "a.md");
    const two = await b.beginWrite("R", "b.md");
    expect(tmpFiles()).toHaveLength(2);
    await b.discardWrite(one);
    expect(tmpFiles()).toHaveLength(1);
    await b.close();
    expect(tmpFiles()).toEqual([]);
    await expect(b.appendChunk(two, enc("x"))).rejects.toBeInstanceOf(IcloudBridgeError);
    const done = await b.beginWrite("R", "c.md");
    await b.commitWrite(done, { any: true }, OPTS);
    await expect(b.commitWrite(done, { any: true }, OPTS)).rejects.toBeInstanceOf(IcloudBridgeError);
  });

  it("an aborted commit publishes nothing and removes the temp file", async () => {
    const b = bridge();
    const handle = await b.beginWrite("R", "a.md");
    await b.appendChunk(handle, enc("x"));
    const controller = new AbortController();
    controller.abort();
    await expect(b.commitWrite(handle, { absent: true }, OPTS, controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(fs.existsSync(path.join(documents, "R/a.md"))).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it("refuses to write the root itself", async () => {
    await expect(bridge().beginWrite("R", "")).rejects.toMatchObject({ code: "invalid-path" });
  });
});

describe("move", () => {
  beforeEach(() => fs.mkdirSync(path.join(documents, "R")));

  it("renames conditionally, creates parents, refuses collisions and stale revisions", async () => {
    const b = bridge();
    seed("R/a.md", "v1");
    seed("R/b.md", "other");
    const a = (await b.stat("R", "a.md", OPTS))!;
    await expect(b.move("R", "a.md", "b.md", { expectedRevision: a.revision, ...OPTS })).rejects.toMatchObject({ code: "precondition-failed" });
    await expect(b.move("R", "a.md", "c.md", { expectedRevision: "1:1:x", ...OPTS })).rejects.toMatchObject({ code: "precondition-failed" });
    const moved = await b.move("R", "a.md", "New/Place/a.md", { expectedRevision: a.revision, ...OPTS });
    expect(moved.revision).toBe(a.revision);
    expect(fs.existsSync(path.join(documents, "R/a.md"))).toBe(false);
    expect(fs.readFileSync(path.join(documents, "R/b.md"), "utf8")).toBe("other");
  });

  it("moves folders and cannot be pointed outside the root", async () => {
    const b = bridge();
    seed("R/D/x.md");
    await b.move("R", "D", "E", { expectedRevision: "folder", ...OPTS });
    expect(fs.existsSync(path.join(documents, "R/E/x.md"))).toBe(true);
    await expect(b.move("R", "E", "../out", { expectedRevision: "folder", ...OPTS })).rejects.toMatchObject({ code: "invalid-path" });
  });
});

describe("downloads", () => {
  it("startDownload runs `brctl download <absolute path>` per item and never fails the caller", async () => {
    seed("R/.Evicted.md.icloud", "plist");
    const runner = vi.fn(async () => ({ code: 1, stderr: "boom" }));
    await bridge({ runner }).startDownload("R", ["Evicted.md"]);
    expect(runner).toHaveBeenCalledWith("brctl", ["download", path.join(documents, "R", "Evicted.md")], expect.anything());
    const throwing = vi.fn(async () => {
      throw new Error("brctl missing");
    });
    await expect(bridge({ runner: throwing }).startDownload("R", ["Evicted.md"])).resolves.toBeUndefined();
  });

  it("waitForDownload reports pending items on timeout and ready ones once the stub is replaced", async () => {
    seed("R/.Slow.md.icloud", "plist");
    seed("R/Fast.md", "here");
    const b = bridge();
    expect(await b.waitForDownload("R", ["Slow.md", "Fast.md"], { timeoutMs: 30, pollMs: 5 })).toEqual({ ready: ["Fast.md"], pending: ["Slow.md"] });
    setTimeout(() => {
      fs.writeFileSync(path.join(documents, "R/Slow.md"), "arrived");
      fs.rmSync(path.join(documents, "R/.Slow.md.icloud"));
    }, 20);
    expect(await b.waitForDownload("R", ["Slow.md"], { timeoutMs: 2000, pollMs: 5 })).toEqual({ ready: ["Slow.md"], pending: [] });
  });

  it("waitForDownload stops on abort", async () => {
    seed("R/.Slow.md.icloud", "plist");
    const controller = new AbortController();
    const pending = bridge().waitForDownload("R", ["Slow.md"], { timeoutMs: 60_000, pollMs: 5 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("real container is never touched by this suite", () => {
  it("the unit suite only ever resolves paths under its own temp directories", () => {
    expect(realDocumentsDir(home).startsWith(home)).toBe(true);
    expect(realDocumentsDir(home).startsWith(os.homedir() + path.sep + "Library")).toBe(false);
  });
});

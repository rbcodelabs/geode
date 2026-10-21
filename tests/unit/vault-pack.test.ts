import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { copyStarterVault } from "../../src/main/starter-vault";
import {
  classifyVaultPath,
  applyVaultPack,
  sweepStaleStaging,
  computeContentSha256,
  createVaultFromPack,
  exportVaultPack,
  inspectVaultPack,
  validateVaultPackManifest,
  VaultPackError,
  type InstallCommunityFn,
} from "../../src/main/vault-pack";
import { crc32, readZip, writeZip, ZipError } from "../../src/main/vault-pack-zip";
import { buildPackZip, pluginManifestJson, sha256 } from "./helpers/vault-pack-fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmp(prefix = "geode-pack-"): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}
const buf = (data: Buffer) => ({ kind: "buffer", data }) as const;

describe("manifest validation", () => {
  const valid = {
    packVersion: 1, id: "acme", name: "Acme", version: "1.0.0", plugins: [], contentSha256: "a".repeat(64),
  };
  it("accepts a minimal manifest and defaults enabled/locked", () => {
    const m = validateVaultPackManifest({ ...valid, plugins: [{ id: "p", source: "github", repo: "o/r" }] });
    expect(m.plugins[0]).toMatchObject({ enabled: true, locked: false });
  });
  it.each([
    ["non-object", []],
    ["wrong packVersion", { ...valid, packVersion: 2 }],
    ["bad id", { ...valid, id: "Has Space" }],
    ["empty name", { ...valid, name: " " }],
    ["bad minGeodeVersion", { ...valid, minGeodeVersion: "latest" }],
    ["missing contentSha256", { ...valid, contentSha256: undefined }],
    ["short contentSha256", { ...valid, contentSha256: "abc" }],
    ["plugins not array", { ...valid, plugins: {} }],
    ["unknown plugin source", { ...valid, plugins: [{ id: "p", source: "url" }] }],
    ["bundled without sha256", { ...valid, plugins: [{ id: "p", source: "bundled" }] }],
    ["github bad repo", { ...valid, plugins: [{ id: "p", source: "github", repo: "../x" }] }],
    ["plugin id traversal", { ...valid, plugins: [{ id: "../p", source: "github", repo: "o/r" }] }],
    ["duplicate plugin", { ...valid, plugins: [{ id: "p", source: "github", repo: "o/r" }, { id: "p", source: "github", repo: "o/s" }] }],
    ["non-boolean enabled", { ...valid, plugins: [{ id: "p", source: "github", repo: "o/r", enabled: "yes" }] }],
  ])("rejects %s", (_label, raw) => {
    expect(() => validateVaultPackManifest(raw)).toThrow(VaultPackError);
  });
});

describe("zip reading safety", () => {
  const expectRejected = (zip: Buffer, message: RegExp, limits?: Parameters<typeof inspectVaultPack>[1]) =>
    expect(inspectVaultPack(buf(zip), limits)).rejects.toThrow(message);

  it("round-trips arbitrary bytes through the zip layer", () => {
    const data = Buffer.from([0, 255, 1, 2, 3, 128]);
    const [entry] = readZip(writeZip([{ name: "a/b.bin", data }]));
    expect(entry.data.equals(data)).toBe(true);
  });

  it.each([
    ["parent traversal", "vault/../../evil.md"],
    ["bare parent segment", "../evil.md"],
    ["absolute path", "/etc/passwd"],
    ["windows drive", "C:/evil.md"],
    ["backslash separator", "vault\\..\\evil.md"],
    ["dot segment", "vault/./a.md"],
    ["empty segment", "vault//a.md"],
  ])("rejects zip-slip entry (%s)", async (_label, name) => {
    await expectRejected(buildPackZip({ extraEntries: [{ name, data: Buffer.from("x") }] }), /Not a valid vault pack/);
  });

  it("rejects symbolic links", async () => {
    const zip = buildPackZip({ extraEntries: [{ name: "vault/link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }] });
    await expectRejected(zip, /symbolic link/);
  });

  it("rejects special files such as devices", async () => {
    const zip = buildPackZip({ extraEntries: [{ name: "vault/dev", data: Buffer.alloc(0), mode: 0o020666 }] });
    await expectRejected(zip, /special file/);
  });

  it("rejects entries outside vault/ and plugins/", async () => {
    await expectRejected(buildPackZip({ extraEntries: [{ name: "extra/readme.txt", data: Buffer.from("x") }] }), /outside vault\/ and plugins\//);
    await expectRejected(buildPackZip({ extraEntries: [{ name: "__MACOSX/._a", data: Buffer.from("x") }] }), /outside vault\/ and plugins\//);
  });

  it("rejects unexpected files inside plugins/", async () => {
    await expectRejected(buildPackZip({ extraEntries: [{ name: "plugins/p/data.json", data: Buffer.from("{}") }] }), /Unexpected file in plugins/);
    await expectRejected(buildPackZip({ extraEntries: [{ name: "plugins/loose.js", data: Buffer.from("x") }] }), /Unexpected file in plugins/);
  });

  it("rejects duplicate entries (case-insensitively)", async () => {
    const zip = writeZip([{ name: "vault/A.md", data: Buffer.from("1") }, { name: "vault/a.md", data: Buffer.from("2") }]);
    expect(() => readZip(zip)).toThrow(/duplicate/);
  });

  it("rejects archives over the total-size limit", async () => {
    const zip = buildPackZip({ files: { "a.md": "x".repeat(600), "b.md": "y".repeat(600) } });
    await expectRejected(zip, /expands to more than/, { limits: { maxTotalBytes: 1000 } });
  });

  it("rejects archives over the file-count limit", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}.md`, "x"]));
    await expectRejected(buildPackZip({ files }), /too many entries/, { limits: { maxEntries: 4 } });
  });

  it("rejects a single oversized entry", async () => {
    await expectRejected(buildPackZip({ files: { "big.md": "x".repeat(2000) } }), /too large/, { limits: { maxEntryBytes: 1000 } });
  });

  it("rejects a suspicious compression ratio (zip bomb)", async () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024); // zeros: deflates ~1000:1
    await expectRejected(buildPackZip({ files: { "bomb.bin": bomb } }), /compression ratio/);
  });

  it("rejects an entry that inflates past its declared size", async () => {
    // Hand-build a deflate entry whose central-directory size lies (claims 10, really 1000).
    const real = Buffer.alloc(1000, 0x61);
    const zip = writeZip([{ name: "vault/lie.md", data: real }]);
    patchSizes(zip, 10);
    expect(() => readZip(zip)).toThrow(/declared size|Corrupt/);
  });

  it("rejects corrupted data via the CRC", () => {
    const zip = writeZip([{ name: "vault/a.md", data: Buffer.from("hello world") }]);
    const at = zip.indexOf("hello world");
    zip[at] ^= 0xff;
    expect(() => readZip(zip)).toThrow(/Checksum/);
  });

  it("rejects encrypted entries, zip64 markers and non-zip input", () => {
    const zip = writeZip([{ name: "vault/a.md", data: Buffer.from("x") }]);
    const enc = Buffer.from(zip);
    const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(() => readZip(enc)).toThrow(/Encrypted/);
    expect(() => readZip(Buffer.from("not a zip at all, definitely"))).toThrow(ZipError);
    expect(() => readZip(Buffer.alloc(100))).toThrow(/Not a zip/);
  });

  it("rejects a pack with no manifest, or a manifest that is not JSON", async () => {
    await expectRejected(buildPackZip({ omitManifest: true }), /vault-pack\.json is missing/);
    await expectRejected(writeZip([{ name: "vault-pack.json", data: Buffer.from("{nope") }]), /not valid JSON/);
  });

  it("keeps crc32 compatible with deflate-based tools", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(deflateRawSync(Buffer.from("x")).length).toBeGreaterThan(0);
  });
});

/** Rewrites the uncompressed-size field of the first central-directory entry. */
function patchSizes(zip: Buffer, size: number): void {
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(size, cd + 24);
}

describe("applyVaultPack", () => {
  it("writes notes, honors the .geode allowlist, and never extracts runtime state", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({
      files: {
        "Welcome.md": "# Hi",
        "Notes/Deep/note.md": "deep",
        ".geode/app.json": '{"theme":"light"}',
        ".geode/hotkeys.json": "{}",
        ".geode/themes/Ivory/theme.css": "body{}",
        ".geode/snippets/a.css": "a{}",
        ".geode/plugins.json": '["x"]',
        ".geode/workspace.json": "{}",
        ".geode/community.json": "{}",
        ".geode/metadata-cache/index.json": "{}",
        ".geode/plugins/evil/main.js": "boom",
      },
    });
    const result = await applyVaultPack(buf(zip), dest);
    expect(await listFiles(dest)).toEqual([
      ".geode/app.json",
      ".geode/hotkeys.json",
      ".geode/plugins.json",
      ".geode/snippets/a.css",
      ".geode/themes/Ivory/theme.css",
      "Notes/Deep/note.md",
      "Welcome.md",
    ]);
    expect(result.summary.skippedCount).toBe(4);
    expect(await fs.readFile(path.join(dest, "Welcome.md"), "utf8")).toBe("# Hi");
  });

  it("installs bundled plugins and enables them in .geode/plugins.json", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({ bundled: [{ id: "acme-tool" }, { id: "acme-off", enabled: false }] });
    const result = await applyVaultPack(buf(zip), dest);
    expect(await exists(path.join(dest, ".geode/plugins/acme-tool/main.js"))).toBe(true);
    expect(await exists(path.join(dest, ".geode/plugins/acme-off/main.js"))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dest, ".geode/plugins.json"), "utf8"))).toEqual(["acme-tool"]);
    expect(result.enabledPluginIds).toEqual(["acme-tool"]);
  });

  it("rejects a bundled plugin whose main.js hash does not match the manifest", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({ bundled: [{ id: "acme-tool", recordedSha256: sha256("something else") }] });
    await expect(applyVaultPack(buf(zip), dest)).rejects.toThrow(/sha256 does not match/);
    expect(await exists(dest)).toBe(false);
  });

  it("rejects a pack whose contents were modified after the manifest was written", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({ manifest: { contentSha256: "0".repeat(64) } });
    await expect(applyVaultPack(buf(zip), dest)).rejects.toThrow(/contentSha256/);
    expect(await exists(dest)).toBe(false);
  });

  it("rejects an undeclared plugins/<id>/ directory", async () => {
    const dest = path.join(await tmp(), "vault");
    // Build with the plugin, then drop it from the manifest while keeping its files.
    const base = buildPackZip({ bundled: [{ id: "sneaky" }] });
    const entries = readZip(base).map((e) => ({ name: e.name, data: e.data }));
    const m = JSON.parse(entries.find((e) => e.name === "vault-pack.json")!.data.toString());
    m.plugins = [];
    entries.find((e) => e.name === "vault-pack.json")!.data = Buffer.from(JSON.stringify(m));
    await expect(applyVaultPack(buf(writeZip(entries)), dest)).rejects.toThrow(/not declared/);
  });

  it("rejects a bundled plugin whose manifest id does not match its folder", async () => {
    const dest = path.join(await tmp(), "vault");
    const base = readZip(buildPackZip({ bundled: [{ id: "acme-tool" }] })).map((e) => ({ name: e.name, data: e.data }));
    const pm = base.find((e) => e.name === "plugins/acme-tool/manifest.json")!;
    pm.data = Buffer.from(pluginManifestJson("different-id"));
    const files = new Map<string, Buffer>([["Welcome.md", Buffer.from("# Hello\n")]]);
    const plug = new Map<string, Map<string, Buffer>>([["acme-tool", new Map([
      ["manifest.json", pm.data], ["main.js", base.find((e) => e.name === "plugins/acme-tool/main.js")!.data],
    ])]]);
    const forged = JSON.parse(base.find((e) => e.name === "vault-pack.json")!.data.toString());
    for (const plugin of forged.plugins) delete plugin.files; // a legacy pack with only the main.js hash
    base.find((e) => e.name === "vault-pack.json")!.data = Buffer.from(JSON.stringify({
      ...forged,
      contentSha256: computeContentSha256(files, plug),
    }));
    await expect(applyVaultPack(buf(writeZip(base)), dest)).rejects.toThrow(/does not match its plugin folder/);
  });

  it("installs policy-blocked plugins disabled, never enabled (ADR 0002)", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({
      files: { ".geode/plugins.json": '["acme-blocked","acme-ok"]', "a.md": "a" },
      bundled: [{ id: "acme-blocked" }, { id: "acme-ok" }],
    });
    const policy = { policyVersion: 1 as const, plugins: { mode: "blocklist" as const, ids: ["acme-blocked"] } };
    const result = await applyVaultPack(buf(zip), dest, { policy });
    expect(await exists(path.join(dest, ".geode/plugins/acme-blocked/main.js"))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dest, ".geode/plugins.json"), "utf8"))).toEqual(["acme-ok"]);
    expect(result.blockedPluginIds).toEqual(["acme-blocked"]);
    const summary = await inspectVaultPack(buf(zip), { policy });
    expect(summary.plugins.find((p) => p.id === "acme-blocked")?.blocked).toBe(true);
  });

  it("enforces an allowlist policy too", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({ bundled: [{ id: "acme-a" }, { id: "acme-b" }] });
    const policy = { policyVersion: 1 as const, plugins: { mode: "allowlist" as const, ids: ["acme-a"] } };
    const result = await applyVaultPack(buf(zip), dest, { policy });
    expect(result.enabledPluginIds).toEqual(["acme-a"]);
    expect(result.blockedPluginIds).toEqual(["acme-b"]);
  });

  it("refuses packs that need a newer Geode", async () => {
    const zip = buildPackZip({ manifest: { minGeodeVersion: "9.0.0" } });
    await expect(inspectVaultPack(buf(zip), { geodeVersion: "0.30.8" })).rejects.toThrow(/9\.0\.0 or newer/);
    await expect(inspectVaultPack(buf(zip), { geodeVersion: "9.0.0" })).resolves.toMatchObject({ name: "Acme Onboarding" });
  });

  describe("GitHub plugins go through installCommunity", () => {
    it("installs into the staged vault and enables the plugin", async () => {
      const dest = path.join(await tmp(), "vault");
      const calls: Array<[string, string]> = [];
      const install: InstallCommunityFn = async (root, spec) => {
        calls.push([root, spec]);
        await fs.mkdir(path.join(root, ".geode/plugins/gh-plugin"), { recursive: true });
        await fs.writeFile(path.join(root, ".geode/plugins/gh-plugin/main.js"), "x");
        return { id: "gh-plugin" };
      };
      const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
      const result = await applyVaultPack(buf(zip), dest, { installCommunity: install });
      expect(calls.map(([, s]) => s)).toEqual(["acme/gh-plugin"]);
      expect(await exists(path.join(dest, ".geode/plugins/gh-plugin/main.js"))).toBe(true);
      expect(result.enabledPluginIds).toEqual(["gh-plugin"]);
    });

    it("rolls back everything when an install fails (default 'fail' mode)", async () => {
      const parent = await tmp();
      const dest = path.join(parent, "vault");
      const install: InstallCommunityFn = async () => { throw new Error("offline"); };
      const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
      await expect(applyVaultPack(buf(zip), dest, { installCommunity: install })).rejects.toThrow(/acme\/gh-plugin.*offline/);
      expect(await exists(dest)).toBe(false);
      expect(await fs.readdir(parent)).toEqual([]); // no staging directory left behind
    });

    it("rejects an install that resolves to a different plugin id", async () => {
      const dest = path.join(await tmp(), "vault");
      const install: InstallCommunityFn = async () => ({ id: "other" });
      const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
      await expect(applyVaultPack(buf(zip), dest, { installCommunity: install })).rejects.toThrow(/does not match manifest id/);
      expect(await exists(dest)).toBe(false);
    });

    it("'skip' mode keeps going and leaves the failed plugin out", async () => {
      const dest = path.join(await tmp(), "vault");
      const install: InstallCommunityFn = async () => { throw new Error("offline"); };
      const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
      const result = await applyVaultPack(buf(zip), dest, { installCommunity: install, githubFailure: "skip" });
      expect(result.githubFailures).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(dest, ".geode/plugins.json"), "utf8"))).toEqual([]);
    });
  });

  describe("atomicity and seed-once", () => {
    it("leaves no partial vault when a late failure occurs after files were staged", async () => {
      const parent = await tmp();
      const dest = path.join(parent, "vault");
      const zip = buildPackZip({ files: { "a.md": "a", "b/c.md": "c" }, github: [{ id: "gh", repo: "o/r" }] });
      const install: InstallCommunityFn = async () => { throw new Error("boom"); };
      await expect(applyVaultPack(buf(zip), dest, { installCommunity: install })).rejects.toThrow();
      expect(await fs.readdir(parent)).toEqual([]);
    });

    it("leaves an existing empty destination empty on failure", async () => {
      const dest = await tmp();
      const install: InstallCommunityFn = async () => { throw new Error("boom"); };
      const zip = buildPackZip({ github: [{ id: "gh", repo: "o/r" }] });
      await expect(applyVaultPack(buf(zip), dest, { installCommunity: install })).rejects.toThrow();
      expect(await fs.readdir(dest)).toEqual([]);
    });

    it("applies into an existing empty folder", async () => {
      const dest = await tmp();
      await applyVaultPack(buf(buildPackZip()), dest);
      expect(await listFiles(dest)).toEqual(["Welcome.md"]);
      expect(await fs.readdir(dest)).toEqual(["Welcome.md"]); // staging dir cleaned up
    });

    it("refuses a non-empty destination and leaves it untouched", async () => {
      const dest = await tmp();
      await fs.writeFile(path.join(dest, "mine.md"), "mine");
      await expect(applyVaultPack(buf(buildPackZip()), dest)).rejects.toThrow(/empty or new folder/);
      expect(await fs.readdir(dest)).toEqual(["mine.md"]);
    });

    it("never overwrites existing files when merging into a non-empty vault is allowed", async () => {
      const dest = await tmp();
      await fs.writeFile(path.join(dest, "Welcome.md"), "mine");
      await expect(applyVaultPack(buf(buildPackZip()), dest, { requireEmptyDest: false })).rejects.toThrow(/already exists/);
      expect(await fs.readFile(path.join(dest, "Welcome.md"), "utf8")).toBe("mine");
    });

    it("refuses a missing parent folder", async () => {
      const dest = path.join(await tmp(), "nope", "vault");
      await expect(applyVaultPack(buf(buildPackZip()), dest)).rejects.toThrow(/is not a folder/);
    });
  });
});

describe("inspectVaultPack", () => {
  it("returns the consent summary and writes nothing", async () => {
    const parent = await tmp();
    const file = path.join(parent, "acme.vault");
    await fs.writeFile(file, buildPackZip({ bundled: [{ id: "acme-tool", locked: true }], github: [{ id: "gh", repo: "o/r" }] }));
    const before = await fs.readdir(parent);
    const summary = await inspectVaultPack({ kind: "file", path: file });
    expect(await fs.readdir(parent)).toEqual(before);
    expect(summary).toMatchObject({ id: "acme-onboarding", name: "Acme Onboarding", version: "2.0.0", fileCount: 3 });
    const bundled = summary.plugins.find((p) => p.id === "acme-tool")!;
    expect(bundled).toMatchObject({ source: "bundled", locked: true, name: "Plugin acme-tool", version: "1.2.3" });
    expect(bundled.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.plugins.find((p) => p.id === "gh")).toMatchObject({ source: "github", repo: "o/r" });
  });

  it("runs the same validation as apply", async () => {
    await expect(inspectVaultPack(buf(buildPackZip({ bundled: [{ id: "p", recordedSha256: "f".repeat(64) }] })))).rejects.toThrow(/sha256/);
  });

  it("reports a missing file", async () => {
    await expect(inspectVaultPack({ kind: "file", path: "/nonexistent/x.vault" })).rejects.toThrow(/not found/);
  });
});

describe("createVaultFromPack", () => {
  it("creates <parent>/<name> and nothing on failure", async () => {
    const parent = await tmp();
    const ok = await createVaultFromPack(buf(buildPackZip()), parent, "  New Vault ");
    expect(ok.path).toBe(path.join(parent, "New Vault"));
    expect(await exists(path.join(ok.path, "Welcome.md"))).toBe(true);
    await expect(createVaultFromPack(buf(buildPackZip()), parent, "New Vault")).rejects.toThrow(/already exists/);
    await expect(createVaultFromPack(buf(buildPackZip()), parent, "a/b")).rejects.toThrow(/can't contain/);
    await expect(createVaultFromPack(buf(buildPackZip()), "relative", "x")).rejects.toThrow(/Choose a location/);
    await expect(createVaultFromPack(buf(buildPackZip({ manifest: { contentSha256: "0".repeat(64) } })), parent, "Bad")).rejects.toThrow();
    expect(await exists(path.join(parent, "Bad"))).toBe(false);
  });
});

describe("exportVaultPack", () => {
  it("round-trips a vault through a pack, leaving runtime state out", async () => {
    const src = await tmp("geode-export-src-");
    const out = path.join(await tmp(), "exported.vault");
    await fs.mkdir(path.join(src, "Notes"), { recursive: true });
    await fs.writeFile(path.join(src, "Notes/one.md"), "one");
    await fs.writeFile(path.join(src, "image.bin"), Buffer.from([0, 255, 7]));
    await fs.mkdir(path.join(src, ".git"), { recursive: true });
    await fs.writeFile(path.join(src, ".git/config"), "x");
    await fs.mkdir(path.join(src, ".geode/plugins/acme-tool"), { recursive: true });
    await fs.writeFile(path.join(src, ".geode/app.json"), '{"theme":"dark"}');
    await fs.writeFile(path.join(src, ".geode/workspace.json"), "{}");
    await fs.writeFile(path.join(src, ".geode/plugins.json"), '["acme-tool"]');
    await fs.writeFile(path.join(src, ".geode/plugins/acme-tool/manifest.json"), pluginManifestJson("acme-tool"));
    await fs.writeFile(path.join(src, ".geode/plugins/acme-tool/main.js"), "module.exports = {};");
    await fs.writeFile(path.join(src, ".geode/plugins/acme-tool/data.json"), '{"secret":1}');

    const summary = await exportVaultPack(src, out, { name: "Exported" });
    expect(summary.plugins).toMatchObject([{ id: "acme-tool", source: "bundled", enabled: true }]);

    const dest = path.join(await tmp(), "imported");
    await applyVaultPack({ kind: "file", path: out }, dest);
    expect(await listFiles(dest)).toEqual([
      ".geode/app.json",
      ".geode/plugins.json",
      ".geode/plugins/acme-tool/main.js",
      ".geode/plugins/acme-tool/manifest.json",
      "Notes/one.md",
      "image.bin",
    ]);
    expect(JSON.parse(await fs.readFile(path.join(dest, ".geode/plugins.json"), "utf8"))).toEqual(["acme-tool"]);
    expect((await fs.readFile(path.join(dest, "image.bin"))).equals(Buffer.from([0, 255, 7]))).toBe(true);
  });
});


describe("case-insensitive and Unicode path hardening", () => {
  it("rejects the whole pack for .GEODE / .Geode variants anywhere in a path", async () => {
    for (const files of [
      { ".GEODE/plugins/evil/main.js": "x", ".GEODE/plugins.json": '["evil"]' },
      { ".Geode/app.json": "{}" },
      { "Notes/.geode/app.json": "{}" },
      { "Notes/.GeOdE/x.md": "x" },
    ]) {
      await expect(inspectVaultPack(buf(buildPackZip({ files })))).rejects.toThrow(/reserved folder name/);
    }
  });

  it("classifies exact .geode paths and normalized lookalikes", () => {
    expect(classifyVaultPath(".geode/app.json")).toBe("allow");
    expect(classifyVaultPath(".geode/workspace.json")).toBe("skip");
    expect(classifyVaultPath(".geode/Themes/x.css")).toBe("skip");
    expect(classifyVaultPath(".GEODE/app.json")).toBe("reject");
    expect(classifyVaultPath("a/.geode")).toBe("reject");
    expect(classifyVaultPath("notes/geode.md")).toBe("allow");
  });

  it.each([
    ["trailing space on .geode", "vault/.geode /plugins.json"],
    ["trailing dot", "vault/a./b.md"],
    ["trailing space", "vault/note .md "],
    ["colon (alternate data stream)", "vault/a.md:stream"],
    ["Windows reserved CON", "vault/CON"],
    ["Windows reserved nul with extension", "vault/nul.txt"],
    ["Windows reserved COM1", "vault/com1.md"],
    ["Windows reserved LPT9", "vault/LPT9"],
    ["control character", "vault/a\u0007b.md"],
  ])("rejects %s", async (_label, name) => {
    await expect(inspectVaultPack(buf(buildPackZip({ extraEntries: [{ name, data: Buffer.from("x") }] })))).rejects.toThrow(/Not a valid vault pack/);
  });

  it("rejects NFC/NFD-equivalent and case-variant duplicates", () => {
    const nfc = "vault/caf\u00e9.md";
    const nfd = "vault/cafe\u0301.md";
    expect(() => readZip(writeZip([{ name: nfc, data: Buffer.from("1") }, { name: nfd, data: Buffer.from("2") }]))).toThrow(/duplicate/);
    expect(() => readZip(writeZip([{ name: "vault/Note.md", data: Buffer.from("1") }, { name: "vault/NOTE.MD", data: Buffer.from("2") }]))).toThrow(/duplicate/);
    expect(() => readZip(writeZip([{ name: "vault/Dir/", data: Buffer.alloc(0) }, { name: "vault/dir", data: Buffer.from("2") }]))).toThrow(/duplicate/);
  });

  it("ignores plugins.json ids the manifest does not declare", async () => {
    const dest = path.join(await tmp(), "vault");
    const zip = buildPackZip({ files: { ".geode/plugins.json": '["evil","acme-tool"]' }, bundled: [{ id: "acme-tool" }] });
    const result = await applyVaultPack(buf(zip), dest);
    expect(result.enabledPluginIds).toEqual(["acme-tool"]);
    expect(JSON.parse(await fs.readFile(path.join(dest, ".geode/plugins.json"), "utf8"))).toEqual(["acme-tool"]);
  });
});

describe("bundled plugin file hashes and first-party ids", () => {
  it("verifies manifest.json and styles.css hashes too", async () => {
    const zip = buildPackZip({ bundled: [{ id: "acme-tool", styles: "b{}" }] });
    await expect(inspectVaultPack(buf(zip))).resolves.toBeTruthy();
    const badStyles = buildPackZip({ bundled: [{ id: "acme-tool", styles: "b{}", recordedFileHashes: { "styles.css": sha256("other") } }] });
    await expect(inspectVaultPack(buf(badStyles))).rejects.toThrow(/styles\.css sha256 does not match/);
    const badManifest = buildPackZip({ bundled: [{ id: "acme-tool", recordedFileHashes: { "manifest.json": sha256("other") } }] });
    await expect(inspectVaultPack(buf(badManifest))).rejects.toThrow(/manifest\.json sha256 does not match/);
  });

  it("requires a hash for every shipped file once a files map is present, and stays compatible without one", async () => {
    const missing = buildPackZip({ bundled: [{ id: "acme-tool", styles: "b{}", recordedFileHashes: { "styles.css": undefined as unknown as string } }] });
    await expect(inspectVaultPack(buf(missing))).rejects.toThrow(/invalid "files" entry|no hash/);
    const legacy = buildPackZip({ bundled: [{ id: "acme-tool", styles: "b{}", omitFileHashes: true }] });
    await expect(inspectVaultPack(buf(legacy))).resolves.toBeTruthy();
  });

  it("reports per-file hashes and flags first-party plugin ids", async () => {
    const summary = await inspectVaultPack(buf(buildPackZip({ bundled: [{ id: "claude-threads" }, { id: "acme-tool" }] })));
    const ct = summary.plugins.find((p) => p.id === "claude-threads")!;
    expect(ct.firstParty).toBe(true);
    expect(ct.fileHashes?.["main.js"]).toBe(ct.sha256);
    expect(summary.plugins.find((p) => p.id === "acme-tool")!.firstParty).toBe(false);
  });
});

describe("limits", () => {
  it("applies the ratio check to small entries once the archive expands past the threshold", async () => {
    const files = { "z.bin": Buffer.alloc(10_000) }; // ~700:1 but far below the 1 MiB floor
    const zip = buildPackZip({ files });
    await expect(inspectVaultPack(buf(zip))).resolves.toBeTruthy();
    await expect(inspectVaultPack(buf(zip), { limits: { ratioAlwaysAboveTotalBytes: 5_000 } })).rejects.toThrow(/compression ratio/);
  });
});

describe("seed-once top-level check", () => {
  it("refuses a destination that already has a stale-looking staging name or any entry", async () => {
    const dest = await tmp();
    await fs.mkdir(path.join(dest, ".geode-pack-old"));
    await expect(applyVaultPack(buf(buildPackZip()), dest)).rejects.toThrow(/empty or new folder/);
  });

  it("detects a case-variant top-level collision when merging is allowed", async () => {
    const dest = await tmp();
    await fs.writeFile(path.join(dest, "WELCOME.md"), "mine");
    await expect(applyVaultPack(buf(buildPackZip()), dest, { requireEmptyDest: false })).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(dest, "WELCOME.md"), "utf8")).toBe("mine");
  });
});

describe("sweepStaleStaging", () => {
  it("removes only .geode-pack-* directories older than the cutoff", async () => {
    const parent = await tmp();
    await fs.mkdir(path.join(parent, ".geode-pack-old"));
    await fs.mkdir(path.join(parent, ".geode-pack-new"));
    await fs.mkdir(path.join(parent, "My Vault"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(path.join(parent, ".geode-pack-old"), old, old);
    expect(await sweepStaleStaging(parent)).toBe(1);
    expect((await fs.readdir(parent)).sort()).toEqual([".geode-pack-new", "My Vault"]);
    expect(await sweepStaleStaging(path.join(parent, "missing"))).toBe(0);
  });
});

describe("copyStarterVault parity", () => {
  it("copies the shipped starter vault exactly as before: everything except .geode, plus only .geode/app.json", async () => {
    const src = path.join(__dirname, "..", "..", "resources", "starter-vault");
    const dest = path.join(await tmp(), "starter");
    await copyStarterVault(dest, path.join(__dirname, "..", "..", "resources"));
    const expected = (await listFiles(src)).filter((f) => !f.startsWith(".geode/") || f === ".geode/app.json");
    expect(await listFiles(dest)).toEqual(expected);
    expect(expected).toContain(".geode/app.json");
    for (const rel of expected) {
      expect((await fs.readFile(path.join(dest, rel))).equals(await fs.readFile(path.join(src, rel)))).toBe(true);
    }
  });

  it("only honors .geode/app.json from the starter folder and preserves empty directories", async () => {
    const resources = await tmp();
    const root = path.join(resources, "starter-vault");
    await fs.mkdir(path.join(root, "Empty", "Nested"), { recursive: true });
    await fs.mkdir(path.join(root, ".geode", "themes", "T"), { recursive: true });
    await fs.writeFile(path.join(root, ".geode", "themes", "T", "theme.css"), "x");
    await fs.writeFile(path.join(root, ".geode", "hotkeys.json"), "{}");
    await fs.writeFile(path.join(root, ".geode", "app.json"), "{}");
    await fs.writeFile(path.join(root, "a.md"), "a");
    const dest = path.join(await tmp(), "starter");
    await copyStarterVault(dest, resources);
    expect(await listFiles(dest)).toEqual([".geode/app.json", "a.md"]);
    expect((await fs.stat(path.join(dest, "Empty", "Nested"))).isDirectory()).toBe(true);
  });
});

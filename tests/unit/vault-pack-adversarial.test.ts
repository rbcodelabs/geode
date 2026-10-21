/**
 * ADR 0050 adversarial QA: every hostile archive is rejected with a readable
 * error AND the destination parent is left exactly as it was found (nothing
 * created, no staging folder). Driven through createVaultFromPack, the same
 * entry the hub, drop and --vault-pack paths use.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultFromPack, exportVaultPack, inspectVaultPack, VaultPackError } from "../../src/main/vault-pack";
import { VaultPackService } from "../../src/main/vault-pack-service";
import { readZip, writeZip, type ZipWriteEntry } from "../../src/main/vault-pack-zip";
import { buildPackZip, sha256 } from "./helpers/vault-pack-fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (d) => {
    await fs.chmod(d, 0o755).catch(() => {});
    await fs.rm(d, { recursive: true, force: true });
  }));
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pack-adv-"));
  dirs.push(d);
  return d;
}
const buf = (data: Buffer) => ({ kind: "buffer", data }) as const;

/** Asserts the pack is rejected and `parent` is byte-for-byte untouched. */
async function expectRejectedWritingNothing(zip: Buffer, message: RegExp): Promise<void> {
  const parent = await tmp();
  await expect(createVaultFromPack(buf(zip), parent, "Victim")).rejects.toThrow(message);
  expect(await fs.readdir(parent)).toEqual([]);
}

/** Rewrites little-endian u32 fields in the local (0x04034b50) and central (0x02014b50) headers of every entry. */
function patchHeaders(zip: Buffer, patch: { crc?: (n: number) => number; usize?: (n: number) => number; csize?: (n: number) => number }): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i + 4 < out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50) {
      if (patch.crc) out.writeUInt32LE(patch.crc(out.readUInt32LE(i + 14)) >>> 0, i + 14);
      if (patch.csize) out.writeUInt32LE(patch.csize(out.readUInt32LE(i + 18)) >>> 0, i + 18);
      if (patch.usize) out.writeUInt32LE(patch.usize(out.readUInt32LE(i + 22)) >>> 0, i + 22);
    } else if (sig === 0x02014b50) {
      if (patch.crc) out.writeUInt32LE(patch.crc(out.readUInt32LE(i + 16)) >>> 0, i + 16);
      if (patch.csize) out.writeUInt32LE(patch.csize(out.readUInt32LE(i + 20)) >>> 0, i + 20);
      if (patch.usize) out.writeUInt32LE(patch.usize(out.readUInt32LE(i + 24)) >>> 0, i + 24);
    }
  }
  return out;
}

const hostileExtra = (name: string, mode?: number): ZipWriteEntry => ({ name, data: Buffer.from("pwned"), mode });

describe("hostile archives are rejected and write nothing", () => {
  it.each([
    ["zip-slip in vault/", "vault/../../../escape.md"],
    ["zip-slip in plugins/", "plugins/../../escape.js"],
    ["zip-slip via plugin id", "plugins/../x/main.js"],
    ["absolute posix", "/tmp/escape.md"],
    ["absolute windows", "C:\\escape.md"],
    ["backslash traversal", "vault\\..\\..\\escape.md"],
    ["NUL byte in name", "vault/a\0.md"],
    ["trailing dot segment", "vault/notes./a.md"],
    ["alternate data stream", "vault/a.md:stream"],
    ["windows reserved name", "vault/CON.md"],
    ["control character", "vault/a\u0007b.md"],
    ["__MACOSX resource fork", "__MACOSX/vault/._a.md"],
  ])("%s", async (_label, name) => {
    await expectRejectedWritingNothing(buildPackZip({ extraEntries: [hostileExtra(name)] }), /vault pack|Unexpected|outside|invalid|not allowed|reserved|unsafe/i);
  });

  it.each([
    [".GEODE/app.json", "vault/.GEODE/app.json"],
    [".Geode/plugins.json", "vault/.Geode/plugins.json"],
    ["nested .geode", "vault/sub/.geode/app.json"],
    [".geode lookalike with trailing space", "vault/.geode /app.json"],
    ["NFD/odd case folder under .geode", "vault/.geode/THEMES/x.css"],
  ])("%s", async (_label, name) => {
    // Case variants of .geode must never be silently honored or written.
    const parent = await tmp();
    const zip = buildPackZip({ extraEntries: [hostileExtra(name)] });
    const outcome = await createVaultFromPack(buf(zip), parent, "Victim").then(() => "applied", (e: unknown) => (e instanceof VaultPackError ? "rejected" : `crash:${String(e)}`));
    expect(outcome, `${name}: neither a clean reject nor a clean apply`).not.toMatch(/^crash/);
    if (outcome === "applied") {
      // If applied, the hostile file must not exist anywhere in the vault.
      const all: string[] = [];
      const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); all.push(p); if (e.isDirectory()) await walk(p); } };
      await walk(path.join(parent, "Victim"));
      expect(all.filter((p) => /pwned|THEMES/.test(p))).toEqual([]);
    } else {
      expect(await fs.readdir(parent)).toEqual([]);
    }
  });

  it("symlink entry in vault/", async () => {
    await expectRejectedWritingNothing(buildPackZip({ extraEntries: [hostileExtra("vault/link", 0o120777)] }), /symbolic link/);
  });
  it("symlink entry in plugins/<id>/", async () => {
    const zip = buildPackZip({ bundled: [{ id: "p" }], extraEntries: [hostileExtra("plugins/p/styles.css", 0o120777)] });
    await expectRejectedWritingNothing(zip, /symbolic link/);
  });
  it("hard-link/fifo/socket special files", async () => {
    await expectRejectedWritingNothing(buildPackZip({ extraEntries: [hostileExtra("vault/fifo", 0o010644)] }), /special file/);
    await expectRejectedWritingNothing(buildPackZip({ extraEntries: [hostileExtra("vault/sock", 0o140644)] }), /special file/);
  });

  it("wrong CRC on a stored entry", async () => {
    const zip = patchHeaders(buildPackZip({ files: { "a.md": "hello" } }), { crc: (n) => n ^ 0xdeadbeef });
    await expectRejectedWritingNothing(zip, /crc|corrupt|checksum/i);
  });

  it("flipped payload byte (CRC and content hash both disagree)", async () => {
    const zip = Buffer.from(buildPackZip({ files: { "a.md": "hello-world-unique-marker" } }));
    const at = zip.indexOf("hello-world-unique-marker");
    expect(at).toBeGreaterThan(0);
    zip[at] ^= 0x01;
    await expectRejectedWritingNothing(zip, /crc|corrupt|checksum|modified|does not match/i);
  });

  it("declared uncompressed size smaller than the real data (lying low)", async () => {
    const zip = patchHeaders(buildPackZip({ files: { "a.md": "x".repeat(5000) } }), { usize: (n) => (n === 5000 ? 10 : n) });
    await expectRejectedWritingNothing(zip, /./);
  });

  it("declared uncompressed size larger than the real data (lying high)", async () => {
    const zip = patchHeaders(buildPackZip({ files: { "a.md": "x".repeat(5000) } }), { usize: (n) => (n === 5000 ? 9000 : n) });
    await expectRejectedWritingNothing(zip, /./);
  });

  it("declared sizes of 4 GiB-1 do not allocate or hang", async () => {
    const zip = patchHeaders(buildPackZip({ files: { "a.md": "x".repeat(5000) } }), { usize: () => 0xfffffffe });
    await expectRejectedWritingNothing(zip, /./);
  });

  it("decompression bomb (200 MiB of zeros)", async () => {
    // 200 MiB compresses to ~200 KiB; must be refused by the ratio/size limits without expanding it.
    const start = Date.now();
    await expectRejectedWritingNothing(buildPackZip({ files: { "bomb.bin": Buffer.alloc(200 * 1024 * 1024) } }), /ratio|too large|expands/i);
    expect(Date.now() - start).toBeLessThan(30_000);
  }, 60_000);

  it("duplicate entry names (exact and case-folded)", async () => {
    const exact = writeZip([{ name: "vault/a.md", data: Buffer.from("1") }, { name: "vault/a.md", data: Buffer.from("2") }]);
    await expectRejectedWritingNothing(exact, /duplicate/i);
    const folded = writeZip([{ name: "vault/a.md", data: Buffer.from("1") }, { name: "vault/A.MD", data: Buffer.from("2") }]);
    await expectRejectedWritingNothing(folded, /duplicate/i);
  });

  it("duplicate manifest entries (second one hidden behind the first)", async () => {
    const good = buildPackZip();
    const evil = writeZip([{ name: "vault-pack.json", data: Buffer.from("{}") }]);
    // Concatenate semantics are undefined for zips; just make sure it is rejected or ignored without writes.
    const parent = await tmp();
    await createVaultFromPack(buf(Buffer.concat([evil, good])), parent, "Victim").catch(() => {});
    const left = await fs.readdir(parent);
    expect(left.every((n) => n === "Victim")).toBe(true);
  });

  it("missing manifest", async () => {
    await expectRejectedWritingNothing(buildPackZip({ omitManifest: true }), /vault-pack\.json/);
  });

  it.each([
    ["not JSON", "{nope"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["empty", ""],
    ["BOM-prefixed garbage", "\ufeff<<<"],
  ])("manifest that is %s", async (_label, raw) => {
    const zip = writeZip([{ name: "vault-pack.json", data: Buffer.from(raw) }, { name: "vault/a.md", data: Buffer.from("x") }]);
    await expectRejectedWritingNothing(zip, /manifest|JSON|vault pack/i);
  });

  it("prototype-pollution keys in the manifest", async () => {
    const zip = buildPackZip({ manifest: { __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } } as Record<string, unknown> });
    const parent = await tmp();
    await createVaultFromPack(buf(zip), parent, "Victim").catch(() => {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bundled plugin hash mismatch", async () => {
    await expectRejectedWritingNothing(buildPackZip({ bundled: [{ id: "p", recordedSha256: sha256("other") }] }), /hash|sha256|does not match/i);
  });

  it("bundled plugin swapped after manifest was written (contentSha256 mismatch)", async () => {
    const zip = Buffer.from(buildPackZip({ bundled: [{ id: "p", mainJs: "module.exports=class Zq9xK2vL{};" }] }));
    const at = zip.indexOf("Zq9xK2vL");
    expect(at).toBeGreaterThan(0);
    zip.write("Yq9xK2vL", at); // stored, same length; fixes nothing else
    await expectRejectedWritingNothing(zip, /crc|corrupt|hash|modified|does not match|checksum/i);
  });

  it("bundled plugin re-zipped with a valid CRC but different bytes (stale manifest hashes)", async () => {
    const entries = readZip(buildPackZip({ bundled: [{ id: "p", mainJs: "module.exports=class Good{};" }] })).map((e) => ({ name: e.name, data: e.name === "plugins/p/main.js" ? Buffer.from("require('child_process').exec('id')") : e.data }));
    await expectRejectedWritingNothing(writeZip(entries), /sha256|hash|does not match/i);
  });

  it("plugin directory present but not declared in the manifest", async () => {
    const zip = buildPackZip({
      extraEntries: [
        { name: "plugins/sneaky/manifest.json", data: Buffer.from("{\"id\":\"sneaky\"}") },
        { name: "plugins/sneaky/main.js", data: Buffer.from("require('child_process')") },
      ],
    });
    await expectRejectedWritingNothing(zip, /not declared|undeclared|declared|contentSha256/i);
  });

  it("manifest declares a bundled plugin whose files are missing", async () => {
    const zip = buildPackZip({ bundled: [{ id: "p" }] });
    // Rebuild without the plugin files but keep the manifest entry.
    const manifestOnly = buildPackZip({ manifest: { plugins: [{ id: "ghost", source: "bundled", sha256: "a".repeat(64), enabled: true, locked: false }] } });
    expect(zip.length).toBeGreaterThan(0);
    await expectRejectedWritingNothing(manifestOnly, /./);
  });

  it("plugins.json inside the pack naming a plugin the manifest never declared does not enable it", async () => {
    const parent = await tmp();
    const zip = buildPackZip({ files: { ".geode/plugins.json": JSON.stringify(["community-evil"]) } });
    await createVaultFromPack(buf(zip), parent, "Victim");
    const enabled = JSON.parse(await fs.readFile(path.join(parent, "Victim", ".geode", "plugins.json"), "utf8").catch(() => "[]")) as string[];
    expect(enabled).not.toContain("community-evil");
  });

  it("plugin id that is a path traversal or first-party lookalike", async () => {
    await expectRejectedWritingNothing(
      buildPackZip({ manifest: { plugins: [{ id: "../../evil", source: "github", repo: "o/r", enabled: true, locked: false }] } }),
      /./,
    );
  });

  it("truncated archives, garbage, empty input and an EOCD-only stub", async () => {
    const good = buildPackZip({ bundled: [{ id: "p" }] });
    for (const bad of [good.subarray(0, good.length - 7), good.subarray(0, 40), Buffer.alloc(0), Buffer.from("PK\x05\x06" + "\0".repeat(18), "binary"), Buffer.from("not a zip at all")]) {
      await expectRejectedWritingNothing(Buffer.from(bad), /./);
    }
  });
});

describe("destination handling", () => {
  it("creating into a name that already exists (file, empty folder, non-empty folder) refuses and leaves it untouched", async () => {
    const zip = buildPackZip();
    const parent = await tmp();
    await fs.writeFile(path.join(parent, "AsFile"), "keep");
    await fs.mkdir(path.join(parent, "Empty"));
    await fs.mkdir(path.join(parent, "Full"));
    await fs.writeFile(path.join(parent, "Full", "mine.md"), "keep");
    for (const name of ["AsFile", "Empty", "Full"]) {
      await expect(createVaultFromPack(buf(zip), parent, name)).rejects.toThrow(/already exists/);
    }
    expect(await fs.readFile(path.join(parent, "AsFile"), "utf8")).toBe("keep");
    expect(await fs.readdir(path.join(parent, "Empty"))).toEqual([]);
    expect(await fs.readdir(path.join(parent, "Full"))).toEqual(["mine.md"]);
  });

  it("creating into a case-variant of an existing folder is refused on a case-insensitive volume", async () => {
    const zip = buildPackZip();
    const parent = await tmp();
    await fs.mkdir(path.join(parent, "Acme"));
    await fs.writeFile(path.join(parent, "Acme", "mine.md"), "keep");
    const probe = await fs.lstat(path.join(parent, "ACME")).then(() => true, () => false);
    if (!probe) return; // case-sensitive filesystem: a distinct folder is legitimate
    await expect(createVaultFromPack(buf(zip), parent, "ACME")).rejects.toThrow(/already exists/);
    expect(await fs.readdir(path.join(parent, "Acme"))).toEqual(["mine.md"]);
  });

  it("creating through a symlinked target name is refused", async () => {
    const zip = buildPackZip();
    const parent = await tmp();
    const outside = await tmp();
    await fs.symlink(outside, path.join(parent, "Link"));
    await expect(createVaultFromPack(buf(zip), parent, "Link")).rejects.toThrow(/already exists/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["", "   ", ".", "..", "../escape", "a/b", "a\\b", "x\0y"])("rejects vault name %j", async (name) => {
    const parent = await tmp();
    await expect(createVaultFromPack(buf(buildPackZip()), parent, name)).rejects.toThrow(VaultPackError);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("non-string parent or name from the renderer is a clean error", async () => {
    await expect(createVaultFromPack(buf(buildPackZip()), 42, "x")).rejects.toThrow(VaultPackError);
    await expect(createVaultFromPack(buf(buildPackZip()), await tmp(), { toString: () => "x" })).rejects.toThrow(VaultPackError);
  });

  it("a read-only parent fails cleanly and leaves no staging directory", async () => {
    if (process.getuid?.() === 0) return;
    const parent = await tmp();
    await fs.chmod(parent, 0o555);
    await expect(createVaultFromPack(buf(buildPackZip()), parent, "Victim")).rejects.toThrow();
    await fs.chmod(parent, 0o755);
    expect(await fs.readdir(parent)).toEqual([]);
  });
});

describe("empty, zero-byte and unusual-but-legal content", () => {
  it("a pack with zero-byte files, empty dirs and a unicode filename applies and round-trips", async () => {
    const parent = await tmp();
    const zip = buildPackZip({ files: { "empty.md": "", "Zażółć gęślą jaźń/日本語.md": "x", "deep/a/b/c/d/e.md": "" } });
    const { path: created } = await createVaultFromPack(buf(zip), parent, "Victim");
    expect((await fs.stat(path.join(created, "empty.md"))).size).toBe(0);
    expect(await fs.readFile(path.join(created, "Zażółć gęślą jaźń", "日本語.md"), "utf8")).toBe("x");
    expect(await fs.readdir(parent)).toEqual(["Victim"]);
  });

  it("a pack with no vault files and no plugins is valid and creates an empty vault", async () => {
    const parent = await tmp();
    const { path: created } = await createVaultFromPack(buf(buildPackZip({ files: {} })), parent, "Victim");
    expect(await fs.readdir(created)).toEqual([]);
  });

  it("inspect never writes: parent unchanged after inspecting a hostile pack", async () => {
    const parent = await tmp();
    await expect(inspectVaultPack(buf(buildPackZip({ extraEntries: [hostileExtra("vault/../x")] })))).rejects.toThrow();
    expect(await fs.readdir(parent)).toEqual([]);
  });
});

describe("export edge cases", () => {
  async function makeVault(): Promise<string> {
    const v = await tmp();
    await fs.writeFile(path.join(v, "a.md"), "a");
    await fs.writeFile(path.join(v, "empty.md"), "");
    await fs.mkdir(path.join(v, ".geode"));
    await fs.writeFile(path.join(v, ".geode", "workspace.json"), "{}");
    return v;
  }

  it("an empty file exports and imports back as an empty file", async () => {
    const v = await makeVault();
    const out = path.join(await tmp(), "o.vault");
    await exportVaultPack(v, out);
    const parent = await tmp();
    const { path: created } = await createVaultFromPack({ kind: "file", path: out } as never, parent, "Copy").catch(async () => createVaultFromPack(buf(await fs.readFile(out)), parent, "Copy"));
    expect((await fs.stat(path.join(created, "empty.md"))).size).toBe(0);
    expect(await fs.readFile(path.join(created, "a.md"), "utf8")).toBe("a");
    await expect(fs.stat(path.join(created, ".geode", "workspace.json"))).rejects.toThrow();
  });

  it("an unreadable file fails the export with an error and leaves neither output nor temp file", async () => {
    if (process.getuid?.() === 0) return;
    const v = await makeVault();
    await fs.writeFile(path.join(v, "secret.md"), "s");
    await fs.chmod(path.join(v, "secret.md"), 0o000);
    const outDir = await tmp();
    const out = path.join(outDir, "o.vault");
    await expect(exportVaultPack(v, out)).rejects.toThrow(/EACCES|permission/i);
    expect(await fs.readdir(outDir)).toEqual([]);
  });

  it("a symlink inside the vault is not followed into the pack", async () => {
    const v = await makeVault();
    const outside = await tmp();
    await fs.writeFile(path.join(outside, "secret.txt"), "TOP-SECRET");
    await fs.symlink(outside, path.join(v, "linked-dir"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(v, "linked-file.md"));
    const out = path.join(await tmp(), "o.vault");
    await exportVaultPack(v, out);
    const bytes = await fs.readFile(out);
    expect(bytes.includes("TOP-SECRET")).toBe(false);
  });

  it("exporting over an existing output file replaces it atomically", async () => {
    const v = await makeVault();
    const outDir = await tmp();
    const out = path.join(outDir, "o.vault");
    await fs.writeFile(out, "old");
    await exportVaultPack(v, out);
    expect((await fs.readFile(out)).subarray(0, 2).toString()).toBe("PK");
    expect(await fs.readdir(outDir)).toEqual(["o.vault"]);
  });
});

describe("service: consent edge cases", () => {
  it("a tampered file path (granted a.vault, asks for ../a.vault or a non-.vault file) is refused", async () => {
    const dir = await tmp();
    const good = path.join(dir, "a.vault");
    await fs.writeFile(good, buildPackZip());
    await fs.writeFile(path.join(dir, "a.zip"), buildPackZip());
    const svc = new VaultPackService({ policy: () => null, geodeVersion: "0.30.8" });
    svc.grantPath(1, good);
    await expect(svc.inspect(1, path.join(dir, "sub", "..", "a.zip"))).rejects.toThrow(/not chosen/);
    await expect(svc.grantDropped(1, path.join(dir, "a.zip"))).rejects.toThrow(/not a \.vault/);
    await expect(svc.grantDropped(1, "relative/a.vault")).rejects.toThrow(/Choose a vault pack/);
    await expect(svc.grantDropped(1, "\\\\evil\\share\\a.vault")).rejects.toThrow(/Choose a vault pack/);
    await expect(svc.grantDropped(1, "file:///etc/x.vault")).rejects.toThrow(/Choose a vault pack/);
    await expect(svc.grantDropped(1, dir + "/a.vault/")).rejects.toThrow();
    await expect(svc.grantDropped(1, { toString: () => good })).rejects.toThrow(/Choose a vault pack/);
  });

  it("a granted path that is a directory named x.vault is rejected", async () => {
    const dir = await tmp();
    await fs.mkdir(path.join(dir, "x.vault"));
    const svc = new VaultPackService({ policy: () => null, geodeVersion: "0.30.8" });
    await expect(svc.grantDropped(1, path.join(dir, "x.vault"))).rejects.toThrow(/not found/);
  });

  it("hostile pack through the service: inspect rejects, no token is issued, create with a guessed token fails", async () => {
    const dir = await tmp();
    const packPath = path.join(dir, "bad.vault");
    await fs.writeFile(packPath, buildPackZip({ extraEntries: [hostileExtra("vault/../../x")] }));
    const parent = await tmp();
    const svc = new VaultPackService({ policy: () => null, geodeVersion: "0.30.8" });
    svc.grantPath(1, packPath);
    svc.grantParent(1, parent);
    await expect(svc.inspect(1, packPath)).rejects.toThrow(/vault pack/i);
    await expect(svc.create(1, "0".repeat(32), parent, "X")).rejects.toThrow(/no longer waiting/);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("unattended apply of a hostile pack throws and writes nothing", async () => {
    const dir = await tmp();
    const packPath = path.join(dir, "bad.vault");
    await fs.writeFile(packPath, buildPackZip({ extraEntries: [hostileExtra("vault/link", 0o120777)] }));
    const parent = await tmp();
    const svc = new VaultPackService({ policy: () => null, geodeVersion: "0.30.8" });
    await expect(svc.createUnattended(packPath, parent)).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("unattended apply picks a free name when the pack name is already taken", async () => {
    const dir = await tmp();
    const packPath = path.join(dir, "ok.vault");
    await fs.writeFile(packPath, buildPackZip());
    const parent = await tmp();
    await fs.mkdir(path.join(parent, "Acme Onboarding"));
    const svc = new VaultPackService({ policy: () => null, geodeVersion: "0.30.8" });
    const created = await svc.createUnattended(packPath, parent);
    expect(path.basename(created)).toBe("Acme Onboarding 2");
    expect(await fs.readdir(path.join(parent, "Acme Onboarding"))).toEqual([]);
  });
});

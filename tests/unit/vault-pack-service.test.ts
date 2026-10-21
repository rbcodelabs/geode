import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSENT_TTL_MS, isAbsoluteLocalPath, parseVaultPackLaunch, VaultPackService } from "../../src/main/vault-pack-service";
import { buildPackZip } from "./helpers/vault-pack-fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pack-svc-"));
  dirs.push(d);
  return d;
}
let clock = 1_000_000;
const service = () => {
  clock = 1_000_000;
  return new VaultPackService({ policy: () => null, geodeVersion: "0.30.8", now: () => clock });
};
const A = 1;
const B = 2;

async function fixturePack(): Promise<string> {
  const dir = await tmp();
  const packPath = path.join(dir, "acme.vault");
  await fs.writeFile(packPath, buildPackZip({ bundled: [{ id: "acme-tool" }] }));
  return packPath;
}

describe("VaultPackService: main-owned consent", () => {
  it("inspect writes nothing; create applies the inspected bytes only with this window's token and a granted parent", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);

    const offer = await svc.inspect(A, packPath);
    expect(offer.summary.name).toBe("Acme Onboarding");
    expect(offer.fileName).toBe("acme.vault");
    expect(await fs.readdir(parent)).toEqual([]);

    // The file changing after consent must not change what is written.
    await fs.writeFile(packPath, "garbage");
    const created = await svc.create(A, offer.token, parent, "Acme");
    expect(created).toBe(path.join(parent, "Acme"));
    expect(await fs.readFile(path.join(created, "Welcome.md"), "utf8")).toBe("# Hello\n");
    expect(JSON.parse(await fs.readFile(path.join(created, ".geode/plugins.json"), "utf8"))).toEqual(["acme-tool"]);

    await expect(svc.create(A, offer.token, parent, "Again")).rejects.toThrow(/no longer waiting/); // single use
  });

  it("rejects a pack path main never granted to that window", async () => {
    const packPath = await fixturePack();
    const svc = service();
    await expect(svc.inspect(A, packPath)).rejects.toThrow(/not chosen in this window/);
    svc.grantPath(A, packPath);
    await expect(svc.inspect(B, packPath)).rejects.toThrow(/not chosen in this window/);
    await expect(svc.inspect(A, "/etc/passwd")).rejects.toThrow(/not chosen in this window/);
    await expect(svc.inspect(A, undefined)).rejects.toThrow(/not chosen in this window/);
  });

  it("does not let another window redeem or discard a token", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);
    svc.grantParent(B, parent);
    const offer = await svc.inspect(A, packPath);
    await expect(svc.create(B, offer.token, parent, "Stolen")).rejects.toThrow(/no longer waiting/);
    svc.discard(B, offer.token); // wrong window: ignored
    expect(await svc.create(A, offer.token, parent, "Mine")).toBe(path.join(parent, "Mine"));
    expect(await fs.readdir(parent)).toEqual(["Mine"]);
  });

  it("expires tokens after 10 minutes", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);
    const offer = await svc.inspect(A, packPath);
    clock += CONSENT_TTL_MS - 1;
    const still = await svc.inspect(A, packPath); // pruning does not touch live tokens
    expect(still.token).not.toBe(offer.token);
    clock += 2;
    await expect(svc.create(A, offer.token, parent, "Late")).rejects.toThrow(/no longer waiting/);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses a destination parent main did not grant", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const other = await tmp();
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);
    const offer = await svc.inspect(A, packPath);
    await expect(svc.create(A, offer.token, other, "X")).rejects.toThrow(/Choose where to create/);
    await expect(svc.create(A, offer.token, "/tmp", "X")).rejects.toThrow(/Choose where to create/);
    expect(await fs.readdir(other)).toEqual([]);
    // The failed attempts did not burn the token.
    expect(await svc.create(A, offer.token, parent, "OK")).toBe(path.join(parent, "OK"));
  });

  it("keeps the token when create fails before writing (name collision), so the user can retry with another name", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    await fs.mkdir(path.join(parent, "Taken"));
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);
    const offer = await svc.inspect(A, packPath);
    await expect(svc.create(A, offer.token, parent, "Taken")).rejects.toThrow(/already exists/);
    await expect(svc.create(A, offer.token, parent, ".geode")).rejects.toThrow(/reserved/);
    expect(await fs.readdir(parent)).toEqual(["Taken"]);
    expect(await svc.create(A, offer.token, parent, "Fresh")).toBe(path.join(parent, "Fresh"));
    await expect(svc.create(A, offer.token, parent, "Again")).rejects.toThrow(/no longer waiting/);
  });

  it("declining (discard) and closing a window write nothing and invalidate tokens", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const svc = service();
    svc.grantPath(A, packPath);
    svc.grantParent(A, parent);
    const first = await svc.inspect(A, packPath);
    svc.discard(A, first.token);
    await expect(svc.create(A, first.token, parent, "X")).rejects.toThrow(/no longer waiting/);
    const second = await svc.inspect(A, packPath);
    svc.closeSender(A);
    await expect(svc.create(A, second.token, parent, "X")).rejects.toThrow(/no longer waiting/);
    await expect(svc.inspect(A, packPath)).rejects.toThrow(/not chosen in this window/);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses forged tokens", async () => {
    const parent = await tmp();
    const svc = service();
    svc.grantParent(A, parent);
    await expect(svc.create(A, "forged", parent, "X")).rejects.toThrow(/no longer waiting/);
    await expect(svc.create(A, undefined, parent, "X")).rejects.toThrow(/no longer waiting/);
  });

  it("validates dropped files before granting them", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "x.zip"), buildPackZip());
    await fs.writeFile(path.join(dir, "ok.vault"), buildPackZip());
    const svc = service();
    await expect(svc.grantDropped(A, path.join(dir, "x.zip"))).rejects.toThrow(/not a \.vault file/);
    await expect(svc.grantDropped(A, "rel.vault")).rejects.toThrow(/on this computer/);
    await expect(svc.grantDropped(A, "//server/share/a.vault")).rejects.toThrow(/on this computer/);
    await expect(svc.grantDropped(A, "file:///tmp/a.vault")).rejects.toThrow(/on this computer/);
    await expect(svc.grantDropped(A, path.join(dir, "missing.vault"))).rejects.toThrow(/not found/);
    await svc.grantDropped(A, path.join(dir, "ok.vault"));
    await expect(svc.inspect(A, path.join(dir, "ok.vault"))).resolves.toBeTruthy();
  });

  it("surfaces invalid packs at inspect", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "bad.vault"), "not a zip, but long enough to look like one");
    const svc = service();
    svc.grantPath(A, path.join(dir, "bad.vault"));
    await expect(svc.inspect(A, path.join(dir, "bad.vault"))).rejects.toThrow(/Not a valid vault pack/);
  });

  it("createUnattended names the vault from the pack, avoids collisions, and needs an absolute local path", async () => {
    const packPath = await fixturePack();
    const parent = await tmp();
    const svc = service();
    const first = await svc.createUnattended(packPath, parent);
    const second = await svc.createUnattended(packPath, parent);
    expect(path.basename(first)).toBe("Acme Onboarding");
    expect(path.basename(second)).toBe("Acme Onboarding 2");
    await expect(svc.createUnattended("rel/a.vault", parent)).rejects.toThrow(/absolute local path/);
    await expect(svc.createUnattended("\\\\host\\share\\a.vault", parent)).rejects.toThrow(/absolute local path/);
  });
});

describe("listOrganizationPacks", () => {
  it("lists from the manifest only, grants the paths, reports unreadable packs, and caches", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "good.vault"), buildPackZip());
    await fs.writeFile(path.join(dir, "bad.vault"), "nope nope nope nope nope nope nope");
    await fs.writeFile(path.join(dir, "ignored.txt"), "x");
    const svc = service();
    const list = await svc.listOrganizationPacks(A, dir);
    expect(list.map((e) => e.fileName)).toEqual(["bad.vault", "good.vault"]);
    expect(list[0].error).toMatch(/Not a zip|zip/i);
    expect(list[1]).toMatchObject({ name: "Acme Onboarding", version: "2.0.0" });
    expect(await svc.listOrganizationPacks(A, path.join(dir, "missing"))).toEqual([]);

    // Granted, so the click-through inspect works for this window only.
    await expect(svc.inspect(A, path.join(dir, "good.vault"))).resolves.toBeTruthy();
    await expect(svc.inspect(B, path.join(dir, "good.vault"))).rejects.toThrow();

    // Cached by mtime+size: the same object comes back, even after the contents are unreadable.
    const again = await svc.listOrganizationPacks(A, dir);
    expect(again[1]).toBe(list[1]);
  });

  it("does not inflate other entries: a pack with a corrupt non-manifest payload still lists", async () => {
    const dir = await tmp();
    const zip = buildPackZip({ files: { "big.md": "x".repeat(5000) } });
    const at = zip.indexOf("vault/big.md");
    // Damage that entry's compressed data (after its local header); the manifest entry is untouched.
    zip[at + "vault/big.md".length + 2] ^= 0xff;
    await fs.writeFile(path.join(dir, "damaged.vault"), zip);
    const list = await service().listOrganizationPacks(A, dir);
    expect(list[0]).toMatchObject({ name: "Acme Onboarding" });
  });
});

describe("parseVaultPackLaunch and --yes restrictions", () => {
  const cwd = "/work";
  const first = { allowYes: true };
  it("returns null without a pack", () => {
    expect(parseVaultPackLaunch(["electron", "."], cwd, first)).toBeNull();
  });
  it("parses --vault-pack <path> and --vault-pack=<path>", () => {
    expect(parseVaultPackLaunch(["geode", "--vault-pack", "/p/a.vault"], cwd, first)).toEqual({ packPath: "/p/a.vault", yes: false });
    expect(parseVaultPackLaunch(["geode", "--vault-pack=rel/a.vault"], cwd, first)).toEqual({ packPath: "/work/rel/a.vault", yes: false });
  });
  it("honors --yes only on the first launch, with an absolute local path", () => {
    expect(parseVaultPackLaunch(["geode", "--vault-pack", "/p/a.vault", "--yes"], cwd, first)?.yes).toBe(true);
    expect(parseVaultPackLaunch(["geode", "--vault-pack", "C:\\p\\a.vault", "--yes"], cwd, first)?.yes).toBe(true);
    expect(parseVaultPackLaunch(["geode", "--yes"], cwd, first)).toBeNull();
  });
  it("never honors --yes for second-instance (allowYes off, the default)", () => {
    const argv = ["geode", "--vault-pack", "/p/a.vault", "--yes"];
    expect(parseVaultPackLaunch(argv, cwd, { allowYes: false })).toEqual({ packPath: "/p/a.vault", yes: false });
    expect(parseVaultPackLaunch(argv, cwd)?.yes).toBe(false);
  });
  it("refuses --yes for relative paths (prompt still shown) and drops UNC paths and URLs entirely", () => {
    expect(parseVaultPackLaunch(["geode", "--vault-pack", "rel/a.vault", "--yes"], cwd, first)).toEqual({ packPath: "/work/rel/a.vault", yes: false });
    for (const bad of ["\\\\host\\share\\a.vault", "//host/share/a.vault", "file:///p/a.vault", "https://evil.example/a.vault"]) {
      expect(parseVaultPackLaunch(["geode", "--vault-pack", bad, "--yes"], cwd, first)).toBeNull();
    }
  });
  it("treats an opened .vault file as a prompted launch even if --yes is present", () => {
    expect(parseVaultPackLaunch(["geode", "/p/a.vault", "--yes"], cwd, first)).toEqual({ packPath: "/p/a.vault", yes: false });
  });
  it("isAbsoluteLocalPath", () => {
    expect(["/a", "C:\\a", "c:/a"].every(isAbsoluteLocalPath)).toBe(true);
    expect(["a", "./a", "\\\\h\\s", "//h/s", "file:///a", "https://h/a", ""].some(isAbsoluteLocalPath)).toBe(false);
  });
});

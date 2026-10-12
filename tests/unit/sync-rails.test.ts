import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteLimitFor, deleteLimitRefusal, knownFileCount, shrunkScanRefusal } from "../../src/sync-core/rails";
import { listVaultFiles } from "../../src/main/vault-files";

describe("rails shared by the CLI and the desktop hub provider", () => {
  it("delete limit is max(20, 1% of files found)", () => {
    expect(deleteLimitFor(0)).toBe(20); expect(deleteLimitFor(1999)).toBe(20); expect(deleteLimitFor(5000)).toBe(50);
  });
  const plan = (deletions: number) => ({ deletions, uploads: 0, downloads: 0, signature: "s" });
  it("refuses over the limit and names the counts; allows at the limit", () => {
    expect(deleteLimitRefusal(plan(20), 100)).toBeNull();
    const refusal = deleteLimitRefusal(plan(21), 100)!;
    expect(refusal).toMatchObject({ status: "delete-limit-exceeded", detail: { deletions: 21, limit: 20, vaultFiles: 100 } });
  });
  it("an override replaces the limit; it does not remove it", () => {
    expect(deleteLimitRefusal(plan(30), 100, { deleteLimit: 30 })).toBeNull();
    expect(deleteLimitRefusal(plan(31), 100, { deleteLimit: 30 })).not.toBeNull();
  });
  it("refuses a scan under half of what is known, and never on a fresh device", () => {
    expect(shrunkScanRefusal(0, 0)).toBeNull();
    expect(shrunkScanRefusal(10, 5)).toBeNull();
    expect(shrunkScanRefusal(10, 4)).toMatchObject({ status: "scan-shrunk", detail: { found: 4, known: 10, ratio: 0.4 } });
  });
  it("counts only present content files as known", () => {
    const state = { baseline: {
      a: { present: true, kind: "file", namespace: "content" }, b: { present: false, kind: "file", namespace: "content" },
      c: { present: true, kind: "folder", namespace: "content" }, d: { present: true, kind: "file", namespace: "portable-config" },
    } } as never;
    expect(knownFileCount(state)).toBe(1); expect(knownFileCount(null)).toBe(0);
  });
});

describe("the strict sync scan and iCloud placeholders (rail d)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const vault = () => { const r = mkdtempSync(join(tmpdir(), "geode-icloud-")); roots.push(r); return r; };

  it("reports a placeholder with no real file as blocked, and never as a file", async () => {
    const root = vault(); mkdirSync(join(root, "Sub"));
    writeFileSync(join(root, "Here.md"), "x"); writeFileSync(join(root, "Sub", ".Away.md.icloud"), "stub");
    const blocked: Array<{ path: string; reason: string }> = [];
    const entries = await listVaultFiles(root, { strictSync: true, onBlocked: issue => blocked.push(issue) });
    expect(blocked).toEqual([{ path: "Sub/Away.md", reason: "icloud-not-downloaded" }]);
    expect(entries.map(e => e.path).sort()).toEqual(["Here.md", "Sub"]);
  });
  it("is not fooled by a stub beside its real file (the file is downloaded)", async () => {
    const root = vault();
    writeFileSync(join(root, "Both.md"), "x"); writeFileSync(join(root, ".Both.md.icloud"), "stub");
    const blocked: unknown[] = [];
    await listVaultFiles(root, { strictSync: true, onBlocked: issue => blocked.push(issue) });
    expect(blocked).toEqual([]);
  });
  it("fails closed when no collector is supplied, and leaves ordinary listings alone", async () => {
    const root = vault(); writeFileSync(join(root, ".Away.md.icloud"), "stub");
    await expect(listVaultFiles(root, { strictSync: true })).rejects.toThrow(/iCloud placeholder not downloaded: Away\.md/);
    await expect(listVaultFiles(root)).resolves.toEqual([]);
    await expect(listVaultFiles(root, { strictSync: true, refreshOnly: true })).resolves.toEqual([]);
  });
});

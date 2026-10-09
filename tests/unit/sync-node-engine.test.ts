import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsStoreProvider } from "../../src/sync-node/index";
import { device, never, put, rmrf, tmp } from "../helpers/node-host-harness";

const cleanups: string[] = [];
const dir = (p: string) => { const d = tmp(p); cleanups.push(d); return d; };
afterEach(() => { for (const d of cleanups.splice(0)) rmrf(d); });
const text = (root: string, rel: string) => existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : undefined;
const tree = (root: string, base = ""): string[] => readdirSync(join(root, base), { withFileTypes: true }).filter(e => !e.name.startsWith(".")).flatMap(e => e.isDirectory() ? [`${join(base, e.name)}/`, ...tree(root, join(base, e.name))] : [join(base, e.name)]).sort();

async function world(extra = {}) {
  const store = dir("e2e-store"), provider = new FsStoreProvider(store);
  const binding = await provider.createVault({ name: "wiki", operationId: "node-host-e2e" }, never);
  const mk = (name: string, extraB = {}) => { const root = dir(`e2e-${name}`); return { root, dev: device(name, root, join(dir(`e2e-${name}-state`), "s"), provider, binding, { ...extra, ...extraB }) }; };
  return { provider, binding, store, mk };
}

describe("two NodeHost-backed vaults converge through the real engine and an FsStore hub", () => {
  it("replicates create, edit, delete, rename and folders; surfaces a conflict on concurrent edits", async () => {
    const w = await world(); const A = w.mk("A"), B = w.mk("B");
    put(A.root, "a.md", "one"); put(A.root, "dir/b.md", "two"); put(A.root, "dir/deep/c.md", "three");

    await A.dev.sync(true); await B.dev.sync(true);
    expect(text(B.root, "a.md")).toBe("one"); expect(text(B.root, "dir/b.md")).toBe("two"); expect(text(B.root, "dir/deep/c.md")).toBe("three");
    expect(tree(B.root)).toEqual(tree(A.root));

    put(A.root, "a.md", "edited by A"); await A.dev.sync(); await B.dev.sync();
    expect(text(B.root, "a.md")).toBe("edited by A");

    rmSync(join(B.root, "dir/b.md")); await B.dev.sync(); await A.dev.sync();
    expect(text(A.root, "dir/b.md")).toBeUndefined();
    // the deleted file went to the device trash of A, not oblivion
    const trashed = readdirSync(join(A.dev.stateDir, "trash"), { recursive: true }) as string[];
    expect(trashed.some(p => p.endsWith("dir/b.md"))).toBe(true);

    renameSync(join(A.root, "dir/deep/c.md"), join(A.root, "dir/deep/renamed.md")); await A.dev.sync(); await B.dev.sync();
    expect(text(B.root, "dir/deep/renamed.md")).toBe("three"); expect(text(B.root, "dir/deep/c.md")).toBeUndefined();
    expect(tree(B.root)).toEqual(tree(A.root));

    expect((await A.dev.sync()).upToDate).toBe(true); expect((await B.dev.sync()).upToDate).toBe(true);
    // nothing of the apply machinery is left behind in the vault
    expect(readdirSync(join(B.root, ".geode-sync-tmp"))).toEqual([]);
    expect(readdirSync(B.root).filter(n => n.startsWith(".geode-sync-") && n !== ".geode-sync-tmp")).toEqual([]);

    put(A.root, "a.md", "A concurrent"); put(B.root, "a.md", "B concurrent");
    expect((await A.dev.sync()).conflicts).toEqual([]);
    const seenByB = await B.dev.sync();
    expect(seenByB.conflicts).toHaveLength(1); expect(seenByB.conflicts[0]).toMatchObject({ path: "a.md" });
    expect(text(A.root, "a.md")).toBe("A concurrent"); expect(text(B.root, "a.md")).toBe("B concurrent"); // neither side overwritten
    expect((await A.dev.sync()).conflicts).toHaveLength(1);
  }, 60_000);

  for (const crashAt of ["staged", "committed"]) it(`an apply killed at the '${crashAt}' checkpoint is recovered by the next run: converges, nothing lost or duplicated`, async () => {
    let armed = false;
    const w = await world(); const A = w.mk("A"); const B = w.mk("B", { applyCheckpoint: (name: string) => { if (armed && name === crashAt) { armed = false; throw new Error(`simulated kill at ${name}`); } } });
    put(A.root, "n/one.md", "1"); put(A.root, "n/two.md", "2"); put(A.root, "three.md", "3");
    await A.dev.sync(true);
    armed = true;
    const first = await B.dev.sync(true).then(() => "completed", e => String(e));
    expect(armed).toBe(false); // the injected kill really fired
    expect(first).toContain(`simulated kill at ${crashAt}`); // the first run really died mid-apply
    // rerun (a fresh process would do exactly this): no operator action needed
    for (let i = 0; i < 3; i++) await B.dev.sync(true);
    expect(tree(B.root)).toEqual(tree(A.root));
    expect(text(B.root, "n/one.md")).toBe("1"); expect(text(B.root, "n/two.md")).toBe("2"); expect(text(B.root, "three.md")).toBe("3");
    expect(readdirSync(B.root).filter(n => /conflict|\(2\)| 2\./.test(n))).toEqual([]);
    expect((await B.dev.sync()).upToDate).toBe(true);
    expect((await B.dev.sync()).conflicts).toEqual([]);
    // a second round trip still behaves: B edits, A receives, no duplicates anywhere
    put(B.root, "three.md", "3b"); await B.dev.sync(); await A.dev.sync();
    expect(text(A.root, "three.md")).toBe("3b"); expect(tree(A.root)).toEqual(tree(B.root));
  }, 60_000);

  it("blocked iCloud files are never deleted remotely: placeholders and evicted files stay put on every device", async () => {
    const w = await world(); const A = w.mk("A"), B = w.mk("B"), C = w.mk("C");
    put(A.root, "keep.md", "precious"); put(A.root, "Notes/also.md", "also precious"); put(A.root, "other.md", "o");
    await A.dev.sync(true); await B.dev.sync(true);
    expect(text(B.root, "keep.md")).toBe("precious");

    // On B, iCloud swaps keep.md and Notes/also.md for placeholders (the real names vanish).
    rmSync(join(B.root, "keep.md")); writeFileSync(join(B.root, ".keep.md.icloud"), "stub");
    rmSync(join(B.root, "Notes/also.md")); writeFileSync(join(B.root, "Notes/.also.md.icloud"), "stub");
    const preview = await B.dev.sync();
    expect(preview.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ path: "keep.md", reason: "icloud-not-downloaded" }), expect.objectContaining({ path: "Notes/also.md", reason: "icloud-not-downloaded" })]));
    expect(preview.upToDate).toBe(false);
    await B.dev.sync(); await A.dev.sync();
    expect(text(A.root, "keep.md")).toBe("precious"); expect(text(A.root, "Notes/also.md")).toBe("also precious");
    // a brand-new device sees the files in the hub: they were never tombstoned
    await C.dev.sync(true);
    expect(text(C.root, "keep.md")).toBe("precious"); expect(text(C.root, "Notes/also.md")).toBe("also precious");

    // Evicted-but-named: simulate with the zero-block heuristic on a host that sees blocks === 0 for it.
    const E = w.mk("E");
    await E.dev.sync(true); // joins; all content downloaded
    expect(text(E.root, "other.md")).toBe("o");
    const fs = await import("node:fs/promises");
    const io = { opendir: (d: string) => fs.opendir(d), lstat: async (f: string) => { const s = await fs.lstat(f); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { blocks: f.endsWith("other.md") ? 0 : s.blocks }); } };
    const evictedDev = device("E-evicted", E.root, E.dev.stateDir, w.provider, w.binding, { detectEvicted: true, scanIo: io as never, settleMs: 0 }, E.dev.deviceId);
    const evictedPreview = await evictedDev.sync();
    expect(evictedPreview.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ path: "other.md", reason: "icloud-evicted" })]));
    expect(evictedPreview.deletions).toBe(0);
    await A.dev.sync(); expect(text(A.root, "other.md")).toBe("o");
    // and the hub still has it for others
    const D = w.mk("D"); await D.dev.sync(true); expect(text(D.root, "other.md")).toBe("o");
  }, 90_000);

  it("a locked state dir makes the second run report 'locked' without touching anything", async () => {
    const w = await world(); const A = w.mk("A"); put(A.root, "a.md", "x");
    const host = await A.dev.host();
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const held = host.run(async () => { await gate; });
    await new Promise(r => setTimeout(r, 30));
    await expect(A.dev.sync(true)).rejects.toMatchObject({ code: "locked" });
    release(); await held;
    await A.dev.sync(true);
  }, 30_000);
});

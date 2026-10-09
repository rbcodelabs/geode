import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { applyGuardedMutation, moveToTrash } from "../../src/sync-node";
const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const exdev = () => Object.assign(new Error("cross-device"), { code: "EXDEV" });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geode-node-"))); roots.push(root);
  const vault = path.join(root, "vault"); await fs.mkdir(vault); await fs.writeFile(path.join(vault, "Note.md"), "old");
  return { root, vault, recovery: path.join(root, "recovery"), trashDir: path.join(root, "trash"), stagingDir: path.join(root, "stage") };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const exists = (p: string) => fs.access(p).then(() => true, () => false);

it("moveToTrash renames into <trashDir>/<opId>/<rel>", async () => {
  const f = await fixture(); const op = randomUUID(); await fs.mkdir(path.join(f.vault, "A"));  await fs.writeFile(path.join(f.vault, "A/B.md"), "x");
  const dest = await moveToTrash(f.vault, "A/B.md", f.trashDir, op);
  expect(dest).toBe(path.join(f.trashDir, op, "A/B.md")); expect(await fs.readFile(dest, "utf8")).toBe("x"); expect(await exists(path.join(f.vault, "A/B.md"))).toBe(false);
});

it("moveToTrash falls back to copy+unlink on EXDEV and leaves no partial", async () => {
  const f = await fixture(); const op = randomUUID(); let calls = 0;
  const dest = await moveToTrash(f.vault, "Note.md", f.trashDir, op, { rename: async (a, b) => { calls++; if (a.endsWith("Note.md")) throw exdev(); await fs.rename(a, b); } });
  expect(calls).toBeGreaterThan(0); expect(await fs.readFile(dest, "utf8")).toBe("old"); expect(await exists(path.join(f.vault, "Note.md"))).toBe(false);
  expect(await fs.readdir(path.dirname(dest))).toEqual(["Note.md"]);
});

it("moveToTrash rejects non-EXDEV errors, trashDir inside the vault, and relative trashDir", async () => {
  const f = await fixture(); const op = randomUUID();
  await expect(moveToTrash(f.vault, "Note.md", f.trashDir, op, { rename: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } })).rejects.toThrow("denied");
  expect(await exists(path.join(f.vault, "Note.md"))).toBe(true);
  await expect(moveToTrash(f.vault, "Note.md", path.join(f.vault, "t"), op)).rejects.toThrow(/outside/);
  await expect(moveToTrash(f.vault, "Note.md", "rel", op)).rejects.toThrow(/absolute/);
});

it("trashDir: trash mutation is recoverable and does not call deps.trash", async () => {
  const f = await fixture(); const op = randomUUID(); let called = false;
  const res = await applyGuardedMutation(f.vault, f.recovery, { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "trash" }, { trash: async () => { called = true; }, trashDir: f.trashDir });
  expect(res.status).toBe("applied"); expect(called).toBe(false);
  expect(await fs.readFile(path.join(f.trashDir, op, "Note.md"), "utf8")).toBe("old"); expect(await exists(path.join(f.vault, "Note.md"))).toBe(false);
});

it("trashDir: overwritten preimage is preserved on write", async () => {
  const f = await fixture(); const op = randomUUID();
  await applyGuardedMutation(f.vault, f.recovery, { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, { trashDir: f.trashDir });
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("new"); expect(await fs.readFile(path.join(f.trashDir, op, "Note.md"), "utf8")).toBe("old");
});

it("trashDir: cross-device trash falls back through apply", async () => {
  const f = await fixture(); const op = randomUUID();
  await applyGuardedMutation(f.vault, f.recovery, { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "trash" }, { trashDir: f.trashDir, io: { rename: async (a, b) => { if (a.endsWith("Note.md") && !a.includes("partial")) throw exdev(); await fs.rename(a, b); } } });
  expect(await fs.readFile(path.join(f.trashDir, op, "Note.md"), "utf8")).toBe("old"); expect(await exists(path.join(f.vault, "Note.md"))).toBe(false);
});

it("trashDir: crash after the move but before acknowledgement retries as already-applied", async () => {
  const f = await fixture(); const op = randomUUID();
  const input = { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "trash" as const };
  for (const phase of ["prepared", "staged", "committed"]) {
    const g = await fixture(); const id = randomUUID(); const i = { ...input, operationId: id };
    await expect(applyGuardedMutation(g.vault, g.recovery, i, { trashDir: g.trashDir, checkpoint: async p => { if (p === phase) throw new Error("crash"); } })).rejects.toThrow("crash");
    const retry = await applyGuardedMutation(g.vault, g.recovery, i, { trashDir: g.trashDir });
    expect(retry.status === "applied" || retry.status === "already-applied").toBe(true);
    expect(await exists(path.join(g.vault, "Note.md"))).toBe(false);
    expect(await fs.readFile(path.join(g.trashDir, id, "Note.md"), "utf8")).toBe("old");
  }
  void f;
});

it("trashDir: crash on write keeps preimage recoverable and retry converges", async () => {
  const f = await fixture(); const op = randomUUID();
  const input = { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "write" as const, data: bytes("new") };
  await expect(applyGuardedMutation(f.vault, f.recovery, input, { trashDir: f.trashDir, checkpoint: async p => { if (p === "staged") throw new Error("crash"); } })).rejects.toThrow("crash");
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("old");
  await applyGuardedMutation(f.vault, f.recovery, input, { trashDir: f.trashDir });
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("new"); expect(await fs.readFile(path.join(f.trashDir, op, "Note.md"), "utf8")).toBe("old");
});

it("stagingDir: same device stages in stagingDir and reports it", async () => {
  const f = await fixture(); const op = randomUUID(); let stagedIn: string[] = [];
  const res = await applyGuardedMutation(f.vault, f.recovery, { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, { stagingDir: f.stagingDir, checkpoint: async p => { if (p === "staged") stagedIn = [...await fs.readdir(f.stagingDir), ...(await fs.readdir(f.vault)).filter(n => n.startsWith(".geode-sync"))]; } });
  expect(res.stagingUsed).toBe("stagingDir"); expect(stagedIn).toEqual([`.geode-sync-${op}`]);
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("new"); expect(await fs.readdir(f.stagingDir)).toEqual([]);
});

it("stagingDir: cross-device falls back beside the target", async () => {
  const f = await fixture(); const op = randomUUID();
  // Rename of the stage file from stagingDir fails with EXDEV, as it would across volumes.
  const res = await applyGuardedMutation(f.vault, f.recovery, { operationId: op, path: "Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, { stagingDir: f.stagingDir, io: { rename: async (a, b) => { if (a.startsWith(f.stagingDir)) throw exdev(); await fs.rename(a, b); } } });
  expect(res.stagingUsed).toBe("beside-target"); expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("new");
  expect(await fs.readdir(f.vault)).toEqual(["Note.md"]);
});

it("default options report no stagingUsed", async () => {
  const f = await fixture();
  const res = await applyGuardedMutation(f.vault, f.recovery, { operationId: randomUUID(), path: "Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, { trash: async () => {} });
  expect(res).not.toHaveProperty("stagingUsed");
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { applyGuardedMutation } from "../../src/main/sync-apply";
import { withVaultMutation } from "../../src/main/path-lock";
const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "geode-guard-")); roots.push(root); const vault = path.join(root, "vault"); await fs.mkdir(vault); await fs.writeFile(path.join(vault, "Note.md"), "old"); return { vault, recovery: path.join(root, "recovery"), deps: { trash: async (target: string) => { await fs.rm(target); } } }; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("routes only allowlisted portable assets into private config paths", async () => {
  const f = await fixture();
  const input = { operationId: randomUUID(), namespace: "portable-config" as const, path: "snippets/custom.css", expectedHash: null, kind: "write" as const, data: bytes("body{}") };
  await applyGuardedMutation(f.vault, f.recovery, input, f.deps);
  expect(await fs.readFile(path.join(f.vault, ".geode/snippets/custom.css"), "utf8")).toBe("body{}");
  await expect(applyGuardedMutation(f.vault, f.recovery, { ...input, operationId: randomUUID(), path: "plugins/private/data.json" }, f.deps)).rejects.toThrow(/asset/);
});

it("holds ancestor rename behind a guarded descendant application", async () => {
  const f = await fixture(); await fs.mkdir(path.join(f.vault, "Folder")); await fs.writeFile(path.join(f.vault, "Folder", "Note.md"), "old");
  let prepared!: () => void; const started = new Promise<void>(resolve => { prepared = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const applying = applyGuardedMutation(f.vault, f.recovery, { operationId: randomUUID(), path: "Folder/Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, { ...f.deps, checkpoint: async phase => { if (phase === "prepared") { prepared(); await waiting; } } });
  await started; let renamed = false;
  const rename = withVaultMutation(f.vault, [path.join(f.vault, "Folder")], async () => { await fs.rename(path.join(f.vault, "Folder"), path.join(f.vault, "Moved")); renamed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(renamed).toBe(false); release(); await applying; await rename;
  expect(await fs.readFile(path.join(f.vault, "Moved", "Note.md"), "utf8")).toBe("new");
});

it("keeps a durable preimage before replacing the canonical file", async () => {
  const f = await fixture(); const operationId = randomUUID();
  const result = await applyGuardedMutation(f.vault, f.recovery, { operationId, path: "Note.md", expectedHash: hash("old"), kind: "write", data: bytes("new") }, f.deps);
  expect(await fs.readFile(path.join(result.recoveryPath, "before"), "utf8")).toBe("old"); expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("new");
});

it("rejects same-size local changes before destructive application", async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.vault, "Note.md"), "two");
  await expect(applyGuardedMutation(f.vault, f.recovery, { operationId: randomUUID(), path: "Note.md", expectedHash: hash("old"), kind: "trash" }, f.deps)).rejects.toThrow(/changed/);
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("two");
});

it("recognizes a committed operation after an interrupted acknowledgement", async () => {
  const f = await fixture(); const input = { operationId: randomUUID(), path: "Note.md", expectedHash: hash("old"), kind: "write" as const, data: bytes("new") };
  await expect(applyGuardedMutation(f.vault, f.recovery, input, { ...f.deps, checkpoint: async phase => { if (phase === "committed") throw new Error("crash"); } })).rejects.toThrow("crash");
  expect((await applyGuardedMutation(f.vault, f.recovery, input, f.deps)).status).toBe("already-applied");
});

it("does not destroy a file after durable recovery preparation fails", async () => {
  const f = await fixture(); await fs.writeFile(f.recovery, "not a directory");
  await expect(applyGuardedMutation(f.vault, f.recovery, { operationId: randomUUID(), path: "Note.md", expectedHash: hash("old"), kind: "trash" }, f.deps)).rejects.toMatchObject({ code: "ENOTDIR" });
  expect(await fs.readFile(path.join(f.vault, "Note.md"), "utf8")).toBe("old");
});

it("rejects traversal and symlink targets", async () => {
  const f = await fixture(); const input = { operationId: randomUUID(), path: "../escape", expectedHash: null, kind: "write" as const, data: bytes("new") };
  await expect(applyGuardedMutation(f.vault, f.recovery, input, f.deps)).rejects.toThrow(/path/i);
  await fs.symlink(path.join(f.vault, "Note.md"), path.join(f.vault, "Alias.md"));
  await expect(applyGuardedMutation(f.vault, f.recovery, { ...input, path: "Alias.md", expectedHash: hash("old") }, f.deps)).rejects.toThrow(/symbolic/i);
});

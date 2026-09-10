import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyPortableMutation } from "../../src/main/sync-config-apply";
import { projectPortableConfig, serializePortableConfig } from "../../src/shared/portable-config";
import { DEFAULT_SYNC_SCOPE } from "../../src/renderer/sync/scope";

it("merges guarded portable fields and retry receipts without replacing unrelated local settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-config-"));
  try {
    await fs.mkdir(path.join(root, ".geode"));
    const file = path.join(root, ".geode/app.json");
    const local = { theme: "dark", privateEndpoint: "local-only" };
    await fs.writeFile(file, JSON.stringify(local));
    const documents = await projectPortableConfig({ read: async () => local }, { ...DEFAULT_SYNC_SCOPE, hotkeys: false, corePlugins: false });
    const current = documents.find(document => document.name === "appearance.json")!;
    const expectedHash = createHash("sha256").update(Buffer.from(serializePortableConfig(current))).digest("hex");
    const desired = serializePortableConfig({ name: "appearance.json", value: { theme: "light", baseFontSize: 18, cssTheme: "" } });
    const input = { operationId: randomUUID(), path: "appearance.json", expectedHash, kind: "write" as const, data: desired };
    await applyPortableMutation(root, path.join(root, "recovery"), input, {});
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ theme: "light", privateEndpoint: "local-only" });
    const changed = JSON.parse(await fs.readFile(file, "utf8")); changed.privateEndpoint = "new-local"; await fs.writeFile(file, JSON.stringify(changed));
    await applyPortableMutation(root, path.join(root, "recovery"), input, {});
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ theme: "light", privateEndpoint: "new-local" });
    await expect(applyPortableMutation(root, path.join(root, "recovery"), { ...input, operationId: randomUUID() }, {})).rejects.toThrow(/changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateInventory, saveInventory } from "../../scripts/cloud-preview/inventory";
const schema = "geode_wiki_preview_0123456789abcdef";
function manifest() { return { version: 1, schema, denialSchema: schema + "_deny", tables: ["receipt","catalog_entry","object","vault_sequence"],
  createdAt: "2026-09-20T12:00:00Z", expiresAt: "2026-09-21T12:00:00Z", target: { teamId: "team_fixture", projectId: "prj_fixture", host: "fixture.dsql.us-east-1.on.aws", region: "us-east-1", roleArn: "arn:aws:iam::123456789012:role/fixture", blobStoreId: "fixtureStore" },
  blobKeys: [schema + "/vault/objects/" + "a".repeat(64)] }; }
describe("exact preview resource inventory", () => {
  it("accepts a bounded exact synthetic inventory", () => { expect(validateInventory(manifest())).toEqual(manifest()); });
  it.each(["public", "geode_wiki_preview_*", "geode_wiki_preview_a;DROP SCHEMA public"])('rejects non-owned schema %s', schema => {
    expect(() => validateInventory({ ...manifest(), schema })).toThrow();
  });
  it("refuses outside keys, duplicate keys and extra tables", () => {
    const m = manifest();
    expect(() => validateInventory({ ...m, blobKeys: ["other/vault/objects/" + "a".repeat(64)] })).toThrow();
    expect(() => validateInventory({ ...m, blobKeys: [...m.blobKeys,...m.blobKeys] })).toThrow();
    expect(() => validateInventory({ ...m, tables: [...m.tables,"unrelated"] })).toThrow();
  });
  it("rejects mismatched endpoint region and retention beyond 24 hours", () => {
    const m = manifest();
    expect(() => validateInventory({ ...m, target: { ...m.target, region: "us-west-2" } })).toThrow();
    expect(() => validateInventory({ ...m, expiresAt: "2026-09-22T12:00:00Z" })).toThrow();
  });
  it("rejects unexpected fields so credentials cannot enter a durable inventory", () => {
    expect(() => validateInventory({ ...manifest(), token: "secret" })).toThrow();
  });
  it("writes a private exclusive durable inventory and refuses overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "geode-inventory-test-"));
    try {
      const path = join(dir,"inventory.json"); await saveInventory(path,manifest());
      expect(JSON.parse(await readFile(path,"utf8"))).toEqual(manifest());
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(saveInventory(path,manifest())).rejects.toThrow();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

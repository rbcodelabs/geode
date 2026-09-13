import { expect, it } from "vitest";
import { Vault } from "../../src/renderer/vault";

it("keeps strict scan configuration out of the ordinary vault refresh manifest", async () => {
  const vault = new Vault({
    config: { read: async () => null },
    vaultFiles: { reconcileScan: async () => ({ status: "complete", entries: [
      { path: "Visible.md", isFolder: false, size: 1, mtime: 1, ctime: 1 },
      { path: ".geode/app.json", isFolder: false, size: 1, mtime: 1, ctime: 1 },
      { path: ".geode/metadata-cache/cache.json", isFolder: false, size: 1, mtime: 1, ctime: 1 },
    ] }) },
  } as never);
  const refreshed = await vault.reconcile();
  expect(refreshed.changes.map(change => change.path)).toEqual(["Visible.md"]);
});

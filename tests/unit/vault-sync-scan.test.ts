import { expect, it } from "vitest";
import { Vault } from "../../src/renderer/vault";

it("does not let one window acknowledge another window's pending refresh", async () => {
  let stored: unknown = null;
  let entries = [{ path: "Ideas.canvas", isFolder: false, size: 10, mtime: 1, ctime: 1 }];
  const host = {
    vaultRegistry: { openVault: async () => ({ root: "/test", name: "test" }) },
    config: {
      read: async () => structuredClone(stored),
      write: async (_name: string, value: unknown) => { stored = structuredClone(value); },
    },
    vaultFiles: {
      list: async () => entries,
      onChange: () => () => undefined,
      reconcileScan: async () => ({ status: "complete", entries }),
    },
  };
  const first = new Vault(host as never);
  const second = new Vault(host as never);
  await first.open("/test");
  await second.open("/test");
  entries = [{ ...entries[0], size: 20, mtime: 2 }];
  const refreshed = await first.reconcile();
  await first.commitReconcileManifest(refreshed.manifest!);
  expect((await second.reconcile()).changes).toMatchObject([{ event: "modify", path: "Ideas.canvas" }]);
  // A failed refresh must remain pending even if another window committed.
  expect((await second.reconcile()).changes).toMatchObject([{ event: "modify", path: "Ideas.canvas" }]);
  const secondRefresh = await second.reconcile();
  await second.commitReconcileManifest(secondRefresh.manifest!);
  expect((await second.reconcile()).changes).toEqual([]);
});

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

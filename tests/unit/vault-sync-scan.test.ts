import { expect, it } from "vitest";
import { Vault } from "../../src/renderer/vault";

it("uses a dedicated refresh scan and retains failure diagnostics without publishing deletions", async () => {
  const failure = { operation: "scan", category: "permission", code: "EACCES", path: "Folder" };
  const vault = new Vault({ config: { read: async () => null }, vaultFiles: {
    refreshScan: async () => ({ status: "unavailable", entries: [], failure }),
    reconcileScan: async () => { throw new Error("Sync must not be used for refresh"); },
  } } as never);
  expect(await vault.reconcile()).toMatchObject({ status: "unavailable", changes: [], failure });
});

it("keeps opened files and the durable baseline through a partial refresh and discovers pending changes on retry", async () => {
  const original = { path: "Existing.md", isFolder: false, mtime: 1, ctime: 1, size: 1 };
  let stored: unknown = null;
  let fail = false;
  let entries = [original];
  const vault = new Vault({
    vaultRegistry: { openVault: async () => ({ root: "/fixture", name: "fixture" }) },
    config: { read: async () => stored, write: async (_key: string, value: unknown) => { stored = structuredClone(value); } },
    vaultFiles: { list: async () => [original], onChange: () => () => {}, refreshScan: async () => fail
      ? { status: "partial", entries: [], failure: { operation: "read-directory", category: "permission", code: "EACCES" } }
      : { status: "complete", entries } },
  } as never);
  await vault.open("/fixture");
  await vault.commitReconcileManifest((await vault.reconcile()).manifest!);
  const baseline = structuredClone(stored);
  entries = [{ ...original, mtime: 2, size: 2 }];
  fail = true;
  expect(await vault.reconcile()).toMatchObject({ status: "partial", changes: [] });
  expect(vault.getFiles().map(file => file.path)).toEqual(["Existing.md"]);
  expect(stored).toEqual(baseline);
  fail = false;
  expect((await vault.reconcile()).changes).toMatchObject([{ event: "modify", path: "Existing.md" }]);
  expect(stored).toEqual(baseline);
});

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

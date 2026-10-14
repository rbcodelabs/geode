import { describe, expect, it } from "vitest";
import { createBrowserHost, createBrowserHostState, type BrowserHostStorage } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import { withDurableMobileStorage } from "../../src/renderer/host/mobile-storage";
import { buildVaultManifest } from "../../src/renderer/reconciliation";
import { Vault } from "../../src/renderer/vault";
import { vaultRefreshFailure, vaultRefreshPresentation } from "../../src/shared/vault-refresh";
import { FakeManagedVault } from "../helpers/fake-managed-vault";
import { fakeIdb } from "../helpers/fake-idb";

/**
 * iOS WKWebView caps localStorage at about 5 MB. The browser host snapshots ALL of its state (settings, workspace,
 * every config key, the metadata cache) into one localStorage value, so a vault-sized reconcile manifest in that
 * snapshot tips it over the cap. A TestFlight report (v0.30.2) showed "Operation: save-manifest, Error code: UNKNOWN".
 * The cap is scaled down here so a few thousand entries reproduce what tens of thousands do on a device.
 */
const QUOTA_CHARS = 200_000;

function quotaStorage(): BrowserHostStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      const total = [...values].reduce((sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length), 0) + key.length + value.length;
      if (total > QUOTA_CHARS) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      values.set(key, value);
    },
  };
}

function bigManifest(root: string, count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    path: `Projects/Area ${i % 40}/Meeting notes for the quarterly review ${i}.md`, isFolder: false, mtime: 1_700_000_000_000 + i, ctime: 1_700_000_000_000, size: 1000 + i,
  }));
  return buildVaultManifest(root, entries);
}

async function phone(storage = quotaStorage(), idb = fakeIdb()) {
  const native = new FakeManagedVault("managed://default");
  const portable = createBrowserHost(createBrowserHostState({ storage }));
  const host = withDurableMobileStorage(createCapacitorHost(native.plugin, portable), idb);
  const vault = new Vault(host);
  await vault.open("managed://default");
  return { host, vault, storage, idb, portable };
}

describe("save-manifest on a phone whose localStorage snapshot is full", () => {
  it("reproduces the report: the plain browser-host config write fails with a quota error that shows as UNKNOWN", async () => {
    const storage = quotaStorage();
    const portable = createBrowserHost(createBrowserHostState({ storage }));
    await portable.vaultRegistry.openVault("managed://default");
    const failure = await portable.config.write("device-reconcile:x", bigManifest("managed://default", 3000)).catch(error => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("QuotaExceededError");
    // Before the fix this classified as code UNKNOWN: nothing in the diagnostics named the cause.
    expect(vaultRefreshFailure(failure, "save-manifest").code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("does not poison later writes: a rejected snapshot write is rolled back, not left in memory", async () => {
    const storage = quotaStorage();
    const portable = createBrowserHost(createBrowserHostState({ storage }));
    await portable.vaultRegistry.openVault("managed://default");
    await expect(portable.config.write("device-reconcile:x", bigManifest("managed://default", 3000))).rejects.toThrow();
    await expect(portable.config.write("app", { theme: "dark" })).resolves.toBeUndefined();
    expect(await portable.config.read("device-reconcile:x")).toBeNull();
  });

  it("commits the manifest to IndexedDB instead, and a relaunch reads it back", async () => {
    const first = await phone();
    const manifest = bigManifest(first.vault.root, 3000);
    await first.vault.commitReconcileManifest(manifest);
    // Settings keep working in the same (small) localStorage snapshot.
    await expect(first.host.config.write("app", { theme: "dark" })).resolves.toBeUndefined();

    const second = await phone(first.storage, first.idb);
    expect(second.vault.needsInitialReconcile()).toBe(true);
    expect(await second.host.config.read(`device-reconcile:${encodeURIComponent(second.vault.root)}`)).toEqual(manifest);
  });

  it("moves a legacy localStorage manifest to IndexedDB on the next commit and frees the snapshot", async () => {
    const storage = quotaStorage();
    const portable = createBrowserHost(createBrowserHostState({ storage }));
    await portable.vaultRegistry.openVault("managed://default");
    const key = `device-reconcile:${encodeURIComponent("managed://default")}`;
    await portable.config.write(key, bigManifest("managed://default", 300));
    const before = storage.values.get("geode:mobile-managed-vault:v1")!.length;

    const native = new FakeManagedVault("managed://default");
    const host = withDurableMobileStorage(createCapacitorHost(native.plugin, portable), fakeIdb());
    expect(await host.config.read(key)).toMatchObject({ version: 1 });
    await host.config.write(key, bigManifest("managed://default", 3000));
    expect(storage.values.get("geode:mobile-managed-vault:v1")!.length).toBeLessThan(before);
    expect(Object.keys((await host.config.read(key) as { entries: object }).entries)).toHaveLength(3000);
  });

  it("only moves the derived reconcile manifest; other config keys stay where sync-safety also reads them", async () => {
    const { host, portable } = await phone();
    await host.config.write("app", { theme: "dark" });
    expect(await portable.config.read("app")).toEqual({ theme: "dark" });
  });
});

describe("Vault.commitReconcileManifest", () => {
  it("a rejected snapshot write leaves the prior baseline, so Retry can succeed once space is available", async () => {
    const storage = quotaStorage();
    const native = new FakeManagedVault("managed://default");
    const portable = createBrowserHost(createBrowserHostState({ storage }));
    const vault = new Vault(createCapacitorHost(native.plugin, portable));
    await vault.open("managed://default");
    const manifest = bigManifest(vault.root, 3000);
    await expect(vault.commitReconcileManifest(manifest)).rejects.toMatchObject({ name: "QuotaExceededError" });
    await expect(portable.config.write("app", { ok: true })).resolves.toBeUndefined();
  });

  it("still rejects a manifest that belongs to another vault", async () => {
    const { vault } = await phone();
    await expect(vault.commitReconcileManifest(bigManifest("managed://other", 1))).rejects.toThrow("different vault");
  });
});

describe("refresh failure diagnostics", () => {
  it.each([
    [new DOMException("The quota has been exceeded.", "QuotaExceededError"), "STORAGE_QUOTA_EXCEEDED"],
    [Object.assign(new Error("x"), { name: "QuotaExceededError" }), "STORAGE_QUOTA_EXCEEDED"],
    [{ code: 22, name: "QuotaExceededError" }, "STORAGE_QUOTA_EXCEEDED"],
    [Object.assign(new Error("denied"), { code: "UNIMPLEMENTED" }), "UNIMPLEMENTED"],
  ])("names the cause category for %#", (error, code) => {
    expect(vaultRefreshFailure(error, "save-manifest")).toMatchObject({ operation: "save-manifest", code });
  });

  it("carries a safe error-type tag for unknown errors and never the message, stack, or path", () => {
    const error = new TypeError("Cannot read /Users/me/Private/Secret note.md: my secret content");
    const failure = vaultRefreshFailure(error, "save-manifest", "Private/Secret note.md");
    expect(failure).toMatchObject({ code: "UNKNOWN", cause: "TypeError" });
    const presented = vaultRefreshPresentation("unavailable", failure, { version: "1", savesPaused: false });
    // The on-screen "Path in vault" row is the existing, deliberate vault-relative display; the copied report redacts it.
    const copied = presented.report;
    expect(JSON.stringify(presented)).toContain("TypeError");
    for (const leak of ["Secret", "/Users/me", "my secret content", "Cannot read"]) expect(JSON.stringify(presented).replaceAll("Private/Secret note.md", "")).not.toContain(leak);
    expect(copied).not.toContain("Private");
    expect(presented.report).toContain("Cause: TypeError");
  });

  it("drops a hostile error name rather than echoing it", () => {
    const error = Object.assign(new Error("x"), { name: "Note: my secret / content" });
    expect(vaultRefreshFailure(error, "save-manifest").cause).toBeUndefined();
  });

  it("explains a full storage cache in plain words", () => {
    const failure = vaultRefreshFailure(new DOMException("q", "QuotaExceededError"), "save-manifest");
    expect(vaultRefreshPresentation("unavailable", failure, { version: "1", savesPaused: false }).message).toMatch(/storage/i);
  });
});

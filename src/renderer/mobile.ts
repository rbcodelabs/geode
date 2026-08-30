import { Capacitor } from "@capacitor/core";
import { createBrowserHost, createBrowserHostState } from "./host/browser-host";
import { createCapacitorHost, GeodeManagedVault } from "./host/capacitor-host";
import { createLegacyGeodeFacade } from "./host/legacy-facade";
import { installHostServices } from "./host/registry";
import { VaultAccessError } from "./host/contracts";

const state = createBrowserHostState({ storage: window.localStorage });
const externalProofEnabled = new URLSearchParams(location.search).get("external-vault-proof") === "1";
const externalStorage = {
  getItem: (key: string) => window.localStorage.getItem(`geode:external-proof:${key}`),
  setItem: (key: string, value: string) => window.localStorage.setItem(`geode:external-proof:${key}`, value),
};
const externalState = externalProofEnabled
  ? createBrowserHostState({
      vaultName: "Provider Vault",
      files: {
        "Notes/Proof.md": "provider-bytes",
        "Views/Proof.base": "views:\n  - type: table\n    name: Default\n",
        "Boards/Proof.canvas": JSON.stringify({
          nodes: [
            { id: "alpha", type: "text", x: 40, y: 40, width: 180, height: 100, text: "Alpha", color: "2" },
            { id: "beta", type: "text", x: 300, y: 80, width: 180, height: 100, text: "Beta", color: "4" },
          ],
          edges: [],
        }),
        "Assets/blob.bin": "initial-binary",
        "Notes/Linked.md": "Linked to [[Proof]]",
        "Notes/Orphan.md": "No links here",
      },
      storage: externalStorage,
    })
  : undefined;
const secondExternalState = externalProofEnabled
  ? createBrowserHostState({
      vaultName: "Second Provider",
      files: { "Notes/Second.md": "second-provider-bytes" },
      storage: {
        getItem: (key: string) => window.localStorage.getItem(`geode:external-proof-second:${key}`),
        setItem: (key: string, value: string) => window.localStorage.setItem(`geode:external-proof-second:${key}`, value),
      },
    })
  : undefined;
const mobileTest = {
  writeDelayMs: 0,
  failNextWrite: false,
  externalAccess: "ready" as "ready" | "missing",
  reconnectResult: "cancel" as "cancel" | "error" | "success",
  activeListeners: 0,
  reconcileStatus: "complete" as "complete" | "partial" | "cancelled" | "unavailable",
  reconcileDelayMs: 0,
  failConflictCopy: false,
  reconcileTrace: [] as string[],
  pluginReads: [] as string[],
  listenerCount: () => mobileTest.activeListeners,
  externalWrite: (path: string, data: string) => {
    if (!externalState) return;
    const prior = externalState.files.get(path);
    const timestamp = ++externalState.clock;
    externalState.files.set(path, { data, ctime: prior?.ctime ?? timestamp, mtime: timestamp });
    externalState.persist();
  },
  externalDelete: (path: string) => {
    externalState?.files.delete(path);
    externalState?.persist();
  },
  externalDeleteFolder: (path: string) => {
    if (!externalState) return;
    for (const candidate of [...externalState.files.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) externalState.files.delete(candidate);
    }
    externalState.persist();
  },
  background: () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  },
  foreground: () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  },
};
if (externalProofEnabled) {
  (window as unknown as { __geodeMobileTest: typeof mobileTest }).__geodeMobileTest = mobileTest;
}
const browserHost = createBrowserHost(state, {
  registryStorage: window.localStorage,
  externalVault: externalState
    ? { id: "external://browser-provider-proof", state: externalState }
    : undefined,
  additionalVaults: secondExternalState
    ? [{ id: "external://browser-provider-second", state: secondExternalState }]
    : undefined,
  beforeWrite: async (_vaultId, path) => {
    const delay = mobileTest.writeDelayMs;
    mobileTest.writeDelayMs = 0;
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    if (mobileTest.failNextWrite) {
      mobileTest.failNextWrite = false;
      throw new Error("Injected browser write failure");
    }
    if (mobileTest.failConflictCopy && path.includes("Geode conflict")) {
      mobileTest.failConflictCopy = false;
      throw new Error("Injected conflict copy failure");
    }
    mobileTest.reconcileTrace.push(`write:${path}`);
  },
  onPluginFileRead: (path) => mobileTest.pluginReads.push(path),
  checkVault: async (id) => {
    if (id.startsWith("external://") && mobileTest.externalAccess === "missing") {
      throw new VaultAccessError("Provider Vault is missing", "VAULT_MISSING", id, "Provider Vault", "missing");
    }
  },
  reconnectVault: async (id) => {
    if (mobileTest.reconnectResult === "cancel") return false;
    if (mobileTest.reconnectResult === "error") {
      throw new VaultAccessError("The provider remains unavailable", "VAULT_UNAVAILABLE", id, "Provider Vault", "unavailable");
    }
    mobileTest.externalAccess = "ready";
    return true;
  },
  onListenerCountChange: (count) => { mobileTest.activeListeners = count; },
  reconcileScan: async (_id, entries) => {
    const delay = mobileTest.reconcileDelayMs;
    mobileTest.reconcileDelayMs = 0;
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    mobileTest.reconcileTrace.push("scan");
    return { status: mobileTest.reconcileStatus, entries };
  },
});
const host = installHostServices(Capacitor.isNativePlatform()
  ? createCapacitorHost(GeodeManagedVault, browserHost)
  : browserHost);

// Compatibility is deliberately installed only after the portable host. New
// shared code consumes HostServices; legacy plugin/renderer paths can migrate
// incrementally without pretending that mobile has desktop capabilities.
window.geode = createLegacyGeodeFacade(host);
document.body.classList.add("is-mobile");

void import("./app");

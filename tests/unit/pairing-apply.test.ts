import { describe, expect, it } from "vitest";
import { applyPairingBundle, assertCanStoreCredential, buildPairingBundle, type ApplyPorts } from "../../src/renderer/pairing/apply";
import { runPairingFlow } from "../../src/renderer/pairing/flow";
import { hubTokenKey, type HubConfig } from "../../src/shared/hub-sync";
import { PAIRING_PROVIDER_HUB, type PairingBundle } from "../../src/shared/pairing/bundle";
import { sha256Hex } from "../../src/sync-core/ports";
import { serializePortableConfig, projectPortableConfig } from "../../src/shared/portable-config";
import { DEFAULT_SYNC_SCOPE } from "../../src/renderer/sync/scope";
import { encodeInvitation } from "../../src/shared/pairing/invitation";
import { b64uEncode, randomBytes } from "../../src/shared/pairing/crypto";

const URL_ = "https://hub.example.ts.net/";
const bundle = (over: Partial<PairingBundle> = {}): PairingBundle => ({ v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: URL_ } }, vault: { id: "123e4567-e89b-42d3-a456-426614174000", name: "Personal" },
  portable: { editor: { readableLineLength: false, foldHeading: true, showLineNumber: true, showRibbon: true, showStatusBar: false }, appearance: { theme: "dark", baseFontSize: 18, cssTheme: "" } },
  credential: { scheme: "bearer", value: "hub-secret" }, from: "Mac", ...over });

function ports(over: { secretsAvailable?: boolean; failSetConfig?: boolean; lease?: string | null; failApply?: string; app?: unknown; initial?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(over.initial ?? {}));
  let config: HubConfig | null = null;
  const calls: string[] = []; const applied: Array<{ path: string; expectedHash: string | null; data?: ArrayBuffer; namespace?: string }> = [];
  const secrets = { available: over.secretsAvailable ?? true, get: async (k: string) => store.get(k) ?? null, remove: async (k: string) => { store.delete(k); calls.push("secret.remove"); } };
  const result: ApplyPorts = {
    secrets,
    hub: {
      canStoreToken: over.secretsAvailable ?? true,
      getConfig: async () => config, clearConfig: async () => { config = null; calls.push("config.clear"); },
      setConfig: async c => { if (over.failSetConfig) throw new Error("boom"); config = c; calls.push("config.set"); },
      setToken: async (url, token) => { store.set(hubTokenKey(url), token); calls.push("token.set"); },
    },
    config: { read: async name => name === "app" ? (over.app ?? { readableLineLength: true }) : null },
    syncSafety: { claimOwner: async () => over.lease === undefined ? "lease-1" : over.lease, releaseOwner: async () => { calls.push("release"); },
      apply: async (_t, input) => { if (over.failApply && input.path === over.failApply) throw new Error("Portable settings changed before application"); applied.push({ path: input.path, expectedHash: input.expectedHash, data: input.data, namespace: input.namespace }); return { status: "applied", hash: null, recoveryPath: "" }; } },
    reloadSettings: async () => { calls.push("reload"); },
  };
  return { ports: result, store, calls, applied, getConfig: () => config };
}

describe("applyPairingBundle", () => {
  it("stores the token, saves config and applies portable categories through the guarded portable-config path", async () => {
    const p = ports(); const report = await applyPairingBundle(bundle(), p.ports);
    expect(p.store.get(hubTokenKey(URL_))).toBe("hub-secret");
    expect(p.getConfig()).toEqual({ schema: 1, target: { kind: "http", url: URL_ }, create: false });
    expect(report).toMatchObject({ credentialStored: true, configSaved: true, applied: ["editor", "appearance"], skipped: [] });
    expect(p.applied.map(a => [a.namespace, a.path])).toEqual([["portable-config", "editor.json"], ["portable-config", "appearance.json"]]);
    expect(p.calls).toContain("reload"); expect(p.calls.filter(c => c === "release")).toHaveLength(1);
  });
  it("uses the real local projection hash as the preimage guard", async () => {
    const app = { readableLineLength: true, foldHeading: false, showLineNumber: false, showRibbon: true, showStatusBar: true, extra: "ignored" };
    const p = ports({ app }); await applyPairingBundle(bundle(), p.ports);
    const [doc] = await projectPortableConfig({ read: async () => app }, { ...DEFAULT_SYNC_SCOPE, mainSettings: true });
    expect(p.applied[0].expectedHash).toBe(await sha256Hex(serializePortableConfig(doc)));
  });
  it("skips only the category whose guard fails, keeping credential and config", async () => {
    const p = ports({ failApply: "editor.json" }); const report = await applyPairingBundle(bundle(), p.ports);
    expect(report.applied).toEqual(["appearance"]); expect(report.skipped).toEqual([{ category: "editor", reason: "Settings changed while pairing." }]);
    expect(report.credentialStored && report.configSaved).toBe(true);
  });
  it("skips every category when the owner lease is unavailable, never forcing a write", async () => {
    const p = ports({ lease: null }); const report = await applyPairingBundle(bundle(), p.ports);
    expect(p.applied).toEqual([]); expect(report.skipped.map(s => s.category)).toEqual(["editor", "appearance"]); expect(p.calls).not.toContain("reload");
  });
  it("treats already-equal settings as applied without a write", async () => {
    const same = bundle({ portable: { editor: { readableLineLength: true, foldHeading: true, showLineNumber: false, showRibbon: true, showStatusBar: true } } });
    const p = ports({ app: {} }); const report = await applyPairingBundle(same, p.ports);
    expect(report.applied).toEqual(["editor"]); expect(p.applied).toEqual([]);
  });
  it("fails closed without secure storage: nothing stored, nothing configured", async () => {
    const p = ports({ secretsAvailable: false });
    await expect(applyPairingBundle(bundle(), p.ports)).rejects.toMatchObject({ code: "secure-storage-unavailable" });
    expect(p.store.size).toBe(0); expect(p.getConfig()).toBeNull(); expect(p.calls).toEqual([]);
    expect(() => assertCanStoreCredential(p.ports)).toThrow(/securely/);
  });
  it("rolls back the token and config when saving config fails, restoring a previous token", async () => {
    const fresh = ports({ failSetConfig: true });
    await expect(applyPairingBundle(bundle(), fresh.ports)).rejects.toThrow("boom");
    expect(fresh.store.size).toBe(0);
    const prior = ports({ failSetConfig: true, initial: { [hubTokenKey(URL_)]: "old-token" } });
    await expect(applyPairingBundle(bundle(), prior.ports)).rejects.toThrow("boom");
    expect(prior.store.get(hubTokenKey(URL_))).toBe("old-token");
  });
  it("derives the Keychain key from the URL, never from payload content", async () => {
    const p = ports(); await applyPairingBundle(bundle({ provider: { id: PAIRING_PROVIDER_HUB, config: { url: "https://other.example.com:8443/x" } } }), p.ports);
    expect([...p.store.keys()]).toEqual(["hub-token/other.example.com:8443"]);
  });
  it("handles a bundle with no credential and no portable settings", async () => {
    const p = ports(); const report = await applyPairingBundle(bundle({ credential: null, portable: {} }), p.ports);
    expect(report).toMatchObject({ credentialStored: false, configSaved: true, applied: [] }); expect(p.store.size).toBe(0);
  });
});

describe("buildPairingBundle (desktop)", () => {
  const sources = (cfg: HubConfig | null, token: string | null, available = true) => ({
    hub: { getConfig: async () => cfg }, secrets: { available, get: async () => token },
    config: { read: async (n: string) => n === "app" ? { readableLineLength: false, theme: "light", plugins: ["secret-plugin"], apiKey: "nope" } : n === "daily-notes" ? { folder: "Daily" } : null },
    vault: () => ({ id: "123e4567-e89b-42d3-a456-426614174000", name: "Personal" }),
  });
  it("bundles provider config, vault, projected portable settings and the credential, and nothing else", async () => {
    const { bundle: b, hasCredential } = await buildPairingBundle(sources({ schema: 1, target: { kind: "http", url: URL_ }, create: false }, "tok"));
    expect(hasCredential).toBe(true); expect(b.credential).toEqual({ scheme: "bearer", value: "tok" });
    expect(b.portable.editor?.readableLineLength).toBe(false); expect(b.portable.appearance?.theme).toBe("light"); expect(b.portable.dailyNotes?.folder).toBe("Daily");
    expect(JSON.stringify(b)).not.toMatch(/secret-plugin|apiKey|nope/);
    expect(Object.keys(b)).toEqual(["v", "provider", "vault", "portable", "credential", "from"]);
  });
  it("refuses folder/ssh/no hub; tolerates a missing token", async () => {
    await expect(buildPairingBundle(sources({ schema: 1, target: { kind: "fs", path: "/x" }, create: false }, "t"))).rejects.toMatchObject({ code: "unsupported-provider" });
    await expect(buildPairingBundle(sources(null, "t"))).rejects.toMatchObject({ code: "unsupported-provider" });
    const none = await buildPairingBundle(sources({ schema: 1, target: { kind: "http", url: URL_ }, create: false }, null, false));
    expect(none.bundle.credential).toBeNull(); expect(none.hasCredential).toBe(false);
  });
});

describe("runPairingFlow", () => {
  const text = () => encodeInvitation({ sessionId: b64uEncode(randomBytes(16)), token: b64uEncode(randomBytes(16)), fingerprint: b64uEncode(randomBytes(16)), expiresAt: Math.floor(Date.now() / 1000) + 120, addresses: ["192.168.1.2:5000"] });
  it("never redeems when secure storage is missing (the token is not spent)", async () => {
    let redeemed = 0; const p = ports({ secretsAvailable: false });
    await expect(runPairingFlow(text(), { ports: p.ports, confirm: async () => true, redeem: async () => { redeemed++; return { bundle: bundle(), address: "" }; } })).rejects.toMatchObject({ code: "secure-storage-unavailable" });
    expect(redeemed).toBe(0);
  });
  it("rejects a bad invitation before any network", async () => {
    let redeemed = 0;
    await expect(runPairingFlow("nonsense", { ports: ports().ports, confirm: async () => true, redeem: async () => { redeemed++; return { bundle: bundle(), address: "" }; } })).rejects.toMatchObject({ code: "invalid-invitation" });
    expect(redeemed).toBe(0);
  });
  it("declining the confirmation writes nothing", async () => {
    const p = ports(); let shown: PairingBundle | undefined;
    const outcome = await runPairingFlow(text(), { ports: p.ports, confirm: async b => { shown = b; return false; }, redeem: async () => ({ bundle: bundle(), address: "" }) });
    expect(outcome).toEqual({ status: "declined" }); expect(shown?.vault?.name).toBe("Personal");
    expect(p.store.size).toBe(0); expect(p.getConfig()).toBeNull(); expect(p.applied).toEqual([]); expect(p.calls).toEqual([]);
  });
  it("applies only after confirmation, in order", async () => {
    const p = ports(); const steps: string[] = [];
    const outcome = await runPairingFlow(text(), { ports: p.ports, onStep: s => steps.push(s), confirm: async () => { expect(p.store.size).toBe(0); return true; }, redeem: async () => ({ bundle: bundle(), address: "" }) });
    expect(outcome.status).toBe("applied"); expect(steps).toEqual(["checking", "connecting", "confirming", "applying"]); expect(p.store.size).toBe(1);
  });
  it("honours the precheck (another provider active)", async () => {
    await expect(runPairingFlow(text(), { ports: ports().ports, precheck: () => "busy", confirm: async () => true, redeem: async () => ({ bundle: bundle(), address: "" }) })).rejects.toMatchObject({ code: "unsupported-provider" });
  });
});

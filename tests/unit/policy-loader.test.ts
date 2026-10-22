import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEffectivePolicy, loadManagedPolicy, loadVaultPolicy, policyFilePath } from "../../src/main/policy-loader";
import { isPluginBlockedEffective } from "../../src/renderer/policy-layering";

let dir: string;
let machineFile: string;
let vaultRoot: string;
const saved = process.env.GEODE_POLICY_PATH;

const writeMachine = (value: unknown) => fs.writeFileSync(machineFile, typeof value === "string" ? value : JSON.stringify(value));
const writeVault = (value: unknown) => {
  fs.mkdirSync(path.join(vaultRoot, ".geode"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, ".geode", "policy.json"), typeof value === "string" ? value : JSON.stringify(value));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-loader-"));
  machineFile = path.join(dir, "managed-policy.json");
  vaultRoot = path.join(dir, "vault");
  fs.mkdirSync(vaultRoot);
  process.env.GEODE_POLICY_PATH = machineFile;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.GEODE_POLICY_PATH;
  else process.env.GEODE_POLICY_PATH = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("policyFilePath", () => {
  it("honors GEODE_POLICY_PATH", () => {
    expect(policyFilePath()).toBe(machineFile);
  });
});

describe("loadManagedPolicy", () => {
  it("fails open when the file is missing", () => {
    expect(loadManagedPolicy()).toBeNull();
  });
  it("fails open on invalid JSON", () => {
    writeMachine("{not json");
    expect(loadManagedPolicy()).toBeNull();
  });
  it("reads fresh on every call (no cache)", () => {
    writeMachine({ policyVersion: 1, sync: { enabled: false } });
    expect(loadManagedPolicy()?.sync?.enabled).toBe(false);
    writeMachine({ policyVersion: 1 });
    expect(loadManagedPolicy()?.sync).toBeUndefined();
  });
});

describe("loadVaultPolicy", () => {
  it("fails open when the vault has no policy file or no vault is open", () => {
    expect(loadVaultPolicy(vaultRoot, null)).toBeNull();
    expect(loadVaultPolicy(null, null)).toBeNull();
  });
  it("fails open on invalid JSON, a directory, a wrong policyVersion, or an oversized file", () => {
    writeVault("[[[");
    expect(loadVaultPolicy(vaultRoot, null)).toBeNull();
    writeVault({ policyVersion: 9 });
    expect(loadVaultPolicy(vaultRoot, null)).toBeNull();
    writeVault(JSON.stringify({ policyVersion: 1, note: "x".repeat(2 * 1024 * 1024) }));
    expect(loadVaultPolicy(vaultRoot, null)).toBeNull();
    fs.rmSync(path.join(vaultRoot, ".geode", "policy.json"));
    fs.mkdirSync(path.join(vaultRoot, ".geode", "policy.json"));
    expect(loadVaultPolicy(vaultRoot, null)).toBeNull();
  });
  it("reads a valid vault policy, fresh each call", () => {
    writeVault({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["x"] } });
    expect(loadVaultPolicy(vaultRoot, null)?.plugins?.ids).toEqual(["x"]);
    writeVault({ policyVersion: 1 });
    expect(loadVaultPolicy(vaultRoot, null)?.plugins).toBeUndefined();
  });
  it("is not read at all when the machine policy says vaultPolicy: ignore", () => {
    writeVault({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["x"] } });
    const spy = vi.spyOn(fs, "readFileSync");
    expect(loadVaultPolicy(vaultRoot, { policyVersion: 1, vaultPolicy: "ignore" })).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).endsWith("policy.json"))).toBe(false);
  });
});

describe("loadEffectivePolicy", () => {
  it("no files anywhere: baseline, nothing restricted", () => {
    const r = loadEffectivePolicy(vaultRoot);
    expect(r.machine).toBeNull();
    expect(r.vault).toBeNull();
    expect(r.provenance).toEqual({});
    expect(isPluginBlockedEffective(r.effective, "anything")).toBe(false);
  });
  it("merges both layers and reports provenance", () => {
    writeMachine({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["m"] } });
    writeVault({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["v"] }, sync: { enabled: false } });
    const r = loadEffectivePolicy(vaultRoot);
    expect(isPluginBlockedEffective(r.effective, "m")).toBe(true);
    expect(isPluginBlockedEffective(r.effective, "v")).toBe(true);
    expect(r.effective.sync.enabled).toBe(false);
    expect(r.provenance.plugins).toEqual(["machine", "vault"]);
    expect(r.provenance["sync.enabled"]).toEqual(["vault"]);
  });
  it("machine vaultPolicy: ignore returns vault: null and ignores the file", () => {
    writeMachine({ policyVersion: 1, vaultPolicy: "ignore" });
    writeVault({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["v"] } });
    const r = loadEffectivePolicy(vaultRoot);
    expect(r.vault).toBeNull();
    expect(isPluginBlockedEffective(r.effective, "v")).toBe(false);
  });
  it("a window with no vault open gets the machine layer alone", () => {
    writeMachine({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["m"] } });
    const r = loadEffectivePolicy(null);
    expect(r.vault).toBeNull();
    expect(isPluginBlockedEffective(r.effective, "m")).toBe(true);
  });
  it("result is plain JSON-serializable data (it crosses IPC)", () => {
    writeVault({ policyVersion: 1, sync: { enabled: false } });
    const r = loadEffectivePolicy(vaultRoot);
    expect(JSON.parse(JSON.stringify(r)).effective.sync.enabled).toBe(false);
  });
});

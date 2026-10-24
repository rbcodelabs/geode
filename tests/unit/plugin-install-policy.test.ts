import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_INSTALL_ACTIONS,
  PluginInstallBlockedError,
  decidePluginInstall,
  guardPluginInstall,
  matchesInstallSource,
  repoFromSpec,
  repoPassesSources,
  type PluginInstallAction,
} from "../../src/main/plugin-install-policy";
import { resolveEffectivePolicy, isPluginBlockedEffective } from "../../src/renderer/policy-layering";
import { validatePolicy, type ManagedPolicy } from "../../src/renderer/policy";
import { installControlState } from "../../src/renderer/community/install-policy-ui";

const P = (raw: unknown): ManagedPolicy => validatePolicy({ policyVersion: 1, ...(raw as object) })!;
const eff = (machine: unknown, vault?: unknown) =>
  resolveEffectivePolicy(machine ? P(machine) : null, vault ? P(vault) : null).effective;

const ref = (owner: string, repo: string) => ({ owner, repo });
const ALL = PLUGIN_INSTALL_ACTIONS;
const allowed = (policy: ReturnType<typeof eff> | null, action: PluginInstallAction, r?: { owner: string; repo: string } | null) =>
  decidePluginInstall(policy, action, r).allowed;

describe("matchesInstallSource", () => {
  it("matches owner/repo exactly and case-insensitively, with or without github.com", () => {
    expect(matchesInstallSource("acme/tool", ref("acme", "tool"))).toBe(true);
    expect(matchesInstallSource("github.com/acme/tool", ref("Acme", "TOOL"))).toBe(true);
    expect(matchesInstallSource("GitHub.com/acme/tool", ref("acme", "tool"))).toBe(true);
    expect(matchesInstallSource("acme/tool", ref("acme", "other"))).toBe(false);
    expect(matchesInstallSource("acme/tool", ref("evil", "tool"))).toBe(false);
  });
  it("owner/* matches any repo of exactly that owner, nothing else", () => {
    expect(matchesInstallSource("github.com/acme/*", ref("acme", "anything"))).toBe(true);
    expect(matchesInstallSource("acme/*", ref("acme", "anything"))).toBe(true);
    expect(matchesInstallSource("acme/*", ref("acme-evil", "x"))).toBe(false);
    expect(matchesInstallSource("acme/*", ref("evil", "acme"))).toBe(false);
  });
  it("github.com/* is every GitHub repository", () => {
    expect(matchesInstallSource("github.com/*", ref("any", "thing"))).toBe(true);
  });
  it("never matches another host, extra segments, or the fail-closed sentinel", () => {
    expect(matchesInstallSource("gitlab.com/acme/tool", ref("acme", "tool"))).toBe(false);
    expect(matchesInstallSource("github.com/acme/tool/sub", ref("acme", "tool"))).toBe(false);
    expect(matchesInstallSource("acme/tool/*", ref("acme", "tool"))).toBe(false);
    expect(matchesInstallSource("!none", ref("acme", "tool"))).toBe(false);
    expect(matchesInstallSource("acme", ref("acme", "tool"))).toBe(false);
  });
  it("does not treat * as a prefix/suffix glob (the validator rejects those; matching agrees)", () => {
    expect(matchesInstallSource("acme/tool-*", ref("acme", "tool-a"))).toBe(false);
  });
});

describe("repoPassesSources", () => {
  it("absent lists restrict nothing; an empty list admits nothing", () => {
    expect(repoPassesSources(undefined, ref("a", "b"))).toBe(true);
    expect(repoPassesSources([[]], ref("a", "b"))).toBe(false);
  });
  it("every layer's list must admit the repo", () => {
    const lists = [["acme/*"], ["acme/approved"]];
    expect(repoPassesSources(lists, ref("acme", "approved"))).toBe(true);
    expect(repoPassesSources(lists, ref("acme", "other"))).toBe(false);
  });
});

describe("decidePluginInstall", () => {
  it("allows everything with no policy (fail open) and with mode allowed", () => {
    for (const a of ALL) {
      expect(allowed(null, a)).toBe(true);
      expect(allowed(eff(undefined), a)).toBe(true);
      expect(allowed(eff({ pluginInstall: { mode: "allowed" } }), a)).toBe(true);
    }
  });

  it("disabled refuses every entry point", () => {
    const p = eff({ pluginInstall: { mode: "disabled" } });
    for (const a of ALL) expect(allowed(p, a, ref("acme", "x"))).toBe(false);
  });

  it("catalog-only permits only the catalog list and install", () => {
    const p = eff({ pluginInstall: { mode: "catalog-only" } });
    expect(allowed(p, "supported-plugin-catalog")).toBe(true);
    expect(allowed(p, "supported-plugin-install", ref("rbcodelabs", "x"))).toBe(true);
    expect(allowed(p, "community-install", ref("acme", "x"))).toBe(false);
    expect(allowed(p, "community-resolve", ref("acme", "x"))).toBe(false);
    expect(allowed(p, "community-import-obsidian")).toBe(false);
    expect(allowed(p, "plugin-files-replace")).toBe(false);
  });

  it("allowed + sources restricts repo-carrying actions, resolved before any fetch", () => {
    const p = eff({ pluginInstall: { mode: "allowed", sources: ["github.com/acme/*"] } });
    expect(allowed(p, "community-install", ref("acme", "x"))).toBe(true);
    expect(allowed(p, "community-resolve", ref("acme", "x"))).toBe(true);
    expect(allowed(p, "community-install", ref("evil", "x"))).toBe(false);
    expect(allowed(p, "community-resolve", ref("evil", "x"))).toBe(false);
    expect(allowed(p, "supported-plugin-install", ref("evil", "x"))).toBe(false);
    // The catalog listing is not an install; Obsidian import and file replace carry no repo.
    expect(allowed(p, "supported-plugin-catalog")).toBe(true);
    expect(allowed(p, "community-import-obsidian")).toBe(true);
    expect(allowed(p, "plugin-files-replace")).toBe(true);
  });

  it("refuses rather than guesses when sources is set and the repo is unknown", () => {
    const p = eff({ pluginInstall: { mode: "allowed", sources: ["acme/*"] } });
    expect(allowed(p, "community-install", null)).toBe(false);
  });

  it("an all-invalid sources list fails closed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = eff({ pluginInstall: { mode: "allowed", sources: ["*/x", "a b"] } });
    expect(allowed(p, "community-install", ref("acme", "x"))).toBe(false);
    vi.restoreAllMocks();
  });

  it("the vault can only narrow", () => {
    const widen = eff({ pluginInstall: { mode: "disabled" } }, { pluginInstall: { mode: "allowed" } });
    expect(allowed(widen, "community-install", ref("acme", "x"))).toBe(false);
    const narrowMode = eff({ pluginInstall: { mode: "allowed" } }, { pluginInstall: { mode: "catalog-only" } });
    expect(allowed(narrowMode, "community-install", ref("acme", "x"))).toBe(false);
    const narrowSources = eff(
      { pluginInstall: { mode: "allowed", sources: ["acme/*"] } },
      { pluginInstall: { mode: "allowed", sources: ["acme/approved"] } },
    );
    expect(allowed(narrowSources, "community-install", ref("acme", "approved"))).toBe(true);
    expect(allowed(narrowSources, "community-install", ref("acme", "other"))).toBe(false);
  });

  it("composes with `plugins`: install state and execution state are independent", () => {
    // Install allowed while execution is gated.
    const execGated = eff({ plugins: { mode: "allowlist", ids: [] }, pluginInstall: { mode: "allowed" } });
    expect(allowed(execGated, "community-install", ref("acme", "x"))).toBe(true);
    expect(isPluginBlockedEffective(execGated, "some-plugin")).toBe(true);
    // Install disabled while an allowlisted plugin may still run.
    const installOff = eff({ plugins: { mode: "allowlist", ids: ["some-plugin"] }, pluginInstall: { mode: "disabled" } });
    expect(allowed(installOff, "community-install", ref("acme", "x"))).toBe(false);
    expect(isPluginBlockedEffective(installOff, "some-plugin")).toBe(false);
  });
});

describe("repoFromSpec", () => {
  it("normalises URLs, .git and case-preserved specs before any network I/O", () => {
    expect(repoFromSpec("https://github.com/Acme/Tool.git")).toEqual({ owner: "Acme", repo: "Tool" });
    expect(repoFromSpec("acme/tool")).toEqual({ owner: "acme", repo: "tool" });
  });
  it("returns null for junk", () => {
    expect(repoFromSpec("not a repo")).toBeNull();
    expect(repoFromSpec(42)).toBeNull();
    expect(repoFromSpec("")).toBeNull();
  });
});

describe("guardPluginInstall (what each IPC handler calls first)", () => {
  let dir: string;
  let machineFile: string;
  let vaultRoot: string;
  const saved = process.env.GEODE_POLICY_PATH;
  const writeMachine = (v: unknown) => fs.writeFileSync(machineFile, typeof v === "string" ? v : JSON.stringify(v));
  const writeVault = (v: unknown) => {
    fs.mkdirSync(path.join(vaultRoot, ".geode"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, ".geode", "policy.json"), JSON.stringify(v));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-install-policy-"));
    machineFile = path.join(dir, "managed-policy.json");
    vaultRoot = path.join(dir, "vault");
    fs.mkdirSync(vaultRoot);
    process.env.GEODE_POLICY_PATH = machineFile;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.GEODE_POLICY_PATH;
    else process.env.GEODE_POLICY_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("baseline: no policy file, nothing refused", () => {
    for (const a of ALL) expect(() => guardPluginInstall(vaultRoot, a, "acme/x")).not.toThrow();
  });

  it("fails open on a corrupt or invalid policy file", () => {
    writeMachine("{ not json");
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).not.toThrow();
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "forbidden" } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).not.toThrow();
  });

  it.each(ALL)("disabled: %s is refused with an error naming the policy", (action) => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "disabled" } });
    const call = () => guardPluginInstall(vaultRoot, action, "acme/x");
    expect(call).toThrow(PluginInstallBlockedError);
    expect(call).toThrow(/blocked by administrator policy: pluginInstall/);
  });

  it("catalog-only: catalog allowed, free-form install/resolve/import/replace refused", () => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "catalog-only" } });
    expect(() => guardPluginInstall(vaultRoot, "supported-plugin-catalog")).not.toThrow();
    expect(() => guardPluginInstall(vaultRoot, "supported-plugin-install", { owner: "rbcodelabs", repo: "x" })).not.toThrow();
    for (const a of ["community-install", "community-resolve"] as const) {
      expect(() => guardPluginInstall(vaultRoot, a, "acme/x")).toThrow(/pluginInstall/);
    }
    expect(() => guardPluginInstall(vaultRoot, "community-import-obsidian")).toThrow(/pluginInstall/);
    expect(() => guardPluginInstall(vaultRoot, "plugin-files-replace")).toThrow(/pluginInstall/);
  });

  it("sources: a non-matching spec is refused from the spec alone (no fetch is needed)", () => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "allowed", sources: ["github.com/acme/*"] } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "https://github.com/acme/tool")).not.toThrow();
    expect(() => guardPluginInstall(vaultRoot, "community-install", "evil/tool")).toThrow(/not in the allowed pluginInstall.sources/);
    expect(() => guardPluginInstall(vaultRoot, "community-resolve", "evil/tool")).toThrow(/pluginInstall.sources/);
    expect(() => guardPluginInstall(vaultRoot, "community-install", "garbage")).toThrow(/pluginInstall/);
  });

  it("reads the vault policy fresh on every call and the vault can only narrow", () => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "allowed" } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).not.toThrow();
    writeVault({ policyVersion: 1, pluginInstall: { mode: "disabled" } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).toThrow(/pluginInstall/);
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "allowed" }, vaultPolicy: "ignore" });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).not.toThrow();
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "disabled" } });
    writeVault({ policyVersion: 1, pluginInstall: { mode: "allowed" } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).toThrow(/pluginInstall/);
  });

  it("no vault open: machine layer alone applies", () => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "disabled" } });
    expect(() => guardPluginInstall(null, "community-resolve", "acme/x")).toThrow(/pluginInstall/);
  });

  it("refusal writes nothing to the vault", () => {
    writeMachine({ policyVersion: 1, pluginInstall: { mode: "disabled" } });
    expect(() => guardPluginInstall(vaultRoot, "community-install", "acme/x")).toThrow();
    expect(fs.readdirSync(vaultRoot)).toEqual([]);
  });
});

describe("every gated IPC handler in main.ts calls the guard", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/main/main.ts"), "utf8");
  it.each(ALL)("%s", (channel) => {
    const start = src.indexOf(`ipcMain.handle("${channel}"`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("ipcMain.handle(", start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).toContain(`guardPluginInstall(`);
    expect(body).toContain(`"${channel}"`);
  });
});

describe("installControlState (advisory renderer UI)", () => {
  it("is unrestricted with no policy", () => {
    expect(installControlState(null)).toMatchObject({ github: true, catalog: true, importObsidian: true, note: null });
    expect(installControlState(eff(undefined))).toMatchObject({ github: true, catalog: true, importObsidian: true, note: null });
  });
  it("disabled turns everything off with a managed note", () => {
    const s = installControlState(eff({ pluginInstall: { mode: "disabled" } }));
    expect(s).toMatchObject({ github: false, catalog: false, importObsidian: false });
    expect(s.note).toMatch(/Managed by your administrator/);
  });
  it("catalog-only keeps the catalog", () => {
    const s = installControlState(eff({ pluginInstall: { mode: "catalog-only" } }));
    expect(s).toMatchObject({ github: false, catalog: true, importObsidian: false });
    expect(s.note).toMatch(/Managed by your administrator/);
  });
  it("sources keeps controls enabled but annotates", () => {
    const s = installControlState(eff({ pluginInstall: { mode: "allowed", sources: ["acme/*"] } }));
    expect(s).toMatchObject({ github: true, catalog: true, importObsidian: true });
    expect(s.note).toMatch(/acme\/\*/);
  });
});

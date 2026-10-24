import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPluginBlocked, POLICY_NO_MATCH, validatePolicy, type ManagedPolicy } from "../../src/renderer/policy";

describe("isPluginBlocked", () => {
  it("never blocks when policy is null", () => {
    expect(isPluginBlocked(null, "some-plugin")).toBe(false);
  });

  it("never blocks when policy has no plugins key", () => {
    const policy: ManagedPolicy = { policyVersion: 1 };
    expect(isPluginBlocked(policy, "some-plugin")).toBe(false);
  });

  it("blocklist mode blocks only listed ids", () => {
    const policy: ManagedPolicy = {
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["bad-plugin"] },
    };
    expect(isPluginBlocked(policy, "bad-plugin")).toBe(true);
    expect(isPluginBlocked(policy, "good-plugin")).toBe(false);
  });

  it("blocklist mode with an empty list blocks nothing", () => {
    const policy: ManagedPolicy = { policyVersion: 1, plugins: { mode: "blocklist", ids: [] } };
    expect(isPluginBlocked(policy, "any-plugin")).toBe(false);
  });

  it("allowlist mode blocks everything not listed", () => {
    const policy: ManagedPolicy = {
      policyVersion: 1,
      plugins: { mode: "allowlist", ids: ["good-plugin"] },
    };
    expect(isPluginBlocked(policy, "good-plugin")).toBe(false);
    expect(isPluginBlocked(policy, "other-plugin")).toBe(true);
  });

  it("allowlist mode with an empty list blocks everything", () => {
    const policy: ManagedPolicy = { policyVersion: 1, plugins: { mode: "allowlist", ids: [] } };
    expect(isPluginBlocked(policy, "any-plugin")).toBe(true);
  });
});

describe("validatePolicy", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for a non-object document", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy("nope")).toBeNull();
    expect(validatePolicy([1, 2, 3])).toBeNull();
  });

  it("returns null when policyVersion is missing", () => {
    expect(validatePolicy({ plugins: { mode: "blocklist", ids: [] } })).toBeNull();
  });

  it("returns null when policyVersion is unrecognized", () => {
    expect(validatePolicy({ policyVersion: 2 })).toBeNull();
    expect(validatePolicy({ policyVersion: "1" })).toBeNull();
  });

  it("accepts a document with only policyVersion (plugins absent = no restriction)", () => {
    const result = validatePolicy({ policyVersion: 1 });
    expect(result).toEqual({ policyVersion: 1 });
  });

  it("parses a valid blocklist policy", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["some-untrusted-plugin"] },
    });
    expect(result).toEqual({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["some-untrusted-plugin"] },
    });
  });

  it("parses a valid allowlist policy", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "allowlist", ids: ["trusted-plugin"] },
    });
    expect(result?.plugins).toEqual({ mode: "allowlist", ids: ["trusted-plugin"] });
  });

  it("skips invalid ids in the list but keeps the rest (not fatal to the whole policy)", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["good-id", "Bad ID!", "", "ANOTHER_BAD", 42, "another-good-id"] },
    });
    expect(result?.plugins?.ids).toEqual(["good-id", "another-good-id"]);
  });

  it("treats plugins.mode as absent-equivalent (whole plugins block ignored) when mode is invalid", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "denylist", ids: ["x"] },
    });
    expect(result).toEqual({ policyVersion: 1 });
    expect(result?.plugins).toBeUndefined();
  });

  it("ignores plugins block when ids is not an array", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: "not-an-array" },
    });
    expect(result?.plugins).toBeUndefined();
  });

  it("ignores plugins block when it is not an object", () => {
    const result = validatePolicy({ policyVersion: 1, plugins: "nope" });
    expect(result?.plugins).toBeUndefined();
  });
});

describe("validatePolicy: control areas", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const v = (extra: Record<string, unknown>) => validatePolicy({ policyVersion: 1, ...extra });

  it("ignores unknown keys at every level", () => {
    const p = v({ futureArea: { x: 1 }, sync: { enabled: false, futureField: 1 } });
    expect(p).toEqual({ policyVersion: 1, sync: { enabled: false } });
  });

  it("each area fails open independently: a broken area never disables a good one", () => {
    const p = v({
      plugins: { mode: "blocklist", ids: ["bad-plugin"] },
      pluginInstall: { mode: "forbidden" },
      sync: "off",
      threadExecution: 7,
      github: [],
      daemons: null,
    });
    expect(p).toEqual({ policyVersion: 1, plugins: { mode: "blocklist", ids: ["bad-plugin"] } });
  });

  describe("pluginInstall", () => {
    it("parses each mode and optional sources", () => {
      expect(v({ pluginInstall: { mode: "disabled" } })?.pluginInstall).toEqual({ mode: "disabled" });
      expect(v({ pluginInstall: { mode: "catalog-only" } })?.pluginInstall).toEqual({ mode: "catalog-only" });
      expect(v({ pluginInstall: { mode: "allowed", sources: ["github.com/your-org/*", "github.com/a/b"] } })?.pluginInstall)
        .toEqual({ mode: "allowed", sources: ["github.com/your-org/*", "github.com/a/b"] });
    });
    it("drops the area on a bad mode; fails a source list with no valid entry closed (sources: ["!none"]); keeps the valid entries", () => {
      expect(v({ pluginInstall: { mode: 1 } })?.pluginInstall).toBeUndefined();
      expect(v({ pluginInstall: { mode: "allowed", sources: ["*/x", "a b"] } })?.pluginInstall)
        .toEqual({ mode: "allowed", sources: ["!none"] });
      expect(v({ pluginInstall: { mode: "allowed", sources: ["good/one", "*/x"] } })?.pluginInstall?.sources).toEqual(["good/one"]);
    });
    it("keeps an empty sources list (allow no source)", () => {
      expect(v({ pluginInstall: { mode: "allowed", sources: [] } })?.pluginInstall?.sources).toEqual([]);
    });
  });

  describe("sync", () => {
    it("parses enabled, providers and normalizes hub origins", () => {
      const p = v({ sync: { enabled: false, providers: ["hub", "icloud"], hubAllowlist: ["https://hub.corp.example/path", "https://h.example:443"] } });
      expect(p?.sync).toEqual({ enabled: false, providers: ["hub", "icloud"], hubAllowlist: ["https://hub.corp.example", "https://h.example"] });
    });
    it("drops only the bad field", () => {
      const p = v({ sync: { enabled: "no", providers: ["hub"], hubAllowlist: "https://x" } });
      expect(p?.sync).toEqual({ providers: ["hub"] });
    });
    it("a hub allowlist of only junk is dropped (fail open), not turned into deny-all", () => {
      expect(v({ sync: { hubAllowlist: ["not a url", "ftp://x"] } })?.sync).toEqual({});
    });
  });

  describe("threadExecution", () => {
    it("parses targets, global harnesses, hostExec and mobileRemoteAccess", () => {
      const p = v({
        threadExecution: {
          harnesses: ["claude", "codex"],
          machine: { enabled: false },
          localDaemon: { enabled: true, harnesses: ["claude"] },
          remoteDaemon: { enabled: true, harnesses: ["claude", "codex"], hosts: ["wss://threads.corp.example:8443/x"] },
          hostExec: { enabled: false, allowAlways: false },
          mobileRemoteAccess: false,
        },
      });
      expect(p?.threadExecution).toEqual({
        harnesses: ["claude", "codex"],
        machine: { enabled: false },
        localDaemon: { enabled: true, harnesses: ["claude"] },
        remoteDaemon: { enabled: true, harnesses: ["claude", "codex"], hosts: ["wss://threads.corp.example:8443"] },
        hostExec: { enabled: false, allowAlways: false },
        mobileRemoteAccess: false,
      });
    });
    it("accepts boolean shorthand for targets", () => {
      const p = v({ threadExecution: { machine: false, localDaemon: true, remoteDaemon: false } });
      expect(p?.threadExecution).toEqual({ machine: { enabled: false }, localDaemon: { enabled: true }, remoteDaemon: { enabled: false } });
    });
    it("does not accept hosts on non-remote targets", () => {
      expect(v({ threadExecution: { machine: { enabled: true, hosts: ["wss://x"] } } })?.threadExecution?.machine).toEqual({ enabled: true });
    });
    it("a bad target or flag is dropped without losing the rest", () => {
      const p = v({ threadExecution: { machine: "yes", harnesses: ["claude"], mobileRemoteAccess: "no", hostExec: 3 } });
      expect(p?.threadExecution).toEqual({ harnesses: ["claude"] });
    });
    it("keeps unknown-but-well-formed harness ids (an older plugin ignores them)", () => {
      expect(v({ threadExecution: { harnesses: ["claude", "brand-new"] } })?.threadExecution?.harnesses).toEqual(["claude", "brand-new"]);
    });
  });

  describe("github", () => {
    it("parses the full block", () => {
      const p = v({
        github: {
          settingsLocked: true, clientId: "Iv1.corpapp", appSlug: "corp-geode",
          allowedOwners: ["your-org"], allowedRepos: ["your-org/repo"],
          connect: true, disconnect: false, allowedLogins: ["*_corp", "alice"], deliverToRemoteDaemon: false,
        },
      });
      expect(p?.github).toEqual({
        settingsLocked: true, clientId: "Iv1.corpapp", appSlug: "corp-geode",
        allowedOwners: ["your-org"], allowedRepos: ["your-org/repo"],
        connect: true, disconnect: false, allowedLogins: ["*_corp", "alice"], deliverToRemoteDaemon: false,
      });
    });
    it("allowlists fail CLOSED when present, non-empty and all invalid", () => {
      const p = v({ github: { allowedOwners: ["bad owner!", 5], allowedRepos: ["nope"], allowedLogins: ["has space"] } });
      expect(p?.github).toEqual({
        allowedOwners: [POLICY_NO_MATCH], allowedRepos: [POLICY_NO_MATCH], allowedLogins: [POLICY_NO_MATCH],
      });
    });
    it("allowlists fail closed when not an array", () => {
      expect(v({ github: { allowedOwners: "your-org" } })?.github?.allowedOwners).toEqual([POLICY_NO_MATCH]);
    });
    it("a partly valid allowlist keeps the valid entries; an empty one stays empty (no restriction)", () => {
      expect(v({ github: { allowedOwners: ["ok", "bad owner!"] } })?.github?.allowedOwners).toEqual(["ok"]);
      expect(v({ github: { allowedOwners: [] } })?.github?.allowedOwners).toEqual([]);
    });
    it("other bad fields are dropped individually (fail open) while good ones survive", () => {
      const p = v({ github: { clientId: "x", appSlug: "ok-slug", connect: "yes", settingsLocked: true } });
      expect(p?.github).toEqual({ appSlug: "ok-slug", settingsLocked: true });
    });
    it("a non-object github area is ignored (fail open)", () => {
      expect(v({ github: "locked" })?.github).toBeUndefined();
    });
  });

  describe("daemons", () => {
    it("parses flags and listen addresses", () => {
      expect(v({ daemons: { allowSchedule: false, allowServe: true, allowedListenAddresses: ["127.0.0.1", "::1"] } })?.daemons)
        .toEqual({ allowSchedule: false, allowServe: true, allowedListenAddresses: ["127.0.0.1", "::1"] });
    });
    it("drops bad fields", () => {
      expect(v({ daemons: { allowServe: 0, allowedListenAddresses: ["bad addr"] } })?.daemons).toEqual({});
    });
  });

  describe("vaultPolicy and note", () => {
    it("accepts narrow and ignore, drops anything else", () => {
      expect(v({ vaultPolicy: "ignore" })?.vaultPolicy).toBe("ignore");
      expect(v({ vaultPolicy: "narrow" })?.vaultPolicy).toBe("narrow");
      expect(v({ vaultPolicy: "widen" })?.vaultPolicy).toBeUndefined();
    });
    it("keeps a trimmed, bounded display note", () => {
      expect(v({ note: "  Team rules  " })?.note).toBe("Team rules");
      expect(v({ note: "x".repeat(900) })?.note).toHaveLength(500);
      expect(v({ note: 5 })?.note).toBeUndefined();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePolicy, type ManagedPolicy } from "../../src/renderer/policy";
import {
  isPluginBlockedEffective,
  resolveEffectivePolicy,
  sanitizeVaultPolicy,
  vaultPolicyAreas,
} from "../../src/renderer/policy-layering";

const P = (extra: Record<string, unknown>): ManagedPolicy => {
  const p = validatePolicy({ policyVersion: 1, ...extra });
  if (!p) throw new Error("fixture invalid");
  return p;
};

describe("resolveEffectivePolicy", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("baseline: no layers means no restrictions and empty provenance", () => {
    const { effective, provenance } = resolveEffectivePolicy(null, null);
    expect(provenance).toEqual({});
    expect(effective.plugins).toEqual([]);
    expect(effective.pluginInstall).toEqual({ mode: "allowed" });
    expect(effective.sync).toEqual({ enabled: true, providers: undefined, hubAllowlist: undefined });
    expect(effective.threadExecution.machine.enabled).toBe(true);
    expect(effective.threadExecution.localDaemon.enabled).toBe(true);
    expect(effective.threadExecution.remoteDaemon.enabled).toBe(true);
    expect(effective.threadExecution.hostExec).toEqual({ enabled: true, allowAlways: true });
    expect(effective.threadExecution.mobileRemoteAccess).toBe(true);
    expect(effective.github).toMatchObject({ settingsLocked: false, allow: [], allowedLogins: [], connect: true, disconnect: true, deliverToRemoteDaemon: true });
    expect(effective.daemons).toMatchObject({ allowSchedule: true, allowServe: true });
    expect(effective.vaultPolicy).toBe("narrow");
    expect(isPluginBlockedEffective(effective, "anything")).toBe(false);
  });

  it("a document with only policyVersion in both layers imposes nothing", () => {
    const { provenance } = resolveEffectivePolicy(P({}), P({}));
    expect(provenance).toEqual({});
  });

  describe("plugins: blocked if ANY layer blocks", () => {
    it("machine blocklist + vault allowlist = in the vault's list and not in the machine's blocklist", () => {
      const { effective } = resolveEffectivePolicy(
        P({ plugins: { mode: "blocklist", ids: ["bad"] } }),
        P({ plugins: { mode: "allowlist", ids: ["good", "bad"] } })
      );
      expect(isPluginBlockedEffective(effective, "good")).toBe(false);
      expect(isPluginBlockedEffective(effective, "bad")).toBe(true); // machine blocks
      expect(isPluginBlockedEffective(effective, "other")).toBe(true); // vault allowlist excludes
    });
    it("a vault cannot unblock a machine-blocked plugin", () => {
      const { effective } = resolveEffectivePolicy(
        P({ plugins: { mode: "blocklist", ids: ["bad"] } }),
        P({ plugins: { mode: "blocklist", ids: [] } })
      );
      expect(isPluginBlockedEffective(effective, "bad")).toBe(true);
    });
    it("a vault allowlist cannot re-allow what a machine allowlist excludes", () => {
      const { effective } = resolveEffectivePolicy(
        P({ plugins: { mode: "allowlist", ids: ["a"] } }),
        P({ plugins: { mode: "allowlist", ids: ["a", "b"] } })
      );
      expect(isPluginBlockedEffective(effective, "b")).toBe(true);
      expect(isPluginBlockedEffective(effective, "a")).toBe(false);
    });
    it("vault-only blocklist blocks with no machine file", () => {
      const { effective, provenance } = resolveEffectivePolicy(null, P({ plugins: { mode: "blocklist", ids: ["x"] } }));
      expect(isPluginBlockedEffective(effective, "x")).toBe(true);
      expect(provenance.plugins).toEqual(["vault"]);
    });
    it("records both layers in provenance", () => {
      const { provenance } = resolveEffectivePolicy(
        P({ plugins: { mode: "blocklist", ids: ["a"] } }),
        P({ plugins: { mode: "blocklist", ids: ["b"] } })
      );
      expect(provenance.plugins).toEqual(["machine", "vault"]);
    });
    it("isPluginBlockedEffective(null) never blocks", () => {
      expect(isPluginBlockedEffective(null, "x")).toBe(false);
    });
  });

  describe("booleans: AND, false in either layer wins", () => {
    const cases: Array<[string, (b: boolean) => Record<string, unknown>, (e: ReturnType<typeof resolveEffectivePolicy>["effective"]) => boolean]> = [
      ["sync.enabled", (b) => ({ sync: { enabled: b } }), (e) => e.sync.enabled],
      ["threadExecution.machine.enabled", (b) => ({ threadExecution: { machine: { enabled: b } } }), (e) => e.threadExecution.machine.enabled],
      ["threadExecution.localDaemon.enabled", (b) => ({ threadExecution: { localDaemon: b } }), (e) => e.threadExecution.localDaemon.enabled],
      ["threadExecution.remoteDaemon.enabled", (b) => ({ threadExecution: { remoteDaemon: { enabled: b } } }), (e) => e.threadExecution.remoteDaemon.enabled],
      ["threadExecution.hostExec.enabled", (b) => ({ threadExecution: { hostExec: { enabled: b } } }), (e) => e.threadExecution.hostExec.enabled],
      ["threadExecution.hostExec.allowAlways", (b) => ({ threadExecution: { hostExec: { allowAlways: b } } }), (e) => e.threadExecution.hostExec.allowAlways],
      ["threadExecution.mobileRemoteAccess", (b) => ({ threadExecution: { mobileRemoteAccess: b } }), (e) => e.threadExecution.mobileRemoteAccess],
      ["github.connect", (b) => ({ github: { connect: b } }), (e) => e.github.connect],
      ["github.deliverToRemoteDaemon", (b) => ({ github: { deliverToRemoteDaemon: b } }), (e) => e.github.deliverToRemoteDaemon],
      ["daemons.allowSchedule", (b) => ({ daemons: { allowSchedule: b } }), (e) => e.daemons.allowSchedule],
      ["daemons.allowServe", (b) => ({ daemons: { allowServe: b } }), (e) => e.daemons.allowServe],
    ];
    for (const [key, make, read] of cases) {
      it(`${key}: machine false, vault true stays false (vault cannot widen)`, () => {
        const { effective, provenance } = resolveEffectivePolicy(P(make(false)), P(make(true)));
        expect(read(effective)).toBe(false);
        expect(provenance[key]).toEqual(["machine"]);
      });
      it(`${key}: machine true, vault false narrows`, () => {
        const { effective, provenance } = resolveEffectivePolicy(P(make(true)), P(make(false)));
        expect(read(effective)).toBe(false);
        expect(provenance[key]).toEqual(["vault"]);
      });
      it(`${key}: both false names both layers; both true or absent is unrestricted`, () => {
        expect(resolveEffectivePolicy(P(make(false)), P(make(false))).provenance[key]).toEqual(["machine", "vault"]);
        const open = resolveEffectivePolicy(P(make(true)), null);
        expect(read(open.effective)).toBe(true);
        expect(open.provenance[key]).toBeUndefined();
      });
    }
  });

  describe("pluginInstall.mode: the stricter wins", () => {
    const modes = ["allowed", "catalog-only", "disabled"] as const;
    for (const m of modes) {
      for (const v of modes) {
        it(`machine ${m} + vault ${v}`, () => {
          const expected = modes[Math.max(modes.indexOf(m), modes.indexOf(v))];
          const { effective } = resolveEffectivePolicy(P({ pluginInstall: { mode: m } }), P({ pluginInstall: { mode: v } }));
          expect(effective.pluginInstall.mode).toBe(expected);
        });
      }
    }
    it("provenance names the layer(s) whose mode won", () => {
      const a = resolveEffectivePolicy(P({ pluginInstall: { mode: "catalog-only" } }), P({ pluginInstall: { mode: "disabled" } }));
      expect(a.provenance["pluginInstall.mode"]).toEqual(["vault"]);
      const b = resolveEffectivePolicy(P({ pluginInstall: { mode: "disabled" } }), P({ pluginInstall: { mode: "disabled" } }));
      expect(b.provenance["pluginInstall.mode"]).toEqual(["machine", "vault"]);
      const c = resolveEffectivePolicy(P({ pluginInstall: { mode: "allowed" } }), null);
      expect(c.provenance["pluginInstall.mode"]).toBeUndefined();
    });
    it("a vault cannot loosen a machine mode", () => {
      const { effective } = resolveEffectivePolicy(P({ pluginInstall: { mode: "disabled" } }), P({ pluginInstall: { mode: "allowed" } }));
      expect(effective.pluginInstall.mode).toBe("disabled");
    });
  });

  describe("exact-match lists: intersection, absent = no restriction", () => {
    const cases: Array<[string, (l: string[]) => Record<string, unknown>, (e: ReturnType<typeof resolveEffectivePolicy>["effective"]) => string[] | undefined, string[], string[], string[]]> = [
      ["threadExecution.harnesses", (l) => ({ threadExecution: { harnesses: l } }), (e) => e.threadExecution.harnesses, ["claude", "codex"], ["codex", "opencode"], ["codex"]],
      ["threadExecution.localDaemon.harnesses", (l) => ({ threadExecution: { localDaemon: { harnesses: l } } }), (e) => e.threadExecution.localDaemon.harnesses, ["claude", "codex"], ["codex"], ["codex"]],
      ["threadExecution.remoteDaemon.hosts", (l) => ({ threadExecution: { remoteDaemon: { hosts: l } } }), (e) => e.threadExecution.remoteDaemon.hosts, ["wss://a.example:1", "wss://b.example:2"], ["wss://b.example:2", "wss://c.example:3"], ["wss://b.example:2"]],
      ["sync.providers", (l) => ({ sync: { providers: l } }), (e) => e.sync.providers, ["hub", "icloud"], ["icloud"], ["icloud"]],
      ["sync.hubAllowlist", (l) => ({ sync: { hubAllowlist: l } }), (e) => e.sync.hubAllowlist, ["https://a.example", "https://b.example"], ["https://b.example"], ["https://b.example"]],
      ["daemons.allowedListenAddresses", (l) => ({ daemons: { allowedListenAddresses: l } }), (e) => e.daemons.allowedListenAddresses, ["127.0.0.1", "::1"], ["::1", "0.0.0.0"], ["::1"]],
    ];
    for (const [key, make, read, a, b, both] of cases) {
      it(`${key}: intersection`, () => {
        const { effective, provenance } = resolveEffectivePolicy(P(make(a)), P(make(b)));
        expect(read(effective)).toEqual(both);
        expect(provenance[key]).toEqual(["machine", "vault"]);
      });
      it(`${key}: a vault list cannot widen the machine list`, () => {
        const { effective } = resolveEffectivePolicy(P(make(b)), P(make([...b, "extra-entry"].filter((x) => /^[a-z]/.test(x) || x.includes(":") || x.includes(".")))));
        for (const x of read(effective) ?? []) expect(b).toContain(x);
      });
      it(`${key}: absent in one layer means the other layer's list applies unchanged`, () => {
        expect(read(resolveEffectivePolicy(P(make(a)), P({})).effective)).toEqual(a);
        expect(read(resolveEffectivePolicy(null, P(make(b))).effective)).toEqual(b);
        const none = resolveEffectivePolicy(P({}), P({}));
        expect(read(none.effective)).toBeUndefined();
        expect(none.provenance[key]).toBeUndefined();
      });
      it(`${key}: an empty list is a restriction (allow none), not an absent one`, () => {
        expect(read(resolveEffectivePolicy(P(make(a)), P(make([]))).effective)).toEqual([]);
      });
    }
  });

  describe("per-layer lists: every layer must pass", () => {
    it("pluginInstall.sources keeps one list per layer", () => {
      const { effective, provenance } = resolveEffectivePolicy(
        P({ pluginInstall: { mode: "allowed", sources: ["github.com/corp/*"] } }),
        P({ pluginInstall: { mode: "allowed", sources: ["github.com/corp/tool"] } })
      );
      expect(effective.pluginInstall.sources).toEqual([["github.com/corp/*"], ["github.com/corp/tool"]]);
      expect(provenance["pluginInstall.sources"]).toEqual(["machine", "vault"]);
    });
    it("github owners/repos stay one policy per layer (owner OR repo inside a layer, AND across layers)", () => {
      const { effective, provenance } = resolveEffectivePolicy(
        P({ github: { allowedOwners: ["corp"] } }),
        P({ github: { allowedRepos: ["corp/one"] } })
      );
      expect(effective.github.allow).toEqual([{ owners: ["corp"], repos: [] }, { owners: [], repos: ["corp/one"] }]);
      expect(provenance["github.allow"]).toEqual(["machine", "vault"]);
    });
    it("an empty github allowlist adds no restriction", () => {
      const { effective, provenance } = resolveEffectivePolicy(P({ github: { allowedOwners: [] } }), null);
      expect(effective.github.allow).toEqual([]);
      expect(provenance["github.allow"]).toBeUndefined();
    });
    it("an all-invalid (fail-closed) allowlist survives layering and matches nothing", () => {
      const { effective } = resolveEffectivePolicy(P({ github: { allowedOwners: ["bad owner!"] } }), null);
      expect(effective.github.allow).toEqual([{ owners: ["!none"], repos: [] }]);
    });
    it("allowedLogins keeps one list per layer", () => {
      const { effective, provenance } = resolveEffectivePolicy(
        P({ github: { allowedLogins: ["*_corp"] } }),
        P({ github: { allowedLogins: ["alice_corp"] } })
      );
      expect(effective.github.allowedLogins).toEqual([["*_corp"], ["alice_corp"]]);
      expect(provenance["github.allowedLogins"]).toEqual(["machine", "vault"]);
    });
  });

  describe("machine-only keys", () => {
    it("pinned clientId/appSlug, settingsLocked and disconnect in a vault file are ignored with a warning", () => {
      const { effective, provenance } = resolveEffectivePolicy(
        null,
        P({ github: { clientId: "Iv1.evil", appSlug: "evil", settingsLocked: true, disconnect: false } })
      );
      expect(effective.github.clientId).toBeUndefined();
      expect(effective.github.appSlug).toBeUndefined();
      expect(effective.github.settingsLocked).toBe(false);
      expect(effective.github.disconnect).toBe(true);
      expect(provenance).toEqual({});
      const messages = warn.mock.calls.map((c) => String(c[0]));
      for (const key of ["clientId", "appSlug", "settingsLocked", "disconnect"]) {
        expect(messages.some((m) => m.includes(`github.${key}`))).toBe(true);
      }
    });
    it("the machine layer's pins and lock are honored and attributed to the machine", () => {
      const { effective, provenance } = resolveEffectivePolicy(
        P({ github: { clientId: "Iv1.corp", appSlug: "corp", settingsLocked: true, disconnect: false } }),
        P({ github: { clientId: "Iv1.evil", appSlug: "evil", settingsLocked: false, disconnect: true } })
      );
      expect(effective.github).toMatchObject({ clientId: "Iv1.corp", appSlug: "corp", settingsLocked: true, disconnect: false });
      expect(provenance["github.clientId"]).toEqual(["machine"]);
      expect(provenance["github.appSlug"]).toEqual(["machine"]);
      expect(provenance["github.settingsLocked"]).toEqual(["machine"]);
      expect(provenance["github.disconnect"]).toEqual(["machine"]);
    });
    it("a vault file cannot set vaultPolicy", () => {
      const out = sanitizeVaultPolicy(P({ vaultPolicy: "ignore" }));
      expect(out.vaultPolicy).toBeUndefined();
    });
    it("sanitizeVaultPolicy does not mutate its input", () => {
      const vault = P({ github: { clientId: "Iv1.evil", connect: false } });
      sanitizeVaultPolicy(vault);
      expect(vault.github?.clientId).toBe("Iv1.evil");
    });
    it("a vault's non-machine-only github keys still apply", () => {
      const { effective } = resolveEffectivePolicy(null, P({ github: { clientId: "Iv1.evil", connect: false, deliverToRemoteDaemon: false } }));
      expect(effective.github.connect).toBe(false);
      expect(effective.github.deliverToRemoteDaemon).toBe(false);
    });
  });

  describe("vaultPolicy: ignore", () => {
    it("drops the vault layer entirely", () => {
      const vault = P({ plugins: { mode: "blocklist", ids: ["x"] }, sync: { enabled: false } });
      const { effective, provenance } = resolveEffectivePolicy(P({ vaultPolicy: "ignore" }), vault);
      expect(isPluginBlockedEffective(effective, "x")).toBe(false);
      expect(effective.sync.enabled).toBe(true);
      expect(effective.vaultPolicy).toBe("ignore");
      expect(provenance).toEqual({ vaultPolicy: ["machine"] });
    });
    it("machine restrictions still apply under ignore", () => {
      const { effective } = resolveEffectivePolicy(
        P({ vaultPolicy: "ignore", plugins: { mode: "blocklist", ids: ["m"] } }),
        P({ plugins: { mode: "blocklist", ids: ["v"] } })
      );
      expect(isPluginBlockedEffective(effective, "m")).toBe(true);
      expect(isPluginBlockedEffective(effective, "v")).toBe(false);
    });
    it("narrow (explicit or default) uses the vault layer", () => {
      for (const machine of [P({ vaultPolicy: "narrow" }), P({}), null]) {
        const { effective } = resolveEffectivePolicy(machine, P({ sync: { enabled: false } }));
        expect(effective.sync.enabled).toBe(false);
      }
    });
  });

  describe("fail-open and fail-closed across layering", () => {
    it("a broken vault area is ignored by the validator and the machine layer is untouched", () => {
      const vault = validatePolicy({ policyVersion: 1, sync: "garbage", plugins: { mode: "blocklist", ids: ["v"] } })!;
      const { effective } = resolveEffectivePolicy(P({ sync: { enabled: false } }), vault);
      expect(effective.sync.enabled).toBe(false);
      expect(isPluginBlockedEffective(effective, "v")).toBe(true);
    });
    it("an unusable vault document (null) leaves the machine policy as is", () => {
      const { effective } = resolveEffectivePolicy(P({ plugins: { mode: "blocklist", ids: ["m"] } }), validatePolicy("nope"));
      expect(isPluginBlockedEffective(effective, "m")).toBe(true);
    });
  });
});

describe("vaultPolicyAreas", () => {
  it("lists only the areas the vault restricts", () => {
    expect(vaultPolicyAreas(null)).toEqual([]);
    expect(vaultPolicyAreas(P({}))).toEqual([]);
    expect(vaultPolicyAreas(P({ sync: { enabled: false }, plugins: { mode: "blocklist", ids: [] }, note: "x" }))).toEqual(["plugins", "sync"]);
  });
});

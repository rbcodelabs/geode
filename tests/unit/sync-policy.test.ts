import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSyncPolicy,
  hubRequestBlockReason,
  hubTargetBlockReason,
  hubUrlOrigin,
  icloudCallBlockReason,
  policyProviderId,
  syncChannelBlockReason,
  syncDisabledReason,
  syncProviderBlockReason,
  type SyncPolicyView,
} from "../../src/shared/sync-policy";
import { validatePolicy } from "../../src/renderer/policy";
import { resolveEffectivePolicy } from "../../src/renderer/policy-layering";
import { assertSyncChannelAllowed, createSyncPolicyFor, syncPolicyForRoot } from "../../src/main/sync-policy-gate";
import { HubError, validateHubTarget } from "../../src/sync-node/app-hub";

const HUB = "https://hub.corp.example";
const allow = (...hubAllowlist: string[]): SyncPolicyView => ({ enabled: true, hubAllowlist });
const url = (u: string) => ({ kind: "http" as const, url: u });
const blocked = (policy: SyncPolicyView | null, u: string) => hubTargetBlockReason(policy, url(u));

describe("sync kill switch and provider narrowing", () => {
  it("allows everything with no policy (fail open) and with enabled: true or omitted", () => {
    for (const policy of [null, undefined, {}, { enabled: true }] as const) {
      expect(syncDisabledReason(policy)).toBeNull();
      expect(syncProviderBlockReason(policy, "hub")).toBeNull();
      expect(syncChannelBlockReason(policy)).toBeNull();
      expect(icloudCallBlockReason(policy, "list")).toBeNull();
      expect(hubRequestBlockReason(policy, { method: "scan" })).toBeNull();
    }
  });

  it("enabled: false blocks every provider and names the policy", () => {
    const off = { enabled: false };
    expect(syncDisabledReason(off)).toMatch(/blocked by administrator policy: sync/);
    expect(syncProviderBlockReason(off, "hub")).toMatch(/blocked by administrator policy: sync/);
    expect(syncProviderBlockReason(off, "icloud")).toMatch(/blocked by administrator policy: sync/);
    expect(syncChannelBlockReason(off)).toMatch(/blocked by administrator policy: sync/);
    expect(hubTargetBlockReason(off, { kind: "fs", path: "/srv/hub" })).toMatch(/blocked by administrator policy: sync/);
  });

  it("providers narrows to a set; the built-in hub id geode.hub means hub", () => {
    const only = { providers: ["hub"] };
    expect(policyProviderId("geode.hub")).toBe("hub");
    expect(syncProviderBlockReason(only, "geode.hub")).toBeNull();
    expect(syncProviderBlockReason(only, "hub")).toBeNull();
    expect(syncProviderBlockReason(only, "icloud")).toMatch(/provider "icloud" is not permitted \(allowed: hub\)/);
    expect(syncProviderBlockReason(only, "some-plugin")).toMatch(/not permitted/);
    expect(syncChannelBlockReason(only)).toBeNull();
  });

  it("an empty or fail-closed provider list permits nothing, including the generic channels", () => {
    for (const providers of [[], ["!none"]]) {
      expect(syncProviderBlockReason({ providers }, "hub")).toMatch(/no sync providers are permitted/);
      expect(syncChannelBlockReason({ providers })).toMatch(/permits no sync providers/);
    }
  });

  it("hub requests: close is always allowed; a session method follows the provider rule", () => {
    const off = { enabled: false };
    expect(hubRequestBlockReason(off, { method: "close" })).toBeNull();
    for (const method of ["scan", "putBlob", "readBlob", "appendRecord", "appendRecords"]) expect(hubRequestBlockReason(off, { method })).not.toBeNull();
    const noHub = { providers: ["icloud"] };
    expect(hubRequestBlockReason(noHub, { method: "scan" })).toMatch(/provider "hub"/);
    expect(hubRequestBlockReason({ providers: ["hub"] }, { method: "scan" })).toBeNull();
  });

  it("icloud calls: refused unless the policy permits icloud, except local discardWrite cleanup", () => {
    const off = { enabled: false };
    expect(icloudCallBlockReason(off, "list")).toMatch(/blocked by administrator policy: sync/);
    expect(icloudCallBlockReason(off, "commitWrite")).not.toBeNull();
    expect(icloudCallBlockReason(off, "discardWrite")).toBeNull();
    expect(icloudCallBlockReason({ providers: ["hub"] }, "read")).toMatch(/"icloud"/);
    expect(icloudCallBlockReason({ providers: ["icloud"] }, "read")).toBeNull();
  });

  it("describeSyncPolicy hides the fail-closed sentinel from the UI", () => {
    expect(describeSyncPolicy({ enabled: false })).toEqual({ disabled: true });
    expect(describeSyncPolicy({ providers: ["!none"], hubAllowlist: ["!none"] })).toEqual({ disabled: false, providers: [], hubAllowlist: [] });
  });
});

describe("hubAllowlist matching (exact scheme + host + port)", () => {
  const policy = allow(HUB, "https://hub2.corp.example:8443", "wss://ws.corp.example");

  it("accepts an exact origin, ignoring path, query, fragment and the default port", () => {
    expect(blocked(policy, HUB)).toBeNull();
    expect(blocked(policy, `${HUB}/`)).toBeNull();
    expect(blocked(policy, `${HUB}/prefix/path?x=1#frag`)).toBeNull();
    expect(blocked(policy, "https://hub.corp.example:443")).toBeNull();
    expect(blocked(policy, "https://hub2.corp.example:8443/api")).toBeNull();
    expect(blocked(policy, "wss://ws.corp.example/sync")).toBeNull();
  });

  it("is case-insensitive for the host (the URL parser lower-cases it)", () => {
    expect(blocked(policy, "https://HUB.Corp.Example")).toBeNull();
    expect(blocked(policy, "HTTPS://hub.corp.example")).toBeNull();
  });

  it("rejects a different port, including the implicit default when the entry has an explicit one", () => {
    expect(blocked(policy, "https://hub.corp.example:8443")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "https://hub2.corp.example")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "https://hub2.corp.example:8444")).toMatch(/not on the allowed hub list/);
  });

  it("rejects a different scheme (no https/wss equivalence) and non-encrypted schemes", () => {
    expect(blocked(policy, "wss://hub.corp.example")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "https://ws.corp.example")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "http://hub.corp.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "ws://hub.corp.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "ftp://hub.corp.example")).toMatch(/could not be checked/);
  });

  it("rejects userinfo tricks: credentials, lookalike prefixes and @-confusion", () => {
    expect(blocked(policy, "https://user:pw@hub.corp.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "https://hub.corp.example@evil.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "https://hub.corp.example:443@evil.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "https://evil.example\\@hub.corp.example")).toMatch(/could not be checked/);
    expect(blocked(policy, "https://evil.example/@hub.corp.example")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "https://evil.example#@hub.corp.example")).toMatch(/not on the allowed hub list/);
    expect(blocked(policy, "https://evil.example?@hub.corp.example")).toMatch(/not on the allowed hub list/);
  });

  it("rejects lookalike hosts: suffixes, prefixes, subdomains and the parent domain", () => {
    for (const bad of ["https://hub.corp.example.evil.example", "https://evilhub.corp.example", "https://x.hub.corp.example", "https://corp.example", "https://hub.corp.exampl"]) {
      expect(blocked(policy, bad), bad).toMatch(/not on the allowed hub list/);
    }
  });

  it("does not strip a trailing dot: hub.corp.example. is a different origin string", () => {
    expect(hubUrlOrigin("https://hub.corp.example.")).toBe("https://hub.corp.example.");
    expect(blocked(policy, "https://hub.corp.example.")).toMatch(/not on the allowed hub list/);
  });

  it("matches IDN hosts by punycode only; a non-ASCII URL is refused outright", () => {
    const idn = allow("https://xn--bcher-kva.example");
    expect(blocked(idn, "https://xn--bcher-kva.example")).toBeNull();
    expect(blocked(idn, "https://XN--BCHER-KVA.example/")).toBeNull();
    expect(blocked(idn, "https://bücher.example")).toMatch(/could not be checked/);
    // A homograph written in punycode is a different host.
    expect(blocked(idn, "https://xn--bcher-kva.example.evil.example")).toMatch(/not on the allowed hub list/);
  });

  it("handles IP literals: exact IPv4 and IPv6 (bracketed), canonicalised numeric forms, no CIDR or prefix matching", () => {
    const ips = allow("https://10.0.0.5:8443", "https://[::1]:8443", "https://[2001:db8::1]");
    expect(blocked(ips, "https://10.0.0.5:8443")).toBeNull();
    expect(blocked(ips, "https://[::1]:8443/x")).toBeNull();
    expect(blocked(ips, "https://[0:0:0:0:0:0:0:1]:8443")).toBeNull();
    expect(blocked(ips, "https://[2001:db8::1]")).toBeNull();
    expect(blocked(ips, "https://10.0.0.6:8443")).toMatch(/not on the allowed hub list/);
    expect(blocked(ips, "https://10.0.0.5")).toMatch(/not on the allowed hub list/);
    expect(blocked(ips, "https://10.0.0.50:8443")).toMatch(/not on the allowed hub list/);
    expect(blocked(ips, "https://10.0.0.5.evil.example:8443")).toMatch(/not on the allowed hub list/);
    // The parser canonicalises these to 10.0.0.5, which is what would be dialled, so they are the allowed host.
    expect(blocked(ips, "https://0xa.0.0.5:8443")).toBeNull();
    expect(blocked(ips, "https://167772165:8443")).toBeNull();
  });

  it("an empty list or the fail-closed sentinel allows no hub", () => {
    expect(blocked({ hubAllowlist: [] }, HUB)).toMatch(/\(allowed: none\)/);
    expect(blocked({ hubAllowlist: ["!none"] }, HUB)).toMatch(/\(allowed: none\)/);
  });

  it("no hubAllowlist: any valid target is fine; garbage http urls still are not decided here", () => {
    expect(blocked(null, "https://anything.example")).toBeNull();
    expect(hubTargetBlockReason({ enabled: true }, { kind: "fs", path: "/srv/hub" })).toBeNull();
    expect(hubTargetBlockReason({ enabled: true }, { kind: "ssh", host: "h", path: "/p" })).toBeNull();
  });

  it("with a hubAllowlist, folder and ssh hubs are refused (they have no URL to match)", () => {
    expect(hubTargetBlockReason(policy, { kind: "fs", path: "/srv/hub" })).toMatch(/folder hubs are not permitted/);
    expect(hubTargetBlockReason(policy, { kind: "ssh", host: "h", path: "/p" })).toMatch(/ssh hubs are not permitted/);
  });

  it("the validator-normalised entry (URL.origin) is what the matcher compares", () => {
    const parsed = validatePolicy({ policyVersion: 1, sync: { hubAllowlist: ["https://Hub.Corp.Example:443/ignored/path", "ftp://x", "https://[::1]:8443"] } });
    expect(parsed?.sync?.hubAllowlist).toEqual(["https://hub.corp.example", "https://[::1]:8443"]);
    expect(blocked({ hubAllowlist: parsed!.sync!.hubAllowlist }, "https://hub.corp.example/x")).toBeNull();
  });
});

describe("validateHubTarget with policy (applied before any connection)", () => {
  it("throws a policy-blocked HubError for a folder or ssh hub when sync is off or an allowlist is set", () => {
    for (const policy of [{ enabled: false }, allow(HUB)]) {
      for (const target of [{ kind: "fs", path: "/srv/hub" }, { kind: "ssh", host: "geode-hub", path: "/srv/hub" }]) {
        let error: unknown;
        try { validateHubTarget(target, policy); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(HubError);
        expect((error as HubError).code).toBe("policy-blocked");
        expect((error as HubError).message).toMatch(/blocked by administrator policy: sync/);
      }
    }
  });
  it("is unchanged with no policy, and structural problems still win over policy", () => {
    expect(validateHubTarget({ kind: "fs", path: "/srv/hub" }, null)).toEqual({ kind: "fs", path: "/srv/hub" });
    expect(() => validateHubTarget({ kind: "fs", path: "relative" }, { enabled: false })).toThrow(/absolute path/);
  });
});

describe("effective policy -> sync decision (layering and the loader, read fresh)", () => {
  const dirs: string[] = [];
  const saved = process.env.GEODE_POLICY_PATH;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GEODE_POLICY_PATH; else process.env.GEODE_POLICY_PATH = saved;
  });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "geode-sync-policy-")); dirs.push(d); return d; };

  it("a vault policy can narrow providers and hubs; the intersection is what is enforced", () => {
    const machine = validatePolicy({ policyVersion: 1, sync: { providers: ["hub", "icloud"], hubAllowlist: [HUB, "https://b.example"] } });
    const vault = validatePolicy({ policyVersion: 1, sync: { providers: ["hub"], hubAllowlist: ["https://b.example", "https://c.example"] } });
    const sync = resolveEffectivePolicy(machine, vault).effective.sync;
    expect(sync.providers).toEqual(["hub"]);
    expect(sync.hubAllowlist).toEqual(["https://b.example"]);
    expect(syncProviderBlockReason(sync, "icloud")).not.toBeNull();
    expect(blocked(sync, "https://b.example")).toBeNull();
    expect(blocked(sync, HUB)).not.toBeNull();
    // A vault policy cannot widen: it cannot re-enable what the machine disabled.
    const off = resolveEffectivePolicy(validatePolicy({ policyVersion: 1, sync: { enabled: false } }), validatePolicy({ policyVersion: 1, sync: { enabled: true } })).effective.sync;
    expect(syncDisabledReason(off)).not.toBeNull();
  });

  it("reads the policy file on every call: flipping the kill switch applies to the next operation", () => {
    const dir = tmp(), file = join(dir, "managed-policy.json");
    process.env.GEODE_POLICY_PATH = file;
    const event = { sender: {} } as never;
    const policyFor = createSyncPolicyFor(() => null);
    expect(() => assertSyncChannelAllowed(policyFor, event)).not.toThrow(); // no file: fail open
    writeFileSync(file, JSON.stringify({ policyVersion: 1, sync: { enabled: false } }));
    expect(() => assertSyncChannelAllowed(policyFor, event)).toThrow(/blocked by administrator policy: sync/);
    writeFileSync(file, JSON.stringify({ policyVersion: 1, sync: { enabled: true } }));
    expect(() => assertSyncChannelAllowed(policyFor, event)).not.toThrow(); // re-enabled: resumes
  });

  it("fails open on an unreadable or invalid policy file", () => {
    const dir = tmp(), file = join(dir, "managed-policy.json");
    process.env.GEODE_POLICY_PATH = file;
    writeFileSync(file, "{ not json");
    expect(syncChannelBlockReason(syncPolicyForRoot(null))).toBeNull();
    writeFileSync(file, JSON.stringify({ policyVersion: 99, sync: { enabled: false } }));
    expect(syncChannelBlockReason(syncPolicyForRoot(null))).toBeNull();
  });

  it("a vault's own .geode/policy.json narrows the calling window's vault only", () => {
    const dir = tmp(), vaultA = join(dir, "a"), vaultB = join(dir, "b");
    process.env.GEODE_POLICY_PATH = join(dir, "none.json");
    mkdirSync(join(vaultA, ".geode"), { recursive: true });
    mkdirSync(join(vaultB, ".geode"), { recursive: true });
    writeFileSync(join(vaultA, ".geode", "policy.json"), JSON.stringify({ policyVersion: 1, sync: { enabled: false } }));
    expect(syncChannelBlockReason(syncPolicyForRoot(vaultA))).toMatch(/blocked by administrator policy: sync/);
    expect(syncChannelBlockReason(syncPolicyForRoot(vaultB))).toBeNull();
  });
});

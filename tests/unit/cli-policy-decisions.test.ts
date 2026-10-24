import { describe, expect, it } from "vitest";
import {
  decideListenAddress, decideSyncInvocation, isScheduledInvocation, POLICY_STATUS, type CliPolicyView,
} from "../../src/cli/policy-decisions";

/**
 * The pure policy decisions behind `geode-wiki sync` (docs/adr/0055-cli-policy.md). No files, no
 * processes: the view is a literal. Integration lives in cli-policy.test.ts and the built-binary proof.
 */

const open: CliPolicyView = { sync: { enabled: true }, daemons: { allowSchedule: true, allowServe: true } };
const syncOff: CliPolicyView = { ...open, sync: { enabled: false } };
const noSchedule: CliPolicyView = { ...open, daemons: { ...open.daemons, allowSchedule: false } };
const noServe: CliPolicyView = { ...open, daemons: { ...open.daemons, allowServe: false } };
const listen = (...addresses: string[]): CliPolicyView => ({ ...open, daemons: { ...open.daemons, allowedListenAddresses: addresses } });

describe("decideSyncInvocation", () => {
  it("allows everything under an unrestricted policy", () => {
    for (const sub of ["init", "preview", "run", "resolve", "gc", "status", "conflicts", "serve"]) expect(decideSyncInvocation(open, { sub }), sub).toBeNull();
    for (const action of ["print", "install", "uninstall", "status"]) expect(decideSyncInvocation(open, { sub: "schedule", action }), action).toBeNull();
  });

  it("sync.enabled=false blocks every subcommand that touches a root or serves a hub, naming the policy", () => {
    for (const sub of ["init", "preview", "run", "resolve", "gc", "serve"]) {
      const b = decideSyncInvocation(syncOff, { sub });
      expect(b, sub).toMatchObject({ feature: "sync", setting: "sync.enabled" });
      expect(b!.message).toContain("blocked by administrator policy: sync");
    }
    expect(decideSyncInvocation(syncOff, { sub: "schedule", action: "install" })).toMatchObject({ feature: "sync" });
  });

  it("sync.enabled=false still permits read-only inspection and removing a previously installed job", () => {
    expect(decideSyncInvocation(syncOff, { sub: "status" })).toBeNull();
    expect(decideSyncInvocation(syncOff, { sub: "conflicts" })).toBeNull();
    for (const action of ["print", "uninstall", "status"]) expect(decideSyncInvocation(syncOff, { sub: "schedule", action }), action).toBeNull();
  });

  it("allowSchedule=false blocks schedule install, names daemons, and leaves print/status/uninstall alone", () => {
    const b = decideSyncInvocation(noSchedule, { sub: "schedule", action: "install" });
    expect(b).toMatchObject({ feature: "daemons", setting: "daemons.allowSchedule" });
    expect(b!.message).toContain("blocked by administrator policy: daemons");
    for (const action of ["print", "uninstall", "status"]) expect(decideSyncInvocation(noSchedule, { sub: "schedule", action }), action).toBeNull();
  });

  it("allowSchedule=false stops a sync run started by an installed unit, but not a hand-run", () => {
    expect(decideSyncInvocation(noSchedule, { sub: "run", scheduled: true })).toMatchObject({ feature: "daemons", setting: "daemons.allowSchedule" });
    expect(decideSyncInvocation(noSchedule, { sub: "run", scheduled: false })).toBeNull();
    expect(decideSyncInvocation(noSchedule, { sub: "run" })).toBeNull();
    expect(decideSyncInvocation(open, { sub: "run", scheduled: true })).toBeNull();
  });

  it("sync.enabled=false takes precedence in the message when both apply", () => {
    const both: CliPolicyView = { sync: { enabled: false }, daemons: { allowSchedule: false, allowServe: false } };
    expect(decideSyncInvocation(both, { sub: "run", scheduled: true })).toMatchObject({ feature: "sync" });
  });

  it("allowServe=false blocks serve only", () => {
    expect(decideSyncInvocation(noServe, { sub: "serve" })).toMatchObject({ feature: "daemons", setting: "daemons.allowServe" });
    expect(decideSyncInvocation(noServe, { sub: "run" })).toBeNull();
    expect(decideSyncInvocation(noServe, { sub: "schedule", action: "install" })).toBeNull();
  });

  it("uses the documented status name", () => { expect(POLICY_STATUS).toBe("blocked-by-policy"); });
});

describe("isScheduledInvocation", () => {
  it("recognises systemd (INVOCATION_ID) and launchd (our job label) and nothing else", () => {
    expect(isScheduledInvocation({ INVOCATION_ID: "abc123" })).toBe(true);
    expect(isScheduledInvocation({ XPC_SERVICE_NAME: "com.geode.wiki-sync.deadbeef" })).toBe(true);
    expect(isScheduledInvocation({ XPC_SERVICE_NAME: "com.apple.something" })).toBe(false);
    expect(isScheduledInvocation({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(isScheduledInvocation({ INVOCATION_ID: "" })).toBe(false);
    expect(isScheduledInvocation({})).toBe(false);
  });
});

describe("decideListenAddress", () => {
  it("no list means no restriction, including wildcards", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "::", "10.1.2.3", "corp.example"]) expect(decideListenAddress(open, host), host).toBeNull();
  });

  it("loopback aliases are one class: any listed alias admits all of them", () => {
    for (const entry of ["127.0.0.1", "::1", "localhost", "[::1]", "LOCALHOST"]) {
      for (const host of ["127.0.0.1", "::1", "localhost", "[::1]", "0:0:0:0:0:0:0:1"]) expect(decideListenAddress(listen(entry), host), `${entry} -> ${host}`).toBeNull();
    }
  });

  it("rejects the wildcards unless that exact wildcard is listed; loopback never admits them", () => {
    for (const wildcard of ["0.0.0.0", "::", "", "0:0:0:0:0:0:0:0", "[::]"]) {
      const b = decideListenAddress(listen("127.0.0.1", "::1", "localhost"), wildcard);
      expect(b, JSON.stringify(wildcard)).toMatchObject({ feature: "daemons", setting: "daemons.allowedListenAddresses" });
      expect(b!.message).toContain("blocked by administrator policy: daemons");
    }
    expect(decideListenAddress(listen("0.0.0.0"), "0.0.0.0")).toBeNull();
    expect(decideListenAddress(listen("::"), "::")).toBeNull();
    expect(decideListenAddress(listen("0.0.0.0"), "::")).not.toBeNull();
    expect(decideListenAddress(listen("0.0.0.0"), "127.0.0.1")).not.toBeNull();
  });

  it("matches other literals exactly (IPv6 canonicalised) and rejects unlisted ones", () => {
    expect(decideListenAddress(listen("10.0.0.5"), "10.0.0.5")).toBeNull();
    expect(decideListenAddress(listen("10.0.0.5"), "10.0.0.6")).not.toBeNull();
    expect(decideListenAddress(listen("fe80::1"), "[FE80:0:0:0:0:0:0:1]")).toBeNull();
    expect(decideListenAddress(listen("10.0.0.5"), "127.0.0.1")).not.toBeNull();
  });

  it("never resolves DNS names: a name passes only when it is itself listed", () => {
    expect(decideListenAddress(listen("127.0.0.1"), "corp.example")).not.toBeNull();
    expect(decideListenAddress(listen("corp.example"), "CORP.example")).toBeNull();
    expect(decideListenAddress(listen("corp.example"), "other.example")).not.toBeNull();
    expect(decideListenAddress(listen("corp.example"), "10.0.0.5")).not.toBeNull();
  });

  it("an empty list allows nothing", () => {
    expect(decideListenAddress(listen(), "127.0.0.1")).not.toBeNull();
  });
});

/**
 * Pack-level behavior of pinned GitHub plugins (ADR 0050): manifest validation,
 * back-compat for unpinned entries, ADR 0002 policy, the lock as Geode-written
 * state, and the consent screen. Uses an injected installer; the real
 * resolver/installer is covered in pinned-github-plugins.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePolicy, type ManagedPolicy } from "../../src/renderer/policy";
import { describeGithubPin, renderVaultPackPlugin, type ConsentNode } from "../../src/renderer/vault-pack-consent";
import type { VaultPackPluginSummary } from "../../src/shared/vault-pack-types";
import {
  applyVaultPack,
  classifyVaultPath,
  DEFAULT_MIN_RELEASE_AGE_DAYS,
  inspectVaultPack,
  validateVaultPackManifest,
  VaultPackError,
  type InstallCommunityFn,
} from "../../src/main/vault-pack";
import { readPluginLock } from "../../src/main/plugin-lock";
import { VaultPackService } from "../../src/main/vault-pack-service";
import { buildPackZip } from "./helpers/vault-pack-fixtures";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmpVault(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pin-pack-"));
  dirs.push(d);
  return path.join(d, "vault");
}
const buf = (data: Buffer) => ({ kind: "buffer", data }) as const;
const HASHES = { "manifest.json": "a".repeat(64), "main.js": "b".repeat(64) };

/** An installer that records its calls and reports a resolved release. */
function fakeInstaller(report: { version?: string; ref?: string; fileHashes?: Record<string, string> } | null = { version: "1.5.0", ref: "v1.5.0", fileHashes: HASHES }) {
  const calls: Array<{ spec: string; opts: Parameters<InstallCommunityFn>[2] }> = [];
  const install: InstallCommunityFn = async (root, spec, opts) => {
    calls.push({ spec, opts });
    const id = spec.split("/")[1];
    await fs.mkdir(path.join(root, ".geode/plugins", id), { recursive: true });
    await fs.writeFile(path.join(root, ".geode/plugins", id, "main.js"), "x");
    return { id, ...(report ?? {}) };
  };
  return { install, calls };
}

describe("manifest: range and minReleaseAgeDays", () => {
  const base = { packVersion: 1, id: "acme", name: "Acme", version: "1.0.0", contentSha256: "a".repeat(64) };
  const gh = (extra: Record<string, unknown>) => ({ ...base, plugins: [{ id: "p", source: "github", repo: "o/r", ...extra }] });

  it("accepts a valid range and optional minReleaseAgeDays", () => {
    const m = validateVaultPackManifest(gh({ range: "^1.4.0", minReleaseAgeDays: 0 }));
    expect(m.plugins[0]).toMatchObject({ source: "github", range: "^1.4.0", minReleaseAgeDays: 0 });
    expect(validateVaultPackManifest(gh({ range: ">=1.4.2 <2" })).plugins[0]).toMatchObject({ range: ">=1.4.2 <2" });
  });

  it("keeps entries without a range exactly as they were", () => {
    const entry = validateVaultPackManifest(gh({})).plugins[0] as Record<string, unknown>;
    expect(entry).toEqual({ id: "p", source: "github", repo: "o/r", enabled: true, locked: false });
    expect("range" in entry).toBe(false);
  });

  it.each([
    ["not a range", { range: "latest" }],
    ["empty range", { range: "" }],
    ["non-string range", { range: 1 }],
    ["trailing OR", { range: "^1.0.0 ||" }],
    ["negative age", { range: "^1", minReleaseAgeDays: -1 }],
    ["non-numeric age", { range: "^1", minReleaseAgeDays: "3" }],
    ["absurd age", { range: "^1", minReleaseAgeDays: 4000 }],
    ["age without a range", { minReleaseAgeDays: 3 }],
  ])("rejects %s", (_label, extra) => {
    expect(() => validateVaultPackManifest(gh(extra))).toThrow(VaultPackError);
  });

  it("names the plugin and shows an example when the range is malformed", () => {
    expect(() => validateVaultPackManifest(gh({ range: "oops" }))).toThrow(/github plugin "p" has a malformed "range" "oops".*\^1\.4\.0/);
  });

  it("does not apply to bundled entries", () => {
    const m = validateVaultPackManifest({ ...base, plugins: [{ id: "p", source: "bundled", sha256: "c".repeat(64), range: "garbage" }] });
    expect(m.plugins[0]).not.toHaveProperty("range");
  });
});

describe("apply: installer options and the lock", () => {
  it("passes the range and the default 3-day floor to the installer and locks the result", async () => {
    const { install, calls } = fakeInstaller();
    const dest = await tmpVault();
    await applyVaultPack(buf(buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin", range: "^1.4.0" }] })), dest, { installCommunity: install });
    expect(calls[0].opts).toEqual({ type: "plugin", range: "^1.4.0", minReleaseAgeDays: DEFAULT_MIN_RELEASE_AGE_DAYS });
    const lock = await readPluginLock(dest);
    expect(lock.plugins["gh-plugin"]).toMatchObject({ repo: "acme/gh-plugin", range: "^1.4.0", minReleaseAgeDays: 3, version: "1.5.0", ref: "v1.5.0", files: HASHES });
  });

  it("an entry's own minReleaseAgeDays is used, and the policy value wins over it", async () => {
    const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin", range: "^1", minReleaseAgeDays: 1 }] });
    const entryOnly = fakeInstaller();
    await applyVaultPack(buf(zip), await tmpVault(), { installCommunity: entryOnly.install });
    expect(entryOnly.calls[0].opts.minReleaseAgeDays).toBe(1);

    const policy: ManagedPolicy = { policyVersion: 1, packs: { minReleaseAgeDays: 14 } };
    const overridden = fakeInstaller();
    const dest = await tmpVault();
    await applyVaultPack(buf(zip), dest, { installCommunity: overridden.install, policy });
    expect(overridden.calls[0].opts.minReleaseAgeDays).toBe(14);
    expect((await readPluginLock(dest)).plugins["gh-plugin"].minReleaseAgeDays).toBe(14);
  });

  it("legacy entry without a range: installer sees only {type:'plugin'}, nothing is locked", async () => {
    const { install, calls } = fakeInstaller({ version: "9.9.9" });
    const dest = await tmpVault();
    const result = await applyVaultPack(buf(buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] })), dest, { installCommunity: install });
    expect(calls[0].opts).toEqual({ type: "plugin" });
    expect(result.enabledPluginIds).toEqual(["gh-plugin"]);
    await expect(fs.stat(path.join(dest, ".geode/plugins.lock.json"))).rejects.toThrow();
  });

  it("refuses a result outside the range and removes its files", async () => {
    const { install } = fakeInstaller({ version: "2.0.0", ref: "v2.0.0", fileHashes: HASHES });
    const dest = await tmpVault();
    const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin", range: "^1.4.0" }] });
    await expect(applyVaultPack(buf(zip), dest, { installCommunity: install })).rejects.toThrow(/resolved version 2\.0\.0 is outside the pack's range "\^1\.4\.0"/);
    await expect(fs.stat(dest)).rejects.toThrow(); // atomic: nothing left behind

    // Tolerant mode (ADR 0014 style) still never keeps or enables the out-of-range code.
    const skip = await tmpVault();
    const result = await applyVaultPack(buf(zip), skip, { installCommunity: install, githubFailure: "skip" });
    expect(result.githubFailures).toHaveLength(1);
    expect(result.enabledPluginIds).toEqual([]);
    await expect(fs.stat(path.join(skip, ".geode/plugins/gh-plugin"))).rejects.toThrow();
  });

  it("refuses an installer that cannot say what it installed for a ranged entry", async () => {
    const { install } = fakeInstaller(null);
    const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin", range: "^1.4.0" }] });
    await expect(applyVaultPack(buf(zip), await tmpVault(), { installCommunity: install })).rejects.toThrow(/did not report the resolved version and file hashes/);
  });

  it("never extracts a lock file from a pack: .geode/plugins.lock.json is Geode-written only", async () => {
    expect(classifyVaultPath(".geode/plugins.lock.json")).toBe("skip");
    const forged = JSON.stringify({ lockVersion: 1, plugins: { evil: { repo: "o/evil", range: "*", minReleaseAgeDays: 0, version: "1.0.0", ref: "v1", files: HASHES, lockedAt: "" } } });
    const zip = buildPackZip({ files: { "Welcome.md": "hi", ".geode/plugins.lock.json": forged } });
    const dest = await tmpVault();
    const result = await applyVaultPack(buf(zip), dest);
    expect(result.summary.skippedCount).toBe(1);
    await expect(fs.stat(path.join(dest, ".geode/plugins.lock.json"))).rejects.toThrow();
  });
});

describe("ADR 0002 policy: packs.requireGithubRange", () => {
  const policy: ManagedPolicy = { policyVersion: 1, packs: { requireGithubRange: true } };

  it("refuses an unpinned GitHub entry at inspect and at apply", async () => {
    const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
    await expect(inspectVaultPack(buf(zip), { policy })).rejects.toThrow(/no version range.*managed policy requires one/);
    const dest = await tmpVault();
    await expect(applyVaultPack(buf(zip), dest, { policy, installCommunity: fakeInstaller().install })).rejects.toThrow(/managed policy requires one/);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it("allows ranged entries and bundled plugins", async () => {
    const zip = buildPackZip({ bundled: [{ id: "acme-tool" }], github: [{ id: "gh-plugin", repo: "acme/gh-plugin", range: "^1" }] });
    const summary = await inspectVaultPack(buf(zip), { policy });
    expect(summary.plugins.map((p) => p.id)).toEqual(["acme-tool", "gh-plugin"]);
  });

  it("is off by default and when the policy is silent", async () => {
    const zip = buildPackZip({ github: [{ id: "gh-plugin", repo: "acme/gh-plugin" }] });
    await expect(inspectVaultPack(buf(zip))).resolves.toBeTruthy();
    await expect(inspectVaultPack(buf(zip), { policy: { policyVersion: 1 } })).resolves.toBeTruthy();
    await expect(inspectVaultPack(buf(zip), { policy: { policyVersion: 1, packs: { requireGithubRange: false } } })).resolves.toBeTruthy();
  });

  it("also refuses ADR 0014 default plugins, which carry no range (skip mode logs, never blocks)", async () => {
    const { install, calls } = fakeInstaller();
    const dest = await tmpVault();
    const zip = buildPackZip({});
    await expect(applyVaultPack(buf(zip), dest, { policy, installCommunity: install, unresolvedGithubPlugins: ["acme/default-one"] })).rejects.toThrow(/acme\/default-one.*no version range/);
    const result = await applyVaultPack(buf(zip), await tmpVault(), { policy, installCommunity: install, unresolvedGithubPlugins: ["acme/default-one"], githubFailure: "skip" });
    expect(result.githubFailures).toEqual([{ repo: "acme/default-one", message: expect.stringContaining("no version range") }]);
    expect(calls).toEqual([]);
  });

  it("the summary reports the effective floor for ranged entries only", async () => {
    const zip = buildPackZip({ github: [{ id: "a-plugin", repo: "o/a", range: "^1" }, { id: "b-plugin", repo: "o/b" }] });
    const summary = await inspectVaultPack(buf(zip), { policy: { policyVersion: 1, packs: { minReleaseAgeDays: 0 } } });
    expect(summary.plugins[0]).toMatchObject({ range: "^1", minReleaseAgeDays: 0 });
    expect(summary.plugins[1].range).toBeUndefined();
    expect(summary.plugins[1].minReleaseAgeDays).toBeUndefined();
  });
});

describe("validatePolicy: packs", () => {
  const quiet = () => {};
  it("parses both keys", () => {
    expect(validatePolicy({ policyVersion: 1, packs: { requireGithubRange: true, minReleaseAgeDays: 0 } })?.packs).toEqual({ requireGithubRange: true, minReleaseAgeDays: 0 });
  });
  it("drops invalid values and keeps the rest (fail open)", () => {
    const warn = console.warn;
    console.warn = quiet;
    try {
      expect(validatePolicy({ policyVersion: 1, packs: { requireGithubRange: "yes", minReleaseAgeDays: 7 } })?.packs).toEqual({ minReleaseAgeDays: 7 });
      expect(validatePolicy({ policyVersion: 1, packs: { minReleaseAgeDays: -2 } })?.packs).toEqual({});
      expect(validatePolicy({ policyVersion: 1, packs: { minReleaseAgeDays: 9999 } })?.packs).toEqual({});
    } finally {
      console.warn = warn;
    }
  });
  it("ignores a non-object packs section", () => {
    const err = console.error;
    console.error = quiet;
    try {
      expect(validatePolicy({ policyVersion: 1, packs: [] })?.packs).toBeUndefined();
    } finally {
      console.error = err;
    }
  });
});

describe("consent screen", () => {
  class FakeNode implements ConsentNode<FakeNode> {
    title = "";
    children: FakeNode[] = [];
    constructor(readonly tag: string, readonly className: string, readonly text: string) {}
    append(...c: FakeNode[]): void {
      this.children.push(...c);
    }
    find(cls: string): FakeNode | undefined {
      return this.children.find((c) => c.className.split(" ").includes(cls));
    }
  }
  const el = (tag: string, className = "", text = "") => new FakeNode(tag, className, text);
  const base: VaultPackPluginSummary = { id: "gh", source: "github", repo: "acme/gh", enabled: true, locked: false, firstParty: false, blocked: false };

  it("shows the range, the resolved version and the age rule for a pinned plugin", () => {
    const item = renderVaultPackPlugin(el, { ...base, range: "^1.4.0", minReleaseAgeDays: 3, resolvedVersion: "1.9.0" });
    expect(item.find("vault-pack-plugin-pin")?.text).toBe("Pinned range ^1.4.0");
    expect(item.find("vault-pack-plugin-pinned")).toBeTruthy();
    expect(item.find("vault-pack-plugin-pin-detail")?.text).toBe("currently resolves to 1.9.0; skips releases newer than 3 days");
    expect(item.find("vault-pack-plugin-unpinned-warning")).toBeUndefined();
  });

  it("says when there is no release-age wait, or when it cannot resolve", () => {
    expect(describeGithubPin({ ...base, range: "^1", minReleaseAgeDays: 0, resolvedVersion: "1.0.0" }).detail).toContain("no release-age wait");
    const blocked = describeGithubPin({ ...base, range: "^1", minReleaseAgeDays: 3, resolveError: "every release is too young" });
    expect(blocked.detail).toContain("cannot be resolved right now: every release is too young");
  });

  it("labels an entry with no range 'Unpinned: latest release' with a warning", () => {
    const item = renderVaultPackPlugin(el, { ...base, resolvedVersion: "2.3.1" });
    expect(item.find("vault-pack-plugin-pin")?.text).toBe("Unpinned: latest release");
    expect(item.find("vault-pack-plugin-unpinned")).toBeTruthy();
    expect(item.find("vault-pack-plugin-pin-detail")?.text).toBe("currently resolves to 2.3.1; the version installed may differ");
    expect(item.find("vault-pack-plugin-unpinned-warning")?.text).toMatch(/not pinned to a version range/);
  });

  it("adds nothing for bundled plugins", () => {
    const item = renderVaultPackPlugin(el, { id: "b", source: "bundled", sha256: "d".repeat(64), name: "B", version: "1.0.0", enabled: true, locked: false, firstParty: false, blocked: false });
    expect(item.find("vault-pack-plugin-pin")).toBeUndefined();
    expect(item.find("vault-pack-plugin-source")?.text).toBe("Bundled in this pack");
    expect(item.find("vault-pack-plugin-hash")?.text).toMatch(/^sha256 d{16}/);
  });
});

describe("service: consent summary is annotated with what each GitHub plugin resolves to", () => {
  it("fills resolvedVersion on success and resolveError on failure, never blocking inspect", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pin-svc-"));
    dirs.push(dir);
    const file = path.join(dir, "acme.vault");
    await fs.writeFile(file, buildPackZip({
      github: [
        { id: "ok-plugin", repo: "o/ok", range: "^1" },
        { id: "young-plugin", repo: "o/young", range: "^1" },
        { id: "latest-plugin", repo: "o/latest" },
      ],
    }));
    const seen: Array<[string, unknown]> = [];
    const service = new VaultPackService({
      policy: () => null,
      geodeVersion: "0.30.0",
      resolveCommunity: async (spec, opts) => {
        seen.push([spec, opts]);
        if (spec === "o/young") throw new Error("Every release of o/young is younger than the minimum release age of 3 days");
        return { repo: spec, type: "plugin", id: "x", name: "X", version: spec === "o/ok" ? "1.4.2" : "5.0.0", source: "release", ref: "v" };
      },
    });
    service.grantPath(1, file);
    const offer = await service.inspect(1, file);
    const byId = Object.fromEntries(offer.summary.plugins.map((p) => [p.id, p]));
    expect(byId["ok-plugin"].resolvedVersion).toBe("1.4.2");
    expect(byId["young-plugin"].resolveError).toMatch(/younger than the minimum release age/);
    expect(byId["latest-plugin"].resolvedVersion).toBe("5.0.0");
    expect(seen.find(([s]) => s === "o/ok")?.[1]).toEqual({ type: "plugin", range: "^1", minReleaseAgeDays: 3 });
    expect(seen.find(([s]) => s === "o/latest")?.[1]).toEqual({ type: "plugin" });
  });
});

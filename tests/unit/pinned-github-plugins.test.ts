/**
 * Semver-pinned GitHub plugins (ADR 0050, "Pinned GitHub plugins"): range
 * resolution against the release list, the release-age floor, the
 * `.geode/plugins.lock.json` record, and lock enforcement on later installs.
 * Runs the real resolver and installer against a fake GitHub.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCommunity, resolveCommunity } from "../../src/main/community";
import { selectReleaseInRange, type GithubRelease } from "../../src/main/github-resolve";
import { readPluginLock } from "../../src/main/plugin-lock";
import { applyVaultPack } from "../../src/main/vault-pack";
import { buildPackZip } from "./helpers/vault-pack-fixtures";

const API = "https://pinned-plugins.test";
const REPO = "acme/pinned-plugin";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const tempDirs: string[] = [];
const originalApiBase = process.env.GEODE_GITHUB_API_BASE;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalApiBase === undefined) delete process.env.GEODE_GITHUB_API_BASE;
  else process.env.GEODE_GITHUB_API_BASE = originalApiBase;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pinned-"));
  tempDirs.push(d);
  return d;
}

interface FakeRelease {
  tag: string;
  /** manifest.json `version`; defaults to the tag without a leading v. */
  manifestVersion?: string;
  publishedDaysAgo: number;
  prerelease?: boolean;
  main?: string;
}
const mainOf = (r: FakeRelease) => r.main ?? `module.exports = class Pinned { /* ${r.tag} */ };`;

/** Installs a fake GitHub API; `releases` is mutable so a test can publish more later. */
function fakeGithub(releases: FakeRelease[]): void {
  process.env.GEODE_GITHUB_API_BASE = API;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === `${API}/repos/${REPO}/releases`) {
      const body: GithubRelease[] = releases.map((r) => ({
        tag_name: r.tag,
        prerelease: r.prerelease ?? false,
        published_at: daysAgo(r.publishedDaysAgo),
        assets: ["manifest.json", "main.js"].map((name) => ({ name, browser_download_url: `${API}/dl/${r.tag}/${name}` })),
      }));
      return new Response(JSON.stringify(body));
    }
    const m = /\/dl\/([^/]+)\/(manifest\.json|main\.js)$/.exec(url);
    const release = m && releases.find((r) => r.tag === m[1]);
    if (!release) return new Response("not found", { status: 404 });
    if (m![2] === "main.js") return new Response(mainOf(release));
    return new Response(JSON.stringify({
      id: "pinned-plugin", name: "Pinned Plugin", version: release.manifestVersion ?? release.tag.replace(/^v/, ""),
      minAppVersion: "0.1.0", description: "fixture", author: "Acme",
    }));
  }));
}

const STANDARD: FakeRelease[] = [
  { tag: "v1.4.0", publishedDaysAgo: 60 },
  { tag: "v1.5.0", publishedDaysAgo: 30 },
  { tag: "v1.9.0", publishedDaysAgo: 10 },
  { tag: "v2.0.0", publishedDaysAgo: 5 },
];

describe("selectReleaseInRange", () => {
  const rel = (tag: string, days: number, extra: Partial<GithubRelease> = {}): GithubRelease =>
    ({ tag_name: tag, prerelease: false, published_at: daysAgo(days), assets: [], ...extra });
  const pick = (releases: GithubRelease[], range: string, minReleaseAgeDays?: number) =>
    selectReleaseInRange(releases, REPO, { range, minReleaseAgeDays, now: NOW }).tag_name;

  it("resolves the highest satisfying release, not the latest or the newest-published", () => {
    const releases = [rel("v2.0.0", 5), rel("v1.9.0", 20), rel("v1.10.0", 40), rel("v1.4.9", 90)];
    expect(pick(releases, "^1.4.0")).toBe("v1.10.0"); // 1.10.0 > 1.9.0 even though published earlier
    expect(pick(releases, ">=1.4.2 <2")).toBe("v1.10.0");
    expect(pick(releases, "~1.4.0")).toBe("v1.4.9");
  });

  it("skips drafts, non-semver tags and prereleases unless the range names a prerelease", () => {
    const releases = [
      rel("v1.6.0-beta.1", 30, { prerelease: true }),
      rel("v1.5.0", 40),
      rel("nightly", 1),
      rel("v1.7.0", 1, { draft: true }),
    ];
    expect(pick(releases, "^1.4.0")).toBe("v1.5.0");
    expect(pick(releases, "^1.6.0-beta.0")).toBe("v1.6.0-beta.1");
  });

  it("skips releases newer than minReleaseAgeDays when an older one satisfies", () => {
    const releases = [rel("v1.9.0", 1), rel("v1.8.0", 2.5), rel("v1.7.0", 9)];
    expect(pick(releases, "^1.0.0", 3)).toBe("v1.7.0");
    expect(pick(releases, "^1.0.0", 2)).toBe("v1.8.0");
    expect(pick(releases, "^1.0.0", 0)).toBe("v1.9.0");
  });

  it("fails clearly, never taking a young release, when every satisfying release is too new", () => {
    const releases = [rel("v1.9.0", 1), rel("v1.8.0", 2), rel("v2.0.0", 90)];
    expect(() => pick(releases, "^1.0.0", 3)).toThrow(/younger than the minimum release age of 3 days.*v1\.9\.0.*1 day\(s\) ago/);
  });

  it("fails clearly when nothing satisfies the range at all", () => {
    expect(() => pick([rel("v2.0.0", 90)], "^1.0.0", 3)).toThrow(/No release of acme\/pinned-plugin satisfies version range "\^1\.0\.0"/);
  });

  it("treats an unreadable published_at as too new rather than trusting it", () => {
    const releases = [rel("v1.9.0", 0, { published_at: "not a date" })];
    expect(() => pick(releases, "^1.0.0", 3)).toThrow(/younger than/);
    expect(pick(releases, "^1.0.0", 0)).toBe("v1.9.0");
  });
});

describe("installCommunity with a range", () => {
  it("installs the highest in-range release past the age floor and reports hashes", async () => {
    fakeGithub(STANDARD);
    const root = await tmp();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const result = await installCommunity(root, REPO, { type: "plugin", range: "^1.4.0", minReleaseAgeDays: 3 });
    expect(result).toMatchObject({ id: "pinned-plugin", version: "1.9.0", ref: "v1.9.0" });
    expect(result.fileHashes).toEqual({
      "manifest.json": sha(JSON.stringify({ id: "pinned-plugin", name: "Pinned Plugin", version: "1.9.0", minAppVersion: "0.1.0", description: "fixture", author: "Acme" })),
      "main.js": sha(mainOf(STANDARD[2])),
    });
    // The installer alone does not lock; the caller (pack apply) records the lock.
    await expect(fs.stat(path.join(root, ".geode/plugins.lock.json"))).rejects.toThrow();
  });

  it("refuses a release whose manifest version is outside the range (a lying tag)", async () => {
    fakeGithub([{ tag: "v1.9.0", manifestVersion: "3.0.0", publishedDaysAgo: 30 }]);
    const root = await tmp();
    await expect(installCommunity(root, REPO, { type: "plugin", range: "^1.4.0" })).rejects.toThrow(/declares version 3\.0\.0.*outside version range/);
    await expect(fs.stat(path.join(root, ".geode/plugins/pinned-plugin"))).rejects.toThrow();
  });

  it("refuses an explicit tag outside the range", async () => {
    fakeGithub(STANDARD);
    const root = await tmp();
    await expect(installCommunity(root, REPO, { type: "plugin", range: "^1.4.0", tag: "v2.0.0" })).rejects.toThrow(/outside version range/);
  });

  it("without a range behaves as before: newest by publish date, no age floor, prereleases allowed", async () => {
    fakeGithub(STANDARD);
    const root = await tmp();
    const result = await installCommunity(root, REPO, { type: "plugin" });
    expect(result.version).toBe("2.0.0");
    expect(await fs.readdir(path.join(root, ".geode"))).toEqual(["plugins"]);
  });
});

describe("pack apply records a lock, and the lock governs later installs", () => {
  const packWith = (range: string, extra: { minReleaseAgeDays?: number } = {}) =>
    ({ kind: "buffer", data: buildPackZip({ github: [{ id: "pinned-plugin", repo: REPO, range, ...extra }] }) }) as const;

  async function createLockedVault(): Promise<string> {
    fakeGithub(STANDARD);
    const dest = path.join(await tmp(), "vault");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const result = await applyVaultPack(packWith("^1.4.0"), dest);
    vi.useRealTimers();
    expect(result.enabledPluginIds).toEqual(["pinned-plugin"]);
    return dest;
  }

  it("writes the resolved version and per-file sha256 to .geode/plugins.lock.json", async () => {
    const dest = await createLockedVault();
    const lock = await readPluginLock(dest);
    expect(lock.plugins["pinned-plugin"]).toMatchObject({
      repo: REPO, range: "^1.4.0", minReleaseAgeDays: 3, version: "1.9.0", ref: "v1.9.0",
    });
    const installedMain = await fs.readFile(path.join(dest, ".geode/plugins/pinned-plugin/main.js"));
    const installedManifest = await fs.readFile(path.join(dest, ".geode/plugins/pinned-plugin/manifest.json"));
    expect(lock.plugins["pinned-plugin"].files).toEqual({
      "main.js": createHash("sha256").update(installedMain).digest("hex"),
      "manifest.json": createHash("sha256").update(installedManifest).digest("hex"),
    });
    // The staging directory's install scratch space is gone.
    expect((await fs.readdir(path.join(dest, ".geode"))).sort()).toEqual(["plugins", "plugins.json", "plugins.lock.json"]);
  });

  it("rejects bytes that differ from the lock for the locked version, leaving the install intact", async () => {
    const dest = await createLockedVault();
    const original = await fs.readFile(path.join(dest, ".geode/plugins/pinned-plugin/main.js"), "utf8");
    // Same tag, same manifest version, different bytes: a re-published release.
    fakeGithub(STANDARD.map((r) => (r.tag === "v1.9.0" ? { ...r, main: "module.exports = class Evil {};" } : r)));
    await expect(installCommunity(dest, REPO, { type: "plugin" })).rejects.toThrow(/main\.js failed plugins\.lock\.json SHA-256 verification/);
    expect(await fs.readFile(path.join(dest, ".geode/plugins/pinned-plugin/main.js"), "utf8")).toBe(original);
    expect((await fs.readdir(path.join(dest, ".geode"))).filter((n) => n.startsWith("install-"))).toEqual([]);
  });

  it("accepts identical bytes for the locked version (a plain reinstall)", async () => {
    const dest = await createLockedVault();
    await expect(installCommunity(dest, REPO, { type: "plugin" })).resolves.toMatchObject({ version: "1.9.0" });
  });

  it("keeps updates inside the range: the resolve skips 2.0.0 and lands on the newest in-range release", async () => {
    const dest = await createLockedVault();
    fakeGithub([...STANDARD, { tag: "v1.10.0", publishedDaysAgo: 4 }, { tag: "v3.0.0", publishedDaysAgo: 40 }]);
    const preview = await resolveCommunity(REPO, { type: "plugin" }, dest);
    expect(preview.version).toBe("1.10.0");
    // The renderer's update path installs by tag with the admitted preview; the lock moves forward.
    const updated = await installCommunity(dest, REPO, { type: "plugin", tag: preview.ref, expected: preview });
    expect(updated.version).toBe("1.10.0");
    const lock = await readPluginLock(dest);
    expect(lock.plugins["pinned-plugin"]).toMatchObject({ version: "1.10.0", ref: "v1.10.0", range: "^1.4.0" });
    expect(lock.plugins["pinned-plugin"].files["main.js"]).toBe(sha(mainOf({ tag: "v1.10.0", publishedDaysAgo: 4 })));
  });

  it("refuses an install that resolves outside the locked range, even if the caller asks for it", async () => {
    const dest = await createLockedVault();
    await expect(installCommunity(dest, REPO, { type: "plugin", tag: "v2.0.0" })).rejects.toThrow(/outside version range "\^1\.4\.0"/);
    // A caller-supplied wider range cannot widen the lock either.
    await expect(installCommunity(dest, REPO, { type: "plugin", range: ">=1", tag: "v2.0.0" })).rejects.toThrow(/outside the locked version range "\^1\.4\.0"/);
    expect((await readPluginLock(dest)).plugins["pinned-plugin"].version).toBe("1.9.0");
  });

  it("releases the lock when the plugin is uninstalled", async () => {
    const dest = await createLockedVault();
    await fs.rm(path.join(dest, ".geode/plugins/pinned-plugin"), { recursive: true });
    await expect(installCommunity(dest, REPO, { type: "plugin" })).resolves.toMatchObject({ version: "2.0.0" });
  });

  it("fails the pack, writing nothing, when only too-young releases satisfy the range", async () => {
    fakeGithub([{ tag: "v1.9.0", publishedDaysAgo: 1 }]);
    const parent = await tmp();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await expect(applyVaultPack(packWith("^1.0.0"), path.join(parent, "vault"))).rejects.toThrow(/younger than the minimum release age of 3 days/);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("an entry's minReleaseAgeDays: 0 takes the young release", async () => {
    fakeGithub([{ tag: "v1.9.0", publishedDaysAgo: 1 }]);
    const dest = path.join(await tmp(), "vault");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await applyVaultPack(packWith("^1.0.0", { minReleaseAgeDays: 0 }), dest);
    expect((await readPluginLock(dest)).plugins["pinned-plugin"]).toMatchObject({ version: "1.9.0", minReleaseAgeDays: 0 });
  });

  it("the ADR 0002 policy value overrides the entry (waive to 0, or raise)", async () => {
    fakeGithub([{ tag: "v1.9.0", publishedDaysAgo: 1 }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const waived = path.join(await tmp(), "vault");
    await applyVaultPack(packWith("^1.0.0"), waived, { policy: { policyVersion: 1, packs: { minReleaseAgeDays: 0 } } });
    expect((await readPluginLock(waived)).plugins["pinned-plugin"].minReleaseAgeDays).toBe(0);

    const raised = path.join(await tmp(), "vault");
    await expect(
      applyVaultPack(packWith("^1.0.0", { minReleaseAgeDays: 0 }), raised, { policy: { policyVersion: 1, packs: { minReleaseAgeDays: 7 } } }),
    ).rejects.toThrow(/minimum release age of 7 days/);
  });
});

/**
 * Edge cases for semver-pinned GitHub plugins (ADR 0050) beyond the main suites:
 * age-cutoff boundaries, hostile published_at values, prerelease corner cases,
 * lock fail-closed behaviour and lock-vs-explicit-tag handling.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCommunity } from "../../src/main/community";
import { selectReleaseInRange, type GithubRelease } from "../../src/main/github-resolve";
import { readPluginLock, recordPluginLock } from "../../src/main/plugin-lock";
import { isValidRange, parseVersion, satisfies } from "../../src/shared/semver-range";

const API = "https://pinned-edge.test";
const REPO = "acme/edge-plugin";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pinned-edge-"));
  tempDirs.push(d);
  return d;
}

const rel = (tag: string, days: number, extra: Partial<GithubRelease> = {}): GithubRelease =>
  ({ tag_name: tag, prerelease: false, published_at: daysAgo(days), assets: [], ...extra });
const pick = (releases: GithubRelease[], range: string, minReleaseAgeDays?: number) =>
  selectReleaseInRange(releases, REPO, { range, minReleaseAgeDays, now: NOW }).tag_name;

describe("selectReleaseInRange: age cutoff edges", () => {
  it("accepts a release exactly minReleaseAgeDays old (inclusive floor)", () => {
    expect(pick([rel("v1.0.0", 3)], "^1", 3)).toBe("v1.0.0");
  });
  it("rejects a release one second short of the floor", () => {
    const r = [{ ...rel("v1.0.0", 3), published_at: new Date(NOW - 3 * DAY + 1000).toISOString() }];
    expect(() => pick(r, "^1", 3)).toThrow(/younger than/);
  });
  it("treats a published_at in the future as too young", () => {
    expect(() => pick([rel("v1.0.0", -2)], "^1", 3)).toThrow(/younger than the minimum release age of 3 days/);
  });
  it.each(["", "null-ish", "Invalid Date"])("treats unreadable published_at %j as too young under a floor", (bad) => {
    expect(() => pick([rel("v1.0.0", 0, { published_at: bad })], "^1", 3)).toThrow(/at an unknown time|younger/);
  });
  it("tolerates a missing published_at field (undefined) the same way", () => {
    const r = [{ tag_name: "v1.0.0", prerelease: false, assets: [] } as unknown as GithubRelease];
    expect(() => pick(r, "^1", 1)).toThrow(/unknown time/);
  });
  it("falls through a young top release and an undated one to the next mature candidate", () => {
    const rs = [rel("v1.3.0", 1), rel("v1.2.0", 0, { published_at: "garbage" }), rel("v1.1.0", 30)];
    expect(pick(rs, "^1", 3)).toBe("v1.1.0");
  });
  it("a negative floor behaves like zero", () => {
    expect(pick([rel("v1.0.0", 0)], "^1", -5)).toBe("v1.0.0");
  });
  it("singular wording for a one day floor", () => {
    expect(() => pick([rel("v1.0.0", 0)], "^1", 1)).toThrow(/minimum release age of 1 day /);
  });
});

describe("selectReleaseInRange: prerelease handling", () => {
  it("excludes a semver prerelease tag even when GitHub did not flag it as prerelease", () => {
    expect(pick([rel("v1.6.0-rc.1", 30), rel("v1.5.0", 30)], "^1.4.0", 0)).toBe("v1.5.0");
  });
  it("excludes a GitHub-flagged prerelease whose tag looks stable, unless the range opts in", () => {
    expect(pick([rel("v1.6.0", 30, { prerelease: true }), rel("v1.5.0", 30)], "^1.4.0", 0)).toBe("v1.5.0");
  });
  it("a prerelease-opt-in range still prefers a higher stable release", () => {
    expect(pick([rel("v1.5.0-beta.1", 30, { prerelease: true }), rel("v1.5.0", 30)], "^1.5.0-beta.0", 0)).toBe("v1.5.0");
  });
  it("a prerelease-opt-in range does not unlock prereleases on other tuples", () => {
    expect(() => pick([rel("v1.6.0-beta.1", 30, { prerelease: true })], "^1.5.0-beta.0", 0)).toThrow(/No release/);
  });
  it("skips drafts even when they are the only match", () => {
    expect(() => pick([rel("v1.0.0", 30, { draft: true })], "^1", 0)).toThrow(/No release/);
  });
  it("an empty release list fails clearly", () => {
    expect(() => pick([], "^1", 0)).toThrow(/No release of acme\/edge-plugin satisfies/);
  });
});

describe("semver: additional corner cases", () => {
  it.each([
    ["<2.0.0", "2.0.0-beta.1", false],
    ["<2.0.0-beta.5", "2.0.0-beta.1", true],
    [">=1.5.0-beta.1 <2", "1.5.0-beta.2", true],
    [">=1.5.0-beta.1 <2", "1.6.0-beta.1", false],
    ["^1.2.3-beta.2", "1.2.3-beta.1", false],
    ["^1.2.3-beta.2", "1.2.3", true],
    ["^1.0.0 || >=3.0.0-rc.1", "3.0.0-rc.2", true],
    ["^1.0.0 || >=3.0.0-rc.1", "2.0.0-rc.2", false],
    ["1.0.0", "1.0.0+build.9", true],
    ["^1.0.0", "v1.2.0", true],
    [">1.2.3", "1.2.3-beta.1", false],
    ["<1.0.0", "0.9.9", true],
    ["^0.0.0", "0.0.0", true],
    ["^0.0", "0.0.9", true],
    ["^0.0", "0.1.0", false],
    ["~0.2", "0.2.9", true],
    ["<*", "0.0.1", false],
    [">*", "9.0.0", false],
    ["<=*", "9.0.0", true],
    ["^1.0.0 ^1.2.0", "1.1.0", false],
    ["^1.0.0 ^1.2.0", "1.3.0", true],
  ])("range %j vs %s -> %s", (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
  it.each(["1.2.3 - ", " - 1.2.3", "1.2.3 -", "99999999999999999999.0.0", ">=1.0.0 <", "^1.0.0 ||| ^2", "^ ", "1.2.3-", "*-beta"])(
    "rejects malformed range %j",
    (r) => {
      expect(isValidRange(r)).toBe(false);
    },
  );
  it("rejects versions whose numeric parts overflow safe integers", () => {
    expect(parseVersion("1.2.99999999999999999999")).toBeNull();
    expect(parseVersion("1.2.3-99999999999999999999")).toBeNull();
  });
  it("is not slow on adversarial input", () => {
    const start = Date.now();
    isValidRange("^" + "1.".repeat(120) + "x");
    isValidRange(" ".repeat(250) + "^1");
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("plugin lock: fail closed and explicit tags", () => {
  interface FakeRelease { tag: string; days: number; main?: string }
  function fakeGithub(releases: FakeRelease[]): void {
    process.env.GEODE_GITHUB_API_BASE = API;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${API}/repos/${REPO}/releases`) {
        return new Response(JSON.stringify(releases.map((r) => ({
          tag_name: r.tag, prerelease: false, published_at: daysAgo(r.days),
          assets: ["manifest.json", "main.js"].map((name) => ({ name, browser_download_url: `${API}/dl/${r.tag}/${name}` })),
        }))));
      }
      const m = /\/dl\/([^/]+)\/(manifest\.json|main\.js)$/.exec(url);
      const r = m && releases.find((x) => x.tag === m[1]);
      if (!r) return new Response("nope", { status: 404 });
      if (m![2] === "main.js") return new Response(r.main ?? `// ${r.tag}`);
      return new Response(JSON.stringify({ id: "edge-plugin", name: "Edge", version: r.tag.replace(/^v/, ""), minAppVersion: "0.1.0", description: "d", author: "a" }));
    }));
  }
  async function lockedVault(): Promise<string> {
    const root = await tmp();
    await fs.mkdir(path.join(root, ".geode/plugins/edge-plugin"), { recursive: true });
    await recordPluginLock(root, "edge-plugin", {
      repo: REPO, range: "^1.0.0", minReleaseAgeDays: 3, version: "1.0.0", ref: "v1.0.0",
      files: { "manifest.json": sha("x"), "main.js": sha("y") }, lockedAt: new Date(NOW).toISOString(),
    });
    return root;
  }

  it("refuses to install when the lock file is corrupt rather than ignoring it", async () => {
    fakeGithub([{ tag: "v1.0.0", days: 30 }]);
    const root = await lockedVault();
    await fs.writeFile(path.join(root, ".geode/plugins.lock.json"), "{ not json");
    await expect(installCommunity(root, REPO, { type: "plugin" })).rejects.toThrow(/plugins\.lock\.json/);
  });
  it("refuses a lock entry carrying an invalid range", async () => {
    fakeGithub([{ tag: "v1.0.0", days: 30 }]);
    const root = await lockedVault();
    const lock = JSON.parse(await fs.readFile(path.join(root, ".geode/plugins.lock.json"), "utf8"));
    lock.plugins["edge-plugin"].range = "latest";
    await fs.writeFile(path.join(root, ".geode/plugins.lock.json"), JSON.stringify(lock));
    await expect(installCommunity(root, REPO, { type: "plugin" })).rejects.toThrow(/invalid "range"/);
  });
  it("refuses a lock entry with a malformed file hash", async () => {
    fakeGithub([{ tag: "v1.0.0", days: 30 }]);
    const root = await lockedVault();
    const lock = JSON.parse(await fs.readFile(path.join(root, ".geode/plugins.lock.json"), "utf8"));
    lock.plugins["edge-plugin"].files["main.js"] = "abc";
    await fs.writeFile(path.join(root, ".geode/plugins.lock.json"), JSON.stringify(lock));
    await expect(installCommunity(root, REPO, { type: "plugin" })).rejects.toThrow(/invalid hash/);
  });
  it("matches the locked repo case-insensitively (a differently cased spec cannot dodge the lock)", async () => {
    fakeGithub([{ tag: "v1.0.0", days: 30 }, { tag: "v2.0.0", days: 30 }]);
    const root = await lockedVault();
    await expect(installCommunity(root, "Acme/Edge-Plugin", { type: "plugin", tag: "v2.0.0" })).rejects.toThrow();
    expect((await readPluginLock(root)).plugins["edge-plugin"].version).toBe("1.0.0");
  });
  // Regression (QA 2026-10-22): resolveItem used to skip the age floor when a tag was given.
  it("an explicit tag younger than the locked minReleaseAgeDays is still refused", async () => {
    fakeGithub([{ tag: "v1.0.0", days: 30 }, { tag: "v1.1.0", days: 1 }]);
    const root = await lockedVault();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await expect(installCommunity(root, REPO, { type: "plugin", tag: "v1.1.0" })).rejects.toThrow(/younger|release age/);
    expect((await readPluginLock(root)).plugins["edge-plugin"].version).toBe("1.0.0");
  });
});

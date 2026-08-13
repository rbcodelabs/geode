import { describe, expect, it } from "vitest";
import {
  classifyItem,
  parseRepoSpec,
  readManifestMeta,
  resolveItem,
  selectRelease,
  type GithubRelease,
  type HttpGet,
  type HttpResponse,
} from "../../src/main/github-resolve";

// --- parseRepoSpec ----------------------------------------------------------

describe("parseRepoSpec", () => {
  it("parses a plain owner/repo", () => {
    expect(parseRepoSpec("tfthacker/obsidian42-brat")).toEqual({
      owner: "tfthacker",
      repo: "obsidian42-brat",
    });
  });

  it("strips a full github URL and a trailing .git", () => {
    expect(parseRepoSpec("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseRepoSpec("http://www.github.com/owner/repo/")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRepoSpec("  owner/repo  ")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("rejects empty input", () => {
    expect(() => parseRepoSpec("   ")).toThrow(/owner\/repo/);
  });

  it("rejects malformed specs", () => {
    expect(() => parseRepoSpec("not-a-repo")).toThrow();
    expect(() => parseRepoSpec("too/many/parts")).toThrow();
    expect(() => parseRepoSpec("bad repo/name")).toThrow();
  });
});

// --- selectRelease ----------------------------------------------------------

function rel(tag: string, date: string, extra: Partial<GithubRelease> = {}): GithubRelease {
  return { tag_name: tag, prerelease: false, published_at: date, assets: [], ...extra };
}

describe("selectRelease", () => {
  it("returns the newest by published_at, not tag string", () => {
    const releases = [
      rel("1.9.0", "2026-01-01T00:00:00Z"),
      rel("1.10.0", "2026-03-01T00:00:00Z"),
      rel("1.2.0", "2026-02-01T00:00:00Z"),
    ];
    expect(selectRelease(releases)?.tag_name).toBe("1.10.0");
  });

  it("returns the exact release for a pinned tag", () => {
    const releases = [rel("1.0.0", "2026-01-01T00:00:00Z"), rel("2.0.0", "2026-02-01T00:00:00Z")];
    expect(selectRelease(releases, { tag: "1.0.0" })?.tag_name).toBe("1.0.0");
    expect(selectRelease(releases, { tag: "9.9.9" })).toBeNull();
  });

  it("excludes prereleases unless includePrerelease", () => {
    const releases = [
      rel("1.0.0", "2026-01-01T00:00:00Z"),
      rel("2.0.0-beta", "2026-02-01T00:00:00Z", { prerelease: true }),
    ];
    expect(selectRelease(releases, { includePrerelease: false })?.tag_name).toBe("1.0.0");
    expect(selectRelease(releases, { includePrerelease: true })?.tag_name).toBe("2.0.0-beta");
  });

  it("always excludes drafts", () => {
    const releases = [
      rel("1.0.0", "2026-01-01T00:00:00Z"),
      rel("2.0.0", "2026-02-01T00:00:00Z", { draft: true }),
    ];
    expect(selectRelease(releases)?.tag_name).toBe("1.0.0");
  });

  it("returns null for an empty list", () => {
    expect(selectRelease([])).toBeNull();
  });
});

// --- classifyItem -----------------------------------------------------------

describe("classifyItem", () => {
  it("classifies main.js as a plugin", () => {
    expect(classifyItem(["manifest.json", "main.js", "styles.css"])).toBe("plugin");
  });
  it("classifies theme.css (no main.js) as a theme", () => {
    expect(classifyItem(["manifest.json", "theme.css"])).toBe("theme");
  });
  it("is case-insensitive", () => {
    expect(classifyItem(["MAIN.JS"])).toBe("plugin");
  });
  it("returns ambiguous when both or neither are present", () => {
    expect(classifyItem(["main.js", "theme.css"])).toBe("ambiguous");
    expect(classifyItem(["manifest.json"])).toBe("ambiguous");
  });
});

// --- readManifestMeta -------------------------------------------------------

describe("readManifestMeta", () => {
  it("reads id/name/version from a plugin manifest", () => {
    const raw = JSON.stringify({ id: "my-plugin", name: "My Plugin", version: "1.2.3" });
    expect(readManifestMeta(raw)).toEqual({ id: "my-plugin", name: "My Plugin", version: "1.2.3" });
  });

  it("falls back to name for id on a theme manifest (no id field)", () => {
    const raw = JSON.stringify({ name: "Cool Theme", version: "0.4.0" });
    expect(readManifestMeta(raw)).toEqual({ id: "Cool Theme", name: "Cool Theme", version: "0.4.0" });
  });

  it("throws on invalid JSON", () => {
    expect(() => readManifestMeta("{not json")).toThrow(/valid JSON/);
  });

  it("throws when version is missing", () => {
    expect(() => readManifestMeta(JSON.stringify({ id: "x" }))).toThrow(/version/);
  });
});

// --- resolveItem (with a fake HttpGet) --------------------------------------

const API = "https://api.test";
const RAW = "https://raw.test";

/** Build a fake HttpGet from a url→response map; unmapped urls 404. */
function fakeGet(routes: Record<string, Partial<HttpResponse> & { text: string }>): HttpGet {
  return async (url) => {
    const hit = routes[url];
    if (!hit) return { status: 404, ok: false, text: "" };
    return { status: hit.status ?? 200, ok: hit.ok ?? true, text: hit.text };
  };
}

describe("resolveItem", () => {
  it("resolves a plugin from the newest release's assets", async () => {
    const releases: GithubRelease[] = [
      {
        tag_name: "1.4.0",
        prerelease: false,
        published_at: "2026-05-01T00:00:00Z",
        assets: [
          { name: "manifest.json", browser_download_url: `${API}/dl/manifest.json` },
          { name: "main.js", browser_download_url: `${API}/dl/main.js` },
          { name: "styles.css", browser_download_url: `${API}/dl/styles.css` },
        ],
      },
    ];
    const get = fakeGet({
      [`${API}/repos/o/r/releases`]: { text: JSON.stringify(releases) },
      [`${API}/dl/manifest.json`]: {
        text: JSON.stringify({ id: "o-plugin", name: "O Plugin", version: "1.4.0" }),
      },
    });

    const resolved = await resolveItem({ owner: "o", repo: "r" }, { get, apiBase: API, rawBase: RAW });
    expect(resolved).toEqual({
      type: "plugin",
      id: "o-plugin",
      name: "O Plugin",
      version: "1.4.0",
      source: "release",
      ref: "1.4.0",
      files: [
        { name: "manifest.json", url: `${API}/dl/manifest.json` },
        { name: "main.js", url: `${API}/dl/main.js` },
        { name: "styles.css", url: `${API}/dl/styles.css` },
      ],
    });
  });

  it("omits styles.css when the release has none", async () => {
    const releases: GithubRelease[] = [
      {
        tag_name: "1.0.0",
        prerelease: false,
        published_at: "2026-05-01T00:00:00Z",
        assets: [
          { name: "manifest.json", browser_download_url: `${API}/m` },
          { name: "main.js", browser_download_url: `${API}/j` },
        ],
      },
    ];
    const get = fakeGet({
      [`${API}/repos/o/r/releases`]: { text: JSON.stringify(releases) },
      [`${API}/m`]: { text: JSON.stringify({ id: "p", name: "P", version: "1.0.0" }) },
    });
    const resolved = await resolveItem(
      { owner: "o", repo: "r" },
      { get, apiBase: API, rawBase: RAW },
      { type: "plugin" }
    );
    expect(resolved.files.map((f) => f.name)).toEqual(["manifest.json", "main.js"]);
  });

  it("falls back to raw default-branch files when a plugin repo has no releases", async () => {
    const get = fakeGet({
      [`${API}/repos/o/r/releases`]: { text: "[]" },
      [`${RAW}/o/r/HEAD/manifest.json`]: {
        text: JSON.stringify({ id: "p", name: "P", version: "0.1.0" }),
      },
    });
    const resolved = await resolveItem(
      { owner: "o", repo: "r" },
      { get, apiBase: API, rawBase: RAW },
      { type: "plugin" }
    );
    expect(resolved.source).toBe("raw");
    expect(resolved.ref).toBe("HEAD");
    expect(resolved.files.map((f) => f.name)).toEqual(["manifest.json", "main.js", "styles.css"]);
    expect(resolved.files[0].url).toBe(`${RAW}/o/r/HEAD/manifest.json`);
  });

  it("resolves a theme from raw default-branch files", async () => {
    const get = fakeGet({
      [`${RAW}/o/r/HEAD/manifest.json`]: {
        text: JSON.stringify({ name: "Nice Theme", version: "2.1.0" }),
      },
    });
    const resolved = await resolveItem(
      { owner: "o", repo: "r" },
      { get, apiBase: API, rawBase: RAW },
      { type: "theme" }
    );
    expect(resolved).toEqual({
      type: "theme",
      id: "Nice Theme",
      name: "Nice Theme",
      version: "2.1.0",
      source: "raw",
      ref: "HEAD",
      files: [
        { name: "manifest.json", url: `${RAW}/o/r/HEAD/manifest.json` },
        { name: "theme.css", url: `${RAW}/o/r/HEAD/theme.css` },
      ],
    });
  });

  it("auto-detects a theme via raw probing when there are no releases", async () => {
    const get = fakeGet({
      [`${API}/repos/o/r/releases`]: { text: "[]" },
      [`${RAW}/o/r/HEAD/theme.css`]: { text: "/* css */" },
      [`${RAW}/o/r/HEAD/manifest.json`]: { text: JSON.stringify({ name: "T", version: "1.0.0" }) },
      // no main.js → not a plugin
    });
    const resolved = await resolveItem({ owner: "o", repo: "r" }, { get, apiBase: API, rawBase: RAW });
    expect(resolved.type).toBe("theme");
  });

  it("throws a clear error when the repo is not found", async () => {
    const get = fakeGet({}); // everything 404s
    await expect(
      resolveItem({ owner: "o", repo: "r" }, { get, apiBase: API, rawBase: RAW }, { type: "plugin" })
    ).rejects.toThrow(/not found/i);
  });

  it("throws when a pinned tag does not exist", async () => {
    const releases: GithubRelease[] = [
      { tag_name: "1.0.0", prerelease: false, published_at: "2026-01-01T00:00:00Z", assets: [] },
    ];
    const get = fakeGet({ [`${API}/repos/o/r/releases`]: { text: JSON.stringify(releases) } });
    await expect(
      resolveItem(
        { owner: "o", repo: "r" },
        { get, apiBase: API, rawBase: RAW },
        { type: "plugin", tag: "9.9.9" }
      )
    ).rejects.toThrow(/9\.9\.9/);
  });

  it("throws ambiguous when auto can't tell plugin from theme over raw", async () => {
    const get = fakeGet({
      [`${API}/repos/o/r/releases`]: { text: "[]" },
      [`${RAW}/o/r/HEAD/main.js`]: { text: "x" },
      [`${RAW}/o/r/HEAD/theme.css`]: { text: "y" },
    });
    await expect(
      resolveItem({ owner: "o", repo: "r" }, { get, apiBase: API, rawBase: RAW })
    ).rejects.toThrow(/plugin or a theme/);
  });
});

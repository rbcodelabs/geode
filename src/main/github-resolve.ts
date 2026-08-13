/**
 * Pure GitHub resolution logic for the community install-from-GitHub feature
 * (see docs/adr/0001-community-install-from-github.md, Phase 0). Given an
 * `owner/repo` spec, works out which files to download and where from —
 * without performing any I/O itself: all HTTP goes through an injected
 * `HttpGet`, so this module is fully unit-testable in the node vitest env
 * with canned responses and has NO electron / renderer / DOM dependencies.
 *
 * The behavior mirrors Obsidian's BRAT plugin (MIT), which this feature
 * reimplements natively rather than hosting:
 *   - PLUGINS ship built assets (main.js, manifest.json, styles.css?) on a
 *     GitHub *Release*; fall back to raw default-branch files only if the
 *     repo has no releases.
 *   - THEMES ship theme.css + manifest.json on the default branch (raw).
 *   - manifest.json's `version` is authoritative, not the git tag.
 *
 * Downloading the resolved files, validating the manifest with
 * `parseManifest`, and writing them atomically into `<vault>/.geode/` happen
 * in the main process (src/main/community.ts) in Phase 1+ — not here.
 */

export type ItemType = "plugin" | "theme";

export interface RepoSpec {
  owner: string;
  repo: string;
}

/** A GitHub release as returned by `GET /repos/{owner}/{repo}/releases`. */
export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface GithubRelease {
  tag_name: string;
  prerelease: boolean;
  draft?: boolean;
  published_at: string; // ISO 8601
  assets: GithubReleaseAsset[];
}

export interface ResolvedFile {
  /** Destination filename inside the item's `.geode/{plugins,themes}/<id>/` dir. */
  name: string;
  /** Absolute URL to download from. */
  url: string;
}

export interface ResolvedItem {
  type: ItemType;
  /** Plugin id, or theme folder name — becomes the on-disk directory. */
  id: string;
  /** Display name from the manifest. */
  name: string;
  /** manifest.json `version` (authoritative). */
  version: string;
  /** manifest.json `minAppVersion`, if present (plugins) — used to guard updates. */
  minAppVersion?: string;
  source: "release" | "raw";
  /** Release tag, or "HEAD" for a raw default-branch install. */
  ref: string;
  files: ResolvedFile[];
}

/**
 * A resolved item flattened to the metadata the renderer/IPC layer needs —
 * no file URLs. Returned by the main-process resolve/install handlers for the
 * modal preview and for recording in community.json. Pure type (no node deps)
 * so both the main and renderer bundles can import it.
 */
export interface CommunityPreview {
  /** "owner/repo" — the normalized add key. */
  repo: string;
  type: ItemType;
  id: string;
  name: string;
  version: string;
  /** manifest.json `minAppVersion`, if present — lets the update-check guard. */
  minAppVersion?: string;
  source: "release" | "raw";
  ref: string;
}

/** Result of a completed install — same shape as the preview. */
export type InstalledResult = CommunityPreview;

/** Minimal HTTP response shape the resolver needs from its injected client. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers?: Record<string, string>;
}

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;

export interface ResolveDeps {
  get: HttpGet;
  /** Default "https://api.github.com". Overridable via GEODE_GITHUB_API_BASE / for tests. */
  apiBase?: string;
  /** Default "https://raw.githubusercontent.com". Overridable via GEODE_GITHUB_RAW_BASE / for tests. */
  rawBase?: string;
}

export interface ResolveOpts {
  /** "auto" (default) sniffs plugin vs. theme from available files. */
  type?: ItemType | "auto";
  /** Pin to a specific release tag instead of the newest. */
  tag?: string;
  /** Include prereleases when picking the newest release. Default true (BRAT-style). */
  includePrerelease?: boolean;
}

export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize a user-entered repo spec into `{ owner, repo }`. Accepts
 * `owner/repo`, a full `https://github.com/owner/repo` URL, and a trailing
 * `.git`. Throws with a clear message on anything else.
 */
export function parseRepoSpec(input: string): RepoSpec {
  let s = input.trim();
  if (!s) throw new Error("Enter a GitHub repository as owner/repo");
  // Strip a full GitHub URL down to owner/repo.
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, ""); // trailing slashes
  if (!REPO_RE.test(s)) {
    throw new Error(`"${input}" is not a valid owner/repo`);
  }
  const [owner, repo] = s.split("/");
  return { owner, repo };
}

/**
 * Pick the release to install. Drafts are always excluded; prereleases are
 * excluded unless `includePrerelease`. With `tag`, returns that exact
 * release; otherwise the newest by `published_at` (tag strings vary in
 * format, so we sort by date, not name). Returns null when nothing matches.
 */
export function selectRelease(
  releases: GithubRelease[],
  opts: { tag?: string; includePrerelease?: boolean } = {}
): GithubRelease | null {
  const { tag, includePrerelease = true } = opts;
  const usable = releases.filter((r) => !r.draft);
  if (tag) {
    return usable.find((r) => r.tag_name === tag) ?? null;
  }
  const eligible = usable.filter((r) => includePrerelease || !r.prerelease);
  if (eligible.length === 0) return null;
  return eligible.reduce((newest, r) =>
    Date.parse(r.published_at) > Date.parse(newest.published_at) ? r : newest
  );
}

/**
 * Decide plugin vs. theme from the set of available filenames. `main.js`
 * present → plugin; `theme.css` present and no `main.js` → theme; otherwise
 * ambiguous (caller must ask the user to choose).
 */
export function classifyItem(fileNames: string[]): ItemType | "ambiguous" {
  const has = (n: string) => fileNames.some((f) => f.toLowerCase() === n);
  const hasMain = has("main.js");
  const hasTheme = has("theme.css");
  if (hasMain && !hasTheme) return "plugin";
  if (hasTheme && !hasMain) return "theme";
  return "ambiguous";
}

/**
 * Extract the id/name/version we need from a manifest.json body. Plugin
 * manifests carry `id`; theme manifests carry only `name` (Obsidian
 * convention), so `id` falls back to `name`. Full validation
 * (`parseManifest`) happens at install time, not here.
 */
export function readManifestMeta(raw: string): {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("manifest.json must contain a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  const id = typeof obj.id === "string" ? obj.id : name;
  const version = typeof obj.version === "string" ? obj.version : undefined;
  if (!id) throw new Error('manifest.json is missing "id" (or "name")');
  if (!version) throw new Error('manifest.json is missing "version"');
  const minAppVersion = typeof obj.minAppVersion === "string" ? obj.minAppVersion : undefined;
  return { id, name: name ?? id, version, minAppVersion };
}

function apiBaseOf(deps: ResolveDeps): string {
  return (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}
function rawBaseOf(deps: ResolveDeps): string {
  return (deps.rawBase ?? DEFAULT_RAW_BASE).replace(/\/+$/, "");
}

/** Raw default-branch URL for a file (HEAD resolves the default branch, no extra API call). */
function rawUrl(deps: ResolveDeps, spec: RepoSpec, file: string): string {
  return `${rawBaseOf(deps)}/${spec.owner}/${spec.repo}/HEAD/${file}`;
}

async function fetchReleases(deps: ResolveDeps, spec: RepoSpec): Promise<GithubRelease[]> {
  const url = `${apiBaseOf(deps)}/repos/${spec.owner}/${spec.repo}/releases`;
  const res = await deps.get(url, { Accept: "application/vnd.github+json" });
  if (res.status === 404) throw new Error(`Repository ${spec.owner}/${spec.repo} not found`);
  if (!res.ok) throw new Error(`GitHub API error (${res.status}) listing releases`);
  let arr: unknown;
  try {
    arr = JSON.parse(res.text);
  } catch {
    throw new Error("GitHub returned an unparseable releases response");
  }
  return Array.isArray(arr) ? (arr as GithubRelease[]) : [];
}

function assetUrl(release: GithubRelease, name: string): string | undefined {
  return release.assets.find((a) => a.name.toLowerCase() === name)?.browser_download_url;
}

/** Resolve a plugin from a release's attached assets. */
async function resolvePluginFromRelease(
  deps: ResolveDeps,
  release: GithubRelease
): Promise<ResolvedItem> {
  const manifestUrl = assetUrl(release, "manifest.json");
  const mainUrl = assetUrl(release, "main.js");
  if (!manifestUrl || !mainUrl) {
    throw new Error(
      `Release ${release.tag_name} is missing ${!manifestUrl ? "manifest.json" : "main.js"}`
    );
  }
  const manifestRes = await deps.get(manifestUrl);
  if (!manifestRes.ok) throw new Error(`Could not download manifest.json (${manifestRes.status})`);
  const meta = readManifestMeta(manifestRes.text);
  const files: ResolvedFile[] = [
    { name: "manifest.json", url: manifestUrl },
    { name: "main.js", url: mainUrl },
  ];
  const stylesUrl = assetUrl(release, "styles.css");
  if (stylesUrl) files.push({ name: "styles.css", url: stylesUrl });
  return {
    type: "plugin",
    id: meta.id,
    name: meta.name,
    version: meta.version,
    minAppVersion: meta.minAppVersion,
    source: "release",
    ref: release.tag_name,
    files,
  };
}

/** Resolve from raw default-branch files (themes always; plugins as a fallback). */
async function resolveFromRaw(
  deps: ResolveDeps,
  spec: RepoSpec,
  type: ItemType
): Promise<ResolvedItem> {
  const manifestRes = await deps.get(rawUrl(deps, spec, "manifest.json"));
  if (manifestRes.status === 404) {
    throw new Error(`${spec.owner}/${spec.repo} has no manifest.json on its default branch`);
  }
  if (!manifestRes.ok) throw new Error(`Could not read manifest.json (${manifestRes.status})`);
  const meta = readManifestMeta(manifestRes.text);
  const files: ResolvedFile[] = [{ name: "manifest.json", url: rawUrl(deps, spec, "manifest.json") }];
  if (type === "theme") {
    files.push({ name: "theme.css", url: rawUrl(deps, spec, "theme.css") });
  } else {
    files.push({ name: "main.js", url: rawUrl(deps, spec, "main.js") });
    // styles.css is optional; include it speculatively — the downloader
    // (Phase 1) tolerates a missing optional file.
    files.push({ name: "styles.css", url: rawUrl(deps, spec, "styles.css") });
  }
  return {
    type,
    id: meta.id,
    name: meta.name,
    version: meta.version,
    minAppVersion: meta.minAppVersion,
    source: "raw",
    ref: "HEAD",
    files,
  };
}

/** True if a raw file exists (HTTP 200) on the default branch. */
async function rawExists(deps: ResolveDeps, spec: RepoSpec, file: string): Promise<boolean> {
  const res = await deps.get(rawUrl(deps, spec, file));
  return res.ok;
}

/**
 * Resolve `owner/repo` into the concrete files to install. Chooses the
 * plugin-release / theme-raw / plugin-raw-fallback path per the ADR, sniffing
 * plugin-vs-theme when `opts.type` is "auto".
 */
export async function resolveItem(
  spec: RepoSpec,
  deps: ResolveDeps,
  opts: ResolveOpts = {}
): Promise<ResolvedItem> {
  const { type = "auto", tag, includePrerelease = true } = opts;

  // Explicit theme: always raw default-branch.
  if (type === "theme") {
    return resolveFromRaw(deps, spec, "theme");
  }

  // Plugin or auto: try releases first.
  const releases = await fetchReleases(deps, spec);
  const release = selectRelease(releases, { tag, includePrerelease });

  if (release) {
    const assetNames = release.assets.map((a) => a.name.toLowerCase());
    if (type === "plugin") {
      return resolvePluginFromRelease(deps, release);
    }
    // auto: classify from the release's assets.
    const kind = classifyItem(assetNames);
    if (kind === "plugin") return resolvePluginFromRelease(deps, release);
    if (kind === "theme") {
      // A theme published as a release is unusual; fall back to raw where
      // theme.css lives, honoring the pinned tag is out of scope for MVP.
      return resolveFromRaw(deps, spec, "theme");
    }
    // Ambiguous release assets → fall through to raw probing below.
  } else if (tag) {
    throw new Error(`Release "${tag}" not found for ${spec.owner}/${spec.repo}`);
  }

  // No usable release (or ambiguous): probe raw default branch.
  if (type === "plugin") {
    return resolveFromRaw(deps, spec, "plugin");
  }
  // auto over raw: sniff which entry file exists.
  const [hasMain, hasTheme] = await Promise.all([
    rawExists(deps, spec, "main.js"),
    rawExists(deps, spec, "theme.css"),
  ]);
  if (hasMain && !hasTheme) return resolveFromRaw(deps, spec, "plugin");
  if (hasTheme && !hasMain) return resolveFromRaw(deps, spec, "theme");
  throw new Error(
    `Could not tell whether ${spec.owner}/${spec.repo} is a plugin or a theme — choose a type explicitly`
  );
}

/**
 * Main-process side of community install-from-GitHub (Phase 1;
 * docs/adr/0001-community-install-from-github.md). Does the real network I/O
 * and file installation that the pure resolver (github-resolve.ts) leaves to
 * the host: fetch releases/assets, download to a staging dir on the vault's
 * own volume, then atomically rename into `<vault>/.geode/{plugins,themes}/`.
 *
 * Living in the main process (Node) rather than the renderer is deliberate:
 * release-asset URLs redirect to signed object storage that doesn't send
 * permissive CORS to a file:// origin; Node fetch follows those redirects and
 * has no CORS; and the atomic multi-file install needs real fs access. The
 * renderer only ever passes an `owner/repo` spec — never file URLs or paths —
 * and install re-resolves from that spec here, so a compromised renderer
 * can't direct writes outside the vault.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import {
  DEFAULT_API_BASE,
  DEFAULT_RAW_BASE,
  parseRepoSpec,
  resolveItem,
  type CommunityPreview,
  type HttpGet,
  type InstalledResult,
  type RepoSpec,
  type ResolveOpts,
  type ResolvedItem,
} from "./github-resolve";

/** Only these filenames are ever written to disk, regardless of what a repo ships. */
const ALLOWED_FILES = new Set(["manifest.json", "main.js", "styles.css", "theme.css"]);
/** Files whose absence is tolerated (e.g. a plugin without a stylesheet). */
const OPTIONAL_FILES = new Set(["styles.css"]);

function bases(): { apiBase: string; rawBase: string } {
  return {
    apiBase: process.env.GEODE_GITHUB_API_BASE || DEFAULT_API_BASE,
    rawBase: process.env.GEODE_GITHUB_RAW_BASE || DEFAULT_RAW_BASE,
  };
}

/** Real HTTP client over Node's global fetch (follows redirects by default). */
const httpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
};

async function resolve(
  specInput: string,
  opts: ResolveOpts
): Promise<{ spec: RepoSpec; resolved: ResolvedItem }> {
  const spec = parseRepoSpec(specInput);
  const { apiBase, rawBase } = bases();
  const resolved = await resolveItem(spec, { get: httpGet, apiBase, rawBase }, opts);
  return { spec, resolved };
}

function toPreview(spec: RepoSpec, resolved: ResolvedItem): CommunityPreview {
  return {
    repo: `${spec.owner}/${spec.repo}`,
    type: resolved.type,
    id: resolved.id,
    name: resolved.name,
    version: resolved.version,
    source: resolved.source,
    ref: resolved.ref,
  };
}

/** Guard the manifest-derived id before it's used as a directory name. */
function assertSafeId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.startsWith(".")) {
    throw new Error(`Unsafe item id: "${id}"`);
  }
}

/** Resolve `owner/repo` to install metadata (no download) — for the modal preview. */
export async function resolveCommunity(
  specInput: string,
  opts: ResolveOpts
): Promise<CommunityPreview> {
  const { spec, resolved } = await resolve(specInput, opts);
  return toPreview(spec, resolved);
}

/**
 * Download and install `owner/repo` into `<root>/.geode/{plugins,themes}/<id>/`.
 * Files are fetched into a staging dir on the same volume, then atomically
 * renamed into place, so a partial download never leaves a half-written
 * plugin. Re-resolves from the spec (never trusts caller-supplied URLs).
 */
export async function installCommunity(
  root: string,
  specInput: string,
  opts: ResolveOpts
): Promise<InstalledResult> {
  const { spec, resolved } = await resolve(specInput, opts);
  assertSafeId(resolved.id);

  const subdir = resolved.type === "plugin" ? "plugins" : "themes";
  const geodeDir = path.join(root, ".geode");
  const parentDir = path.join(geodeDir, subdir);
  const destDir = path.join(parentDir, resolved.id);
  await fsp.mkdir(parentDir, { recursive: true });

  // Staging dir inside .geode/ so the final rename is on the same volume
  // (a cross-device rename from the OS temp dir would fail with EXDEV).
  const staging = await fsp.mkdtemp(path.join(geodeDir, "install-"));
  try {
    let wroteManifest = false;
    let wroteEntry = false;
    const entryFile = resolved.type === "plugin" ? "main.js" : "theme.css";

    for (const file of resolved.files) {
      if (!ALLOWED_FILES.has(file.name)) continue;
      const res = await fetch(file.url);
      if (!res.ok) {
        if (OPTIONAL_FILES.has(file.name)) continue;
        throw new Error(`Failed to download ${file.name} (HTTP ${res.status})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(path.join(staging, file.name), buf);
      if (file.name === "manifest.json") wroteManifest = true;
      if (file.name === entryFile) wroteEntry = true;
    }

    if (!wroteManifest) throw new Error("Install failed: no manifest.json");
    if (!wroteEntry) throw new Error(`Install failed: no ${entryFile}`);

    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(staging, destDir);
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }

  return toPreview(spec, resolved);
}

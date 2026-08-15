/**
 * Plugin manifest format, mirroring Obsidian's `manifest.json` (see
 * `docs/spec/03-plugin-api.md` §1.2). A loadable plugin lives at
 * `<vault>/.geode/plugins/<plugin-id>/` and contains at minimum a
 * `manifest.json` (this shape) and a `main.js` entry point.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  /**
   * Vault-relative path to the plugin's own folder (e.g. `.geode/plugins/<id>`),
   * mirroring Obsidian's runtime `manifest.dir`. NOT read from `manifest.json`
   * on disk — Obsidian stamps this at load time, and so does Geode's loader
   * (`PluginManager.readManifest`). Plugins that locate sibling files relative
   * to themselves rely on it (e.g. Claude Threads' skill-sources feature does
   * `path.join(vaultRoot, manifest.dir, "skill-sources")`).
   */
  dir?: string;
}

/**
 * The Obsidian-API compatibility level Geode advertises to plugins. Each
 * plugin's `manifest.json` `minAppVersion` is checked against this (see
 * `isVersionAtLeast`) — it represents "which Obsidian app-API version this
 * host behaves like", NOT Geode's own app/package version. Real Obsidian
 * plugins gate on Obsidian's 1.x versions (e.g. Claude Threads requires
 * 1.0.0), so this tracks that line rather than Geode's 0.x release number.
 * Bumped by hand as the emulated API surface grows.
 */
export const GEODE_API_VERSION = "1.8.0";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const SEMVER_RE = /^\d+(\.\d+){1,2}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireString(json: Record<string, unknown>, field: string): string {
  const value = json[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ManifestError(`manifest.json is missing required string field "${field}"`);
  }
  return value;
}

/**
 * Parse and validate a plugin's `manifest.json` contents.
 *
 * `expectedId`, when given, enforces Obsidian's rule that a manifest's `id`
 * must equal the name of the folder it lives in (the plugin directory
 * under `.geode/plugins/`) — this is how the host prevents a plugin from
 * masquerading as a different installed id.
 */
export function parseManifest(raw: string, expectedId?: string): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ManifestError("manifest.json must contain a JSON object");
  }
  const obj = json as Record<string, unknown>;

  const id = requireString(obj, "id");
  if (!ID_RE.test(id)) {
    throw new ManifestError(
      `manifest id "${id}" must contain only lowercase letters, digits, and hyphens`
    );
  }
  if (expectedId !== undefined && id !== expectedId) {
    throw new ManifestError(
      `manifest id "${id}" does not match its plugin folder name "${expectedId}"`
    );
  }

  const name = requireString(obj, "name");
  const version = requireString(obj, "version");
  if (!SEMVER_RE.test(version)) {
    throw new ManifestError(`manifest version "${version}" must be a plain semver string like "1.0.0"`);
  }
  const minAppVersion = requireString(obj, "minAppVersion");
  if (!SEMVER_RE.test(minAppVersion)) {
    throw new ManifestError(
      `manifest minAppVersion "${minAppVersion}" must be a plain semver string like "0.1.0"`
    );
  }
  const description = requireString(obj, "description");
  const author = requireString(obj, "author");

  const manifest: PluginManifest = { id, name, version, minAppVersion, description, author };
  if (typeof obj.authorUrl === "string") manifest.authorUrl = obj.authorUrl;
  if (typeof obj.isDesktopOnly === "boolean") manifest.isDesktopOnly = obj.isDesktopOnly;
  return manifest;
}

/** Compare two dotted version strings numerically (e.g. "1.2" < "1.10"). Returns <0, 0, or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** True if `current` is greater than or equal to `required`. */
export function isVersionAtLeast(current: string, required: string): boolean {
  return compareVersions(current, required) >= 0;
}

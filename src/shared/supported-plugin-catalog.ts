/**
 * Supported-plugin catalog contract shared by the desktop main process and the
 * mobile renderer: types, the strict v1 validator, and pure platform/version
 * admission. No Node or Electron imports (ADR-0007) — the main-process fs cache
 * service stays in src/main/supported-plugin-catalog.ts.
 */
import { isMinimumGeodeVersionMet } from "./semver";


/** Live public endpoint; keep centralized for the planned custom-domain cutover. */
export const SUPPORTED_PLUGIN_CATALOG_URL =
  "https://geode.rbcodelabs.com/supported-plugins/v1.json";
export const DEFAULT_CATALOG_TIMEOUT_MS = 8_000;
export const MAX_CATALOG_BYTES = 256 * 1024;

export type SupportedPluginPlatform = "desktop" | "mobile";
export type SupportedPluginStatus = "active" | "withdrawn";

export interface SupportedPlugin {
  id: string;
  name: string;
  description: string;
  github: { owner: string; repo: string };
  manifest: { version: string; releaseTag: string; minAppVersion: string };
  platforms: SupportedPluginPlatform[];
  minimumGeodeVersion: string;
  certifiedWithGeodeVersion: string;
  artifactHashes: {
    "manifest.json": string;
    "main.js": string;
    "styles.css"?: string;
  };
  evidenceUrl: string;
  status: SupportedPluginStatus;
}

export interface SupportedPluginCatalog {
  schemaVersion: 1;
  plugins: SupportedPlugin[];
}

export type SupportedPluginCatalogState =
  | { status: "fresh" | "stale"; fetchedAt: string; catalog: SupportedPluginCatalog; error?: string }
  | { status: "unavailable"; error: string };

export type SupportedPluginCatalogIpcState =
  | ({ currentGeodeVersion: string } & Extract<SupportedPluginCatalogState, { status: "fresh" | "stale" }>)
  | ({ currentGeodeVersion: string } & Extract<SupportedPluginCatalogState, { status: "unavailable" }>);

const ENVELOPE_FIELDS = new Set(["schemaVersion", "plugins"]);
const PLUGIN_FIELDS = new Set([
  "id", "name", "description", "github", "manifest", "platforms",
  "minimumGeodeVersion", "certifiedWithGeodeVersion", "artifactHashes", "evidenceUrl", "status",
]);
const GITHUB_FIELDS = new Set(["owner", "repo"]);
const MANIFEST_FIELDS = new Set(["version", "releaseTag", "minAppVersion"]);
const HASH_FIELDS = new Set(["manifest.json", "main.js", "styles.css"]);
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const PLUGIN_ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_GITHUB_BLOB_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/[a-f0-9]{40}\/[^?#]+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isStrictSemver(value: string): boolean {
  if (!SEMVER.test(value)) return false;
  const prerelease = value.split("+")[0].split("-").slice(1).join("-");
  if (!prerelease) return true;
  return prerelease.split(".").every((identifier) =>
    !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0")
  );
}

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(obj: Record<string, unknown>, allowed: Set<string>, at: string): void {
  const unknown = Object.keys(obj).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${at} has unknown field "${unknown}"`);
}

function stringAt(obj: Record<string, unknown>, key: string, at: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${at}.${key} must be a non-empty trimmed string`);
  }
  return value;
}

function semverAt(obj: Record<string, unknown>, key: string, at: string): string {
  const value = stringAt(obj, key, at);
  if (!isStrictSemver(value)) throw new Error(`${at}.${key} must be a semantic version`);
  return value;
}

function parsePlugin(value: unknown, index: number): SupportedPlugin {
  const at = `plugins[${index}]`;
  const obj = objectAt(value, at);
  assertKnownFields(obj, PLUGIN_FIELDS, at);
  const id = stringAt(obj, "id", at);
  if (!PLUGIN_ID.test(id)) throw new Error(`${at}.id is invalid`);

  const github = objectAt(obj.github, `${at}.github`);
  assertKnownFields(github, GITHUB_FIELDS, `${at}.github`);
  const owner = stringAt(github, "owner", `${at}.github`);
  const repo = stringAt(github, "repo", `${at}.github`);
  if (!REPO_PART.test(owner)) throw new Error(`${at}.github.owner is invalid`);
  if (!REPO_PART.test(repo)) throw new Error(`${at}.github.repo is invalid`);

  const manifest = objectAt(obj.manifest, `${at}.manifest`);
  assertKnownFields(manifest, MANIFEST_FIELDS, `${at}.manifest`);

  if (!Array.isArray(obj.platforms) || obj.platforms.length === 0) {
    throw new Error(`${at}.platforms must be a non-empty array`);
  }
  const platforms = obj.platforms.map((platform) => {
    if (platform !== "desktop" && platform !== "mobile") {
      throw new Error(`${at}.platforms contains unsupported platform`);
    }
    return platform;
  });
  if (new Set(platforms).size !== platforms.length) {
    throw new Error(`${at}.platforms contains a duplicate platform`);
  }

  const artifactHashes = objectAt(obj.artifactHashes, `${at}.artifactHashes`);
  assertKnownFields(artifactHashes, HASH_FIELDS, `${at}.artifactHashes`);
  const manifestHash = stringAt(artifactHashes, "manifest.json", `${at}.artifactHashes`);
  const mainHash = stringAt(artifactHashes, "main.js", `${at}.artifactHashes`);
  if (!SHA256.test(manifestHash)) throw new Error(`${at}.artifactHashes.manifest.json must be lowercase SHA-256`);
  if (!SHA256.test(mainHash)) throw new Error(`${at}.artifactHashes.main.js must be lowercase SHA-256`);
  const stylesHash = artifactHashes["styles.css"];
  if (stylesHash !== undefined && (typeof stylesHash !== "string" || !SHA256.test(stylesHash))) {
    throw new Error(`${at}.artifactHashes.styles.css must be lowercase SHA-256`);
  }

  const evidenceUrl = stringAt(obj, "evidenceUrl", at);
  if (!IMMUTABLE_GITHUB_BLOB_URL.test(evidenceUrl)) {
    throw new Error(`${at}.evidenceUrl must be a GitHub blob URL pinned to a full commit SHA`);
  }
  if (obj.status !== "active" && obj.status !== "withdrawn") {
    throw new Error(`${at}.status must be active or withdrawn`);
  }

  return {
    id,
    name: stringAt(obj, "name", at),
    description: stringAt(obj, "description", at),
    github: { owner, repo },
    manifest: {
      version: semverAt(manifest, "version", `${at}.manifest`),
      releaseTag: stringAt(manifest, "releaseTag", `${at}.manifest`),
      minAppVersion: semverAt(manifest, "minAppVersion", `${at}.manifest`),
    },
    platforms,
    minimumGeodeVersion: semverAt(obj, "minimumGeodeVersion", at),
    certifiedWithGeodeVersion: semverAt(obj, "certifiedWithGeodeVersion", at),
    artifactHashes: {
      "manifest.json": manifestHash,
      "main.js": mainHash,
      ...(stylesHash === undefined ? {} : { "styles.css": stylesHash }),
    },
    evidenceUrl,
    status: obj.status,
  };
}

/** Validate the complete envelope before returning any catalog data. */
export function parseSupportedPluginCatalog(value: unknown): SupportedPluginCatalog {
  const obj = objectAt(value, "catalog");
  assertKnownFields(obj, ENVELOPE_FIELDS, "catalog");
  if (obj.schemaVersion !== 1) throw new Error("catalog.schemaVersion must be 1");
  if (!Array.isArray(obj.plugins)) throw new Error("catalog.plugins must be an array");
  const plugins = obj.plugins.map(parsePlugin);
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error(`Duplicate plugin id "${plugin.id}"`);
    ids.add(plugin.id);
  }
  return { schemaVersion: 1, plugins };
}

/** Validate a persisted `{ fetchedAt, catalog }` cache record; throws on any malformed shape. */
export function parseSupportedPluginCatalogCache(value: unknown): { fetchedAt: string; catalog: SupportedPluginCatalog } {
  const raw = objectAt(value, "cache");
  assertKnownFields(raw, new Set(["fetchedAt", "catalog"]), "cache");
  const fetchedAt = stringAt(raw, "fetchedAt", "cache");
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error("cache.fetchedAt is invalid");
  return { fetchedAt, catalog: parseSupportedPluginCatalog(raw.catalog) };
}

/**
 * How a catalog entry presents on the mobile runtime. Desktop-only entries are
 * listed honestly rather than hidden; they are never installable here.
 */
export type MobileSupportedAvailability =
  | { kind: "installable" }
  | { kind: "desktop-only" }
  | { kind: "requires-newer-geode"; minimumGeodeVersion: string };

export function mobileSupportedAvailability(
  plugin: SupportedPlugin,
  currentGeodeVersion: string,
): MobileSupportedAvailability {
  if (!plugin.platforms.includes("mobile")) return { kind: "desktop-only" };
  if (!isMinimumGeodeVersionMet(currentGeodeVersion, plugin.minimumGeodeVersion)) {
    return { kind: "requires-newer-geode", minimumGeodeVersion: plugin.minimumGeodeVersion };
  }
  return { kind: "installable" };
}

/**
 * Entries shown on mobile: active only (withdrawn are never offered), with
 * mobile-capable entries ahead of desktop-only ones. Order is otherwise stable.
 */
export function listMobileSupportedPlugins(
  catalog: SupportedPluginCatalog,
  currentGeodeVersion: string,
): Array<{ plugin: SupportedPlugin; availability: MobileSupportedAvailability }> {
  const entries = catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .map((plugin) => ({ plugin, availability: mobileSupportedAvailability(plugin, currentGeodeVersion) }));
  const rank = (entry: { availability: MobileSupportedAvailability }) => entry.availability.kind === "desktop-only" ? 1 : 0;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Mobile install admission: the tested release of an active, mobile-listed, version-compatible entry. */
export function admitMobileSupportedInstall(
  catalog: SupportedPluginCatalog,
  pluginId: string,
  currentGeodeVersion: string,
): SupportedPlugin {
  const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
  if (!plugin || plugin.status !== "active") {
    throw new Error(`Plugin "${pluginId}" is not available in the supported catalog`);
  }
  const availability = mobileSupportedAvailability(plugin, currentGeodeVersion);
  if (availability.kind === "desktop-only") {
    throw new Error(`Plugin "${pluginId}" is desktop only and cannot be installed on mobile`);
  }
  if (availability.kind === "requires-newer-geode") {
    throw new Error(`Plugin "${pluginId}" requires Geode ${availability.minimumGeodeVersion} or newer`);
  }
  return plugin;
}

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonAtomic } from "./config-file";
import type { ResolveOpts } from "./github-resolve";
import { isMinimumGeodeVersionMet } from "../shared/semver";

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

export function buildSupportedPluginInstallRequest(
  plugin: SupportedPlugin,
  release: "tested" | "latest",
): { repo: string; options: ResolveOpts } {
  const repo = `${plugin.github.owner}/${plugin.github.repo}`;
  if (release === "latest") return { repo, options: { type: "plugin" } };
  return {
    repo,
    options: {
      type: "plugin",
      tag: plugin.manifest.releaseTag,
      expected: {
        repo,
        type: "plugin",
        id: plugin.id,
        name: plugin.name,
        version: plugin.manifest.version,
        minAppVersion: plugin.manifest.minAppVersion,
        source: "release",
        ref: plugin.manifest.releaseTag,
        artifactHashes: plugin.artifactHashes,
      },
    },
  };
}

export function admitSupportedPluginInstall(
  catalog: SupportedPluginCatalog,
  pluginId: string,
  release: "tested" | "latest",
  currentGeodeVersion: string,
): { repo: string; options: ResolveOpts } {
  const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
  if (!plugin || plugin.status !== "active" || !plugin.platforms.includes("desktop")) {
    throw new Error(`Plugin "${pluginId}" is not available in the supported catalog`);
  }
  if (!isMinimumGeodeVersionMet(currentGeodeVersion, plugin.minimumGeodeVersion)) {
    throw new Error(`Plugin "${pluginId}" requires Geode ${plugin.minimumGeodeVersion} or newer`);
  }
  return buildSupportedPluginInstallRequest(plugin, release);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CatalogServiceOptions {
  cachePath: string;
  fetch: FetchLike;
  url?: string;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}

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

async function responseTextWithin(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Catalog request failed (HTTP ${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Catalog response is too large");
  if (!response.body) throw new Error("Catalog response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Catalog response is too large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SupportedPluginCatalogService {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(private readonly options: CatalogServiceOptions) {
    this.url = options.url ?? SUPPORTED_PLUGIN_CATALOG_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_CATALOG_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  private async fetchRemote(): Promise<{ fetchedAt: string; catalog: SupportedPluginCatalog }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.options.fetch(this.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await responseTextWithin(response, this.maxBytes);
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error("Catalog response is not valid JSON"); }
      return { fetchedAt: this.now().toISOString(), catalog: parseSupportedPluginCatalog(json) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readCache(): Promise<{ fetchedAt: string; catalog: SupportedPluginCatalog } | null> {
    try {
      const raw = objectAt(JSON.parse(await fsp.readFile(this.options.cachePath, "utf8")), "cache");
      assertKnownFields(raw, new Set(["fetchedAt", "catalog"]), "cache");
      const fetchedAt = stringAt(raw, "fetchedAt", "cache");
      if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error("cache.fetchedAt is invalid");
      return { fetchedAt, catalog: parseSupportedPluginCatalog(raw.catalog) };
    } catch {
      return null;
    }
  }

  async load(): Promise<SupportedPluginCatalogState> {
    try {
      const remote = await this.fetchRemote();
      await fsp.mkdir(path.dirname(this.options.cachePath), { recursive: true });
      await writeJsonAtomic(this.options.cachePath, remote);
      return { status: "fresh", ...remote };
    } catch (error) {
      const cached = await this.readCache();
      if (cached) return { status: "stale", ...cached, error: errorMessage(error) };
      return { status: "unavailable", error: errorMessage(error) };
    }
  }
}

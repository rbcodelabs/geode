import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonAtomic } from "./config-file";
import type { ResolveOpts } from "./github-resolve";
import { isMinimumGeodeVersionMet } from "../shared/semver";
import {
  DEFAULT_CATALOG_TIMEOUT_MS,
  MAX_CATALOG_BYTES,
  SUPPORTED_PLUGIN_CATALOG_URL,
  parseSupportedPluginCatalog,
  parseSupportedPluginCatalogCache,
  type SupportedPlugin,
  type SupportedPluginCatalog,
  type SupportedPluginCatalogIpcState,
  type SupportedPluginCatalogState,
} from "../shared/supported-plugin-catalog";

// The contract lives in src/shared so the mobile renderer can use it without
// crossing the platform boundary; re-exported to keep main-process imports stable.
export {
  DEFAULT_CATALOG_TIMEOUT_MS,
  MAX_CATALOG_BYTES,
  SUPPORTED_PLUGIN_CATALOG_URL,
  parseSupportedPluginCatalog,
};
export type {
  SupportedPlugin,
  SupportedPluginCatalog,
  SupportedPluginCatalogIpcState,
  SupportedPluginCatalogState,
  SupportedPluginPlatform,
  SupportedPluginStatus,
} from "../shared/supported-plugin-catalog";


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
      return parseSupportedPluginCatalogCache(JSON.parse(await fsp.readFile(this.options.cachePath, "utf8")));
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

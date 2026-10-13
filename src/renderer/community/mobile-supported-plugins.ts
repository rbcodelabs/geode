/**
 * Mobile "Supported plugins": catalog loading and the tested-release install
 * path (docs/design/mobile-mvp-slice-3a-plugin-runtime-spec.md, ADR-0007).
 *
 * This is the mobile counterpart of the desktop main-process installer in
 * src/main/community.ts, and deliberately narrower:
 *
 *  - only the catalog-certified *tested* release is installable — no "latest";
 *  - every downloaded artifact is SHA-256-verified against the catalog's
 *    `artifactHashes` in memory, BEFORE anything is written to the vault;
 *  - the manifest must agree with the catalog and must not declare
 *    `isDesktopOnly` (the same classifier mobile admission uses at enable time);
 *  - installing writes files and never enables the plugin. Enabling executes
 *    code and stays the explicit opt-in on the installed-plugin row.
 *
 * Pure renderer code: no Node or Electron imports. All I/O is injected so the
 * policy is unit-testable and the native HTTP stack stays a host concern.
 */

import {
  MAX_CATALOG_BYTES,
  SUPPORTED_PLUGIN_CATALOG_URL,
  admitMobileSupportedInstall,
  parseSupportedPluginCatalog,
  parseSupportedPluginCatalogCache,
  type SupportedPlugin,
  type SupportedPluginCatalog,
  type SupportedPluginCatalogIpcState,
} from "../../shared/supported-plugin-catalog";
import type { PluginArtifactTransport } from "../../shared/network";
import type { InstalledResult } from "../../main/github-resolve";
import { isPluginManifestCompatible, parseManifest } from "../plugin-manifest";
import { MAX_MOBILE_PLUGIN_SOURCE_BYTES, classifyMobilePlugin } from "../mobile-plugin-runtime";
import type { DeviceStateService, PluginFileSet } from "../host/contracts";

/**
 * Fetch `url` and return its bytes, enforcing `maxBytes`. The default native
 * implementation (CapacitorHttp) bypasses WebView CORS: github.com release
 * downloads redirect to a host that sends no CORS headers, so `fetch` cannot
 * download them from a WKWebView. Integrity never depends on the transport —
 * bytes are hash-verified against the catalog before use.
 */
export type MobileTransport = PluginArtifactTransport;

export const MOBILE_SUPPORTED_CACHE_KEY = "supported-plugin-catalog-cache";

/** Mirrors the id rule of the host's plugin file services (lowercase, digits, hyphens). */
const HOST_PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STYLES_BYTES = 4 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LoadMobileCatalogDeps {
  transport: MobileTransport;
  deviceState: Pick<DeviceStateService, "read" | "write">;
  currentGeodeVersion: string;
  url?: string;
  now?: () => Date;
}

/**
 * Fetch and validate the catalog with the same strict validator the desktop
 * uses. A failed or invalid fetch falls back to the last good cached copy
 * (reported as `stale`); with no usable cache the state is `unavailable`.
 * An invalid response is never cached, so it cannot displace a good copy.
 */
export async function loadMobileSupportedCatalog(
  deps: LoadMobileCatalogDeps,
): Promise<SupportedPluginCatalogIpcState> {
  const { currentGeodeVersion } = deps;
  try {
    const bytes = await deps.transport(deps.url ?? SUPPORTED_PLUGIN_CATALOG_URL, {
      maxBytes: MAX_CATALOG_BYTES,
      accept: "application/json",
    });
    if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error("Catalog response is too large");
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("Catalog response is not valid JSON");
    }
    const catalog = parseSupportedPluginCatalog(json);
    const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
    // A cache write failure must not hide a catalog we just validated.
    await deps.deviceState.write(MOBILE_SUPPORTED_CACHE_KEY, { fetchedAt, catalog }).catch(() => undefined);
    return { status: "fresh", fetchedAt, catalog, currentGeodeVersion };
  } catch (error) {
    const message = errorMessage(error);
    try {
      const cached = parseSupportedPluginCatalogCache(await deps.deviceState.read(MOBILE_SUPPORTED_CACHE_KEY));
      return { status: "stale", ...cached, error: message, currentGeodeVersion };
    } catch {
      return { status: "unavailable", error: message, currentGeodeVersion };
    }
  }
}

export interface MobileInstallDeps {
  transport: MobileTransport;
  currentGeodeVersion: string;
  /** Raw manifest.json text of an already-installed copy, or null if none. */
  readExistingManifest(id: string): Promise<string | null>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  /** Best-effort removal of a partially written new install. */
  removeFolder(path: string): Promise<void>;
  /** The host's compare-and-swap replace used for updating an existing install. */
  replacePluginFiles(id: string, expectedManifest: string, replacement: PluginFileSet): Promise<void>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function downloadVerified(
  plugin: SupportedPlugin,
  name: "manifest.json" | "main.js" | "styles.css",
  expectedHash: string,
  maxBytes: number,
  transport: MobileTransport,
): Promise<string> {
  const { owner, repo } = plugin.github;
  const url = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(plugin.manifest.releaseTag)}/${name}`;
  const bytes = await transport(url, { maxBytes });
  if (bytes.byteLength > maxBytes) throw new Error(`${name} is too large`);
  if ((await sha256Hex(bytes)) !== expectedHash) {
    throw new Error(`Integrity check failed for ${name}: it does not match the tested release. Nothing was installed.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not valid UTF-8 text`);
  }
}

/**
 * Install the tested release of `pluginId` into `.geode/plugins/<id>`.
 * Throws before any write on admission, download, integrity or manifest
 * failure. Returns the install record for community.json bookkeeping.
 */
export async function installMobileSupportedPlugin(
  catalog: SupportedPluginCatalog,
  pluginId: string,
  deps: MobileInstallDeps,
): Promise<InstalledResult> {
  const plugin = admitMobileSupportedInstall(catalog, pluginId, deps.currentGeodeVersion);
  if (!HOST_PLUGIN_ID.test(plugin.id)) {
    throw new Error(`Plugin id "${plugin.id}" is not valid on mobile (lowercase letters, digits and hyphens only)`);
  }
  const tag = plugin.manifest.releaseTag;
  if (!RELEASE_TAG.test(tag)) throw new Error(`Release tag "${tag}" is not valid`);

  // Stage in memory: nothing touches the vault until every artifact verified.
  const hashes = plugin.artifactHashes;
  const manifestText = await downloadVerified(plugin, "manifest.json", hashes["manifest.json"], MAX_MANIFEST_BYTES, deps.transport);
  const mainText = await downloadVerified(plugin, "main.js", hashes["main.js"], MAX_MOBILE_PLUGIN_SOURCE_BYTES, deps.transport);
  const stylesText = hashes["styles.css"]
    ? await downloadVerified(plugin, "styles.css", hashes["styles.css"], MAX_STYLES_BYTES, deps.transport)
    : null;

  const manifest = parseManifest(manifestText, plugin.id);
  if (manifest.version !== plugin.manifest.version || manifest.minAppVersion !== plugin.manifest.minAppVersion) {
    throw new Error(`Downloaded manifest does not match the catalog entry for "${plugin.id}"`);
  }
  const admission = classifyMobilePlugin(manifest);
  if (admission.compatibility === "desktop-only") {
    throw new Error(`Plugin "${plugin.id}" is ${admission.label}: ${admission.reason}.`);
  }
  if (!isPluginManifestCompatible(manifest, "mobile").compatible) {
    throw new Error(`Plugin "${plugin.id}" requires a newer plugin API (minAppVersion ${manifest.minAppVersion})`);
  }

  const folder = `.geode/plugins/${plugin.id}`;
  const existing = await deps.readExistingManifest(plugin.id);
  if (existing !== null) {
    await deps.replacePluginFiles(plugin.id, existing, { manifest: manifestText, main: mainText, styles: stylesText });
  } else {
    // The manifest is written last: a plugin is only discoverable once its
    // manifest exists, so an interrupted install never presents half a plugin.
    try {
      await deps.mkdir(folder);
      await deps.writeFile(`${folder}/main.js`, mainText);
      if (stylesText !== null) await deps.writeFile(`${folder}/styles.css`, stylesText);
      await deps.writeFile(`${folder}/manifest.json`, manifestText);
    } catch (error) {
      await deps.removeFolder(folder).catch(() => undefined);
      throw error;
    }
  }

  return {
    repo: `${plugin.github.owner}/${plugin.github.repo}`,
    type: "plugin",
    id: plugin.id,
    name: manifest.name,
    version: manifest.version,
    minAppVersion: manifest.minAppVersion,
    source: "release",
    ref: tag,
  };
}

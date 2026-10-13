import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  admitMobileSupportedInstall,
  listMobileSupportedPlugins,
  mobileSupportedAvailability,
  parseSupportedPluginCatalog,
  type SupportedPlugin,
  type SupportedPluginCatalog,
} from "../../src/shared/supported-plugin-catalog";
import {
  MOBILE_SUPPORTED_CACHE_KEY,
  installMobileSupportedPlugin,
  loadMobileSupportedCatalog,
  type MobileInstallDeps,
  type MobileTransport,
} from "../../src/renderer/community/mobile-supported-plugins";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const enc = (text: string) => new TextEncoder().encode(text);

const manifestText = JSON.stringify({
  id: "mobile-ok", name: "Mobile OK", version: "1.2.0", minAppVersion: "1.0.0",
  description: "fixture", author: "Geode", isDesktopOnly: false,
});
const mainText = `const { Plugin } = require("obsidian"); module.exports = class extends Plugin {};`;
const stylesText = ".mobile-ok { color: red; }";

function entry(overrides: Partial<SupportedPlugin> = {}): SupportedPlugin {
  return {
    id: "mobile-ok",
    name: "Mobile OK",
    description: "Works on phones.",
    github: { owner: "acme", repo: "mobile-ok" },
    manifest: { version: "1.2.0", releaseTag: "v1.2.0", minAppVersion: "1.0.0" },
    platforms: ["desktop", "mobile"],
    minimumGeodeVersion: "0.20.0",
    certifiedWithGeodeVersion: "0.20.0",
    artifactHashes: { "manifest.json": sha(manifestText), "main.js": sha(mainText), "styles.css": sha(stylesText) },
    evidenceUrl: `https://github.com/acme/mobile-ok/blob/${"a".repeat(40)}/evidence.md`,
    status: "active",
    ...overrides,
  };
}

const catalogOf = (...plugins: SupportedPlugin[]): SupportedPluginCatalog => ({ schemaVersion: 1, plugins });

describe("mobile platform filtering and version gating", () => {
  it("lists active entries, mobile-capable first, and shows desktop-only honestly", () => {
    const catalog = catalogOf(
      entry({ id: "desk", platforms: ["desktop"] }),
      entry({ id: "gone", status: "withdrawn" }),
      entry({ id: "phone" }),
    );
    const listing = listMobileSupportedPlugins(catalog, "0.30.0");
    expect(listing.map((e) => [e.plugin.id, e.availability.kind])).toEqual([
      ["phone", "installable"],
      ["desk", "desktop-only"],
    ]);
  });

  it("gates on minimumGeodeVersion", () => {
    const plugin = entry({ minimumGeodeVersion: "0.31.0" });
    expect(mobileSupportedAvailability(plugin, "0.30.0")).toEqual({ kind: "requires-newer-geode", minimumGeodeVersion: "0.31.0" });
    expect(mobileSupportedAvailability(plugin, "0.31.0")).toEqual({ kind: "installable" });
  });

  it("refuses to admit desktop-only, withdrawn, unknown and too-new entries", () => {
    const catalog = catalogOf(
      entry({ id: "desk", platforms: ["desktop"] }),
      entry({ id: "gone", status: "withdrawn" }),
      entry({ id: "new", minimumGeodeVersion: "9.0.0" }),
      entry(),
    );
    expect(() => admitMobileSupportedInstall(catalog, "desk", "0.30.0")).toThrow(/desktop only/i);
    expect(() => admitMobileSupportedInstall(catalog, "gone", "0.30.0")).toThrow(/not available/);
    expect(() => admitMobileSupportedInstall(catalog, "nope", "0.30.0")).toThrow(/not available/);
    expect(() => admitMobileSupportedInstall(catalog, "new", "0.30.0")).toThrow(/requires Geode 9\.0\.0/);
    expect(admitMobileSupportedInstall(catalog, "mobile-ok", "0.30.0").id).toBe("mobile-ok");
  });
});

describe("loadMobileSupportedCatalog", () => {
  function deviceState() {
    const store = new Map<string, unknown>();
    return {
      store,
      read: async <T>(key: string) => (store.get(key) as T) ?? null,
      write: async (key: string, value: unknown) => { store.set(key, value); },
      remove: async (key: string) => { store.delete(key); },
    };
  }
  const json = (value: unknown): MobileTransport => async () => enc(JSON.stringify(value));
  const failing: MobileTransport = async () => { throw new Error("offline"); };
  const now = () => new Date("2026-10-13T12:00:00.000Z");

  it("fetches, validates, and caches a fresh catalog", async () => {
    const state = deviceState();
    const result = await loadMobileSupportedCatalog({ transport: json(catalogOf(entry())), deviceState: state, currentGeodeVersion: "0.30.0", now });
    expect(result).toMatchObject({ status: "fresh", fetchedAt: "2026-10-13T12:00:00.000Z", currentGeodeVersion: "0.30.0" });
    expect(state.store.has(MOBILE_SUPPORTED_CACHE_KEY)).toBe(true);
  });

  it("falls back to the cached catalog (stale) when the network fails", async () => {
    const state = deviceState();
    await loadMobileSupportedCatalog({ transport: json(catalogOf(entry())), deviceState: state, currentGeodeVersion: "0.30.0", now });
    const result = await loadMobileSupportedCatalog({ transport: failing, deviceState: state, currentGeodeVersion: "0.30.0", now });
    expect(result).toMatchObject({ status: "stale", error: "offline" });
    expect(result.status === "stale" && result.catalog.plugins[0].id).toBe("mobile-ok");
  });

  it("does not cache or trust an invalid catalog, and keeps the previous good cache", async () => {
    const state = deviceState();
    await loadMobileSupportedCatalog({ transport: json(catalogOf(entry())), deviceState: state, currentGeodeVersion: "0.30.0", now });
    const bad = { schemaVersion: 1, plugins: [{ ...entry(), extra: true }] };
    const result = await loadMobileSupportedCatalog({ transport: json(bad), deviceState: state, currentGeodeVersion: "0.30.0", now });
    expect(result.status).toBe("stale");
    expect(result.status === "stale" && result.error).toMatch(/unknown field/);
  });

  it("is unavailable with no network and no usable cache", async () => {
    const state = deviceState();
    state.store.set(MOBILE_SUPPORTED_CACHE_KEY, { garbage: true });
    const result = await loadMobileSupportedCatalog({ transport: failing, deviceState: state, currentGeodeVersion: "0.30.0", now });
    expect(result).toEqual({ status: "unavailable", error: "offline", currentGeodeVersion: "0.30.0" });
  });

  it("rejects oversized catalog responses", async () => {
    const state = deviceState();
    const huge: MobileTransport = async () => new Uint8Array(300 * 1024);
    const result = await loadMobileSupportedCatalog({ transport: huge, deviceState: state, currentGeodeVersion: "0.30.0", now });
    expect(result.status).toBe("unavailable");
  });
});

describe("installMobileSupportedPlugin", () => {
  function setup(overrides: { files?: Record<string, string>; existingManifest?: string } = {}) {
    const files: Record<string, string> = {
      "manifest.json": manifestText, "main.js": mainText, "styles.css": stylesText, ...overrides.files,
    };
    const requested: string[] = [];
    const transport: MobileTransport = async (url) => {
      requested.push(url);
      const name = url.split("/").pop()!;
      if (!(name in files)) throw new Error(`HTTP 404 for ${name}`);
      return enc(files[name]);
    };
    const writes: string[] = [];
    const replaced: Array<{ id: string; expected: string; replacement: unknown }> = [];
    const deps: MobileInstallDeps = {
      transport,
      currentGeodeVersion: "0.30.0",
      readExistingManifest: async () => overrides.existingManifest ?? null,
      writeFile: vi.fn(async (path: string) => { writes.push(path); }),
      mkdir: vi.fn(async () => {}),
      removeFolder: vi.fn(async () => {}),
      replacePluginFiles: vi.fn(async (id, expected, replacement) => { replaced.push({ id, expected, replacement }); }),
    };
    return { deps, requested, writes, replaced };
  }

  it("downloads the tested release from the pinned tag and writes manifest last", async () => {
    const { deps, requested, writes } = setup();
    const installed = await installMobileSupportedPlugin(catalogOf(entry()), "mobile-ok", deps);
    expect(requested).toEqual([
      "https://github.com/acme/mobile-ok/releases/download/v1.2.0/manifest.json",
      "https://github.com/acme/mobile-ok/releases/download/v1.2.0/main.js",
      "https://github.com/acme/mobile-ok/releases/download/v1.2.0/styles.css",
    ]);
    expect(writes).toEqual([
      ".geode/plugins/mobile-ok/main.js",
      ".geode/plugins/mobile-ok/styles.css",
      ".geode/plugins/mobile-ok/manifest.json",
    ]);
    expect(installed).toMatchObject({ repo: "acme/mobile-ok", type: "plugin", id: "mobile-ok", version: "1.2.0", source: "release", ref: "v1.2.0" });
  });

  it.each(["manifest.json", "main.js", "styles.css"])("rejects a %s hash mismatch before writing anything", async (name) => {
    const { deps, writes, replaced } = setup({ files: { [name]: "tampered" } });
    await expect(installMobileSupportedPlugin(catalogOf(entry()), "mobile-ok", deps)).rejects.toThrow(
      new RegExp(`Integrity check failed for ${name.replace(".", "\\.")}`),
    );
    expect(writes).toEqual([]);
    expect(replaced).toEqual([]);
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  it("refuses desktop-only catalog entries without any network request", async () => {
    const { deps, requested } = setup();
    await expect(installMobileSupportedPlugin(catalogOf(entry({ platforms: ["desktop"] })), "mobile-ok", deps)).rejects.toThrow(/desktop only/i);
    expect(requested).toEqual([]);
  });

  it("refuses when the downloaded manifest declares isDesktopOnly, even if hashes match", async () => {
    const desktopManifest = JSON.stringify({ ...JSON.parse(manifestText), isDesktopOnly: true });
    const plugin = entry({ artifactHashes: { "manifest.json": sha(desktopManifest), "main.js": sha(mainText), "styles.css": sha(stylesText) } });
    const { deps, writes } = setup({ files: { "manifest.json": desktopManifest } });
    await expect(installMobileSupportedPlugin(catalogOf(plugin), "mobile-ok", deps)).rejects.toThrow(/Desktop only/);
    expect(writes).toEqual([]);
  });

  it("refuses a manifest whose id or version disagrees with the catalog", async () => {
    const other = JSON.stringify({ ...JSON.parse(manifestText), id: "someone-else" });
    const plugin = entry({ artifactHashes: { "manifest.json": sha(other), "main.js": sha(mainText), "styles.css": sha(stylesText) } });
    const { deps, writes } = setup({ files: { "manifest.json": other } });
    await expect(installMobileSupportedPlugin(catalogOf(plugin), "mobile-ok", deps)).rejects.toThrow(/does not match/);
    expect(writes).toEqual([]);
  });

  it("refuses plugin ids the host cannot address", async () => {
    const { deps } = setup();
    await expect(installMobileSupportedPlugin(catalogOf(entry({ id: "Bad_ID" })), "Bad_ID", deps)).rejects.toThrow(/id/i);
  });

  it("rolls back a partially written new install", async () => {
    const { deps } = setup();
    let calls = 0;
    deps.writeFile = vi.fn(async () => { if (++calls === 2) throw new Error("disk full"); });
    await expect(installMobileSupportedPlugin(catalogOf(entry()), "mobile-ok", deps)).rejects.toThrow(/disk full/);
    expect(deps.removeFolder).toHaveBeenCalledWith(".geode/plugins/mobile-ok");
  });

  it("updates an existing install through the atomic replace path", async () => {
    const { deps, writes, replaced } = setup({ existingManifest: "{old}" });
    await installMobileSupportedPlugin(catalogOf(entry()), "mobile-ok", deps);
    expect(writes).toEqual([]);
    expect(replaced).toEqual([{ id: "mobile-ok", expected: "{old}", replacement: { manifest: manifestText, main: mainText, styles: stylesText } }]);
  });

  it("only ever reads the catalog schema through the shared validator", () => {
    expect(() => parseSupportedPluginCatalog({ schemaVersion: 1, plugins: [{ nope: 1 }] })).toThrow();
  });
});

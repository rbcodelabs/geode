import { afterEach, describe, expect, it } from "vitest";
import { buildHistoryPorts, isIncludedInScope, type SyncHostLite } from "../../src/sync-core/ports";
import { DEFAULT_SYNC_SCOPE, isLocalOnlyConfigPath, isPathInSyncScope, portableConfigCategory, rawConfigCategory, type SyncScope } from "../../src/sync-core/scope";
import { scanVault } from "../../src/sync-node/index";
import { put, rmrf, tmp } from "../helpers/node-host-harness";

/** Every flag on: a user cannot opt the caches in, so the most permissive scope is the one to test. */
const EVERYTHING: SyncScope = { ...DEFAULT_SYNC_SCOPE, communityPlugins: true, communityPluginData: true };
const LOCAL_ONLY = [
  ".geode/metadata-cache/index.sqlite", ".geode/metadata-cache/cache.json", ".geode/metadata-cache/.cache.json.abc.tmp", ".geode/metadata-cache/sub/x.json",
  ".geode/Metadata-Cache/index.sqlite", ".obsidian/metadata-cache/cache.json",
  ".geode/app.json.tmp", ".geode/plugins/x/data.json.tmp", ".geode/plugins/x/data.json.tmp-123-uuid", ".obsidian/plugins/x/main.js.TMP",
];

describe("local-only config paths never sync", () => {
  it("classifies every spelling a config path takes through the engine", () => {
    for (const physical of LOCAL_ONLY) {
      expect(isLocalOnlyConfigPath(physical), physical).toBe(true);
      expect(isLocalOnlyConfigPath(physical.replace(/^\.(geode|obsidian)/, "raw.$1")), `raw ${physical}`).toBe(true);
      expect(portableConfigCategory(physical), physical).toBeNull();
      expect(isPathInSyncScope(physical, EVERYTHING), physical).toBe(false);
    }
    // The root-relative form the app uses for projected config.
    expect(isLocalOnlyConfigPath("metadata-cache/index.sqlite")).toBe(true);
    expect(isLocalOnlyConfigPath("plugins/x/data.json.tmp")).toBe(true);
  });

  it("does not touch real configuration or user content", () => {
    for (const ok of [".geode/app.json", ".geode/themes/Dark/theme.css", ".geode/plugins/x/data.json", ".obsidian/snippets/a.css", ".geode/plugins/tmp-tools/data.json"]) {
      expect(isLocalOnlyConfigPath(ok), ok).toBe(false);
      expect(portableConfigCategory(ok), ok).not.toBeNull();
    }
    // A user's own folder may be called metadata-cache; only the config roots are special.
    expect(isLocalOnlyConfigPath("Notes/metadata-cache/a.md")).toBe(false);
    expect(isPathInSyncScope("metadata-cache/a.md", EVERYTHING)).toBe(true);
    expect(isIncludedInScope(EVERYTHING, "content", "metadata-cache/a.md")).toBe(true);
    expect(isLocalOnlyConfigPath("constructor/x")).toBe(false);
  });

  it("is excluded in both namespaces whatever the scope, for the app's and the raw-file host's spellings", () => {
    for (const scope of [EVERYTHING, { ...EVERYTHING, rawConfig: true }]) for (const physical of LOCAL_ONLY) {
      const root = physical.split("/")[0], rest = physical.slice(root.length + 1);
      for (const resource of [rest, `raw${root}/${rest}`, `raw${root}`.replace("raw.", "raw.") + "/" + rest]) expect(isIncludedInScope(scope, "portable-config", resource), `${scope.rawConfig} ${resource}`).toBe(false);
      expect(rawConfigCategory(`raw${root}/${rest}`), physical).toBeNull();
    }
    expect(rawConfigCategory("raw.geode/metadata-cache")).toBeNull();
  });

  it("the headless scan never walks .geode/metadata-cache or reports its temp files, and still finds real config", async () => {
    const root = tmp("local-only"); cleanups.push(root);
    for (const rel of LOCAL_ONLY) put(root, rel);
    put(root, ".geode/themes/Dark/theme.css"); put(root, ".geode/plugins/x/data.json"); put(root, "Notes/a.md");
    const report = await scanVault({ root, settleMs: 0, detectEvicted: false });
    expect(report.status).toBe("complete");
    // Folders that could hold portable files are listed (as before); no cache folder, no cache or temp file.
    expect(report.entries.map(e => e.path).filter(p => p.includes("metadata-cache") || /\.tmp/i.test(p))).toEqual([]);
    expect(report.entries.filter(e => !e.isFolder).map(e => e.path)).toEqual([".geode/plugins/x/data.json", ".geode/themes/Dark/theme.css", "Notes/a.md"]);
    expect(report.blocked).toEqual([]);
  });
});

const cleanups: string[] = [];
afterEach(() => { for (const d of cleanups.splice(0)) rmrf(d); });

describe("the renderer/mobile snapshot (which lists everything the native layer sees)", () => {
  const OLD = Date.now() - 60_000;
  const GB = 3 * 1024 ** 3;
  for (const rawConfig of [false, true]) it(`never reads, hashes or publishes the metadata cache (rawConfig=${rawConfig})`, async () => {
    const listing = [...LOCAL_ONLY, ".geode/app.json", "note.md"].map(path => ({ path, isFolder: false, mtime: OLD, size: path.includes("metadata-cache") ? GB / 10 : 5 }));
    listing.push({ path: ".geode/metadata-cache", isFolder: true, mtime: 0, size: 0 }, { path: ".geode/metadata-cache/sub", isFolder: true, mtime: 0, size: 0 });
    const reads: string[] = [];
    const host: SyncHostLite = {
      vault: { reconcileScan: async () => ({ status: "complete", entries: listing }), readBinary: async path => { reads.push(path); return new TextEncoder().encode("x").buffer as ArrayBuffer; } },
      deviceState: { read: async () => null, write: async () => {} },
      safety: { storage: async () => undefined, apply: async () => ({ status: "applied", hash: null, recoveryPath: "r" }) },
      portableConfig: { project: async () => [] },
    };
    const scope = { ...EVERYTHING, rawConfig };
    const { ports } = buildHistoryPorts(host, { provider: { id: "p" }, scope, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "b", stateKey: "s", lease: "l", assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} });
    const snapshot = await ports.snapshot();
    expect(snapshot.entries.map(e => `${e.namespace}:${e.path}`).sort()).toEqual(rawConfig ? ["content:note.md", "portable-config:raw.geode", "portable-config:raw.geode/app.json"] : ["content:note.md"]);
    expect(reads.filter(p => p.includes("metadata-cache") || p.endsWith(".tmp"))).toEqual([]);
    expect(snapshot.blocked).toEqual([]);
    for (const path of LOCAL_ONLY) expect(ports.isIncluded("portable-config", path.replace(/^\.(geode|obsidian)\//, "")), path).toBe(false);
  });
});

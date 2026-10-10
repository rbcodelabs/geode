import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { expect, it } from "vitest";

const root = resolve(__dirname, "../../src/sync-node");
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []);
const specifiers = (source: string) => [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

it("src/sync-node has files to audit", () => { expect(files(root).length).toBeGreaterThanOrEqual(5); });

it("src/sync-node imports no electron, renderer, or main-process code", () => {
  for (const file of files(root)) {
    for (const spec of specifiers(stripComments(readFileSync(file, "utf8")))) {
      expect(spec, file).not.toMatch(/^electron(\/|$)/);
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const ok = target.startsWith(root + "/") || target.startsWith(resolve(root, "../shared") + "/") || target.startsWith(resolve(root, "../sync-core") + "/");
        expect(ok, `${file} imports ${spec}`).toBe(true);
        expect(target, file).not.toMatch(/src\/(renderer|main)(\/|$)/);
      }
    }
  }
});

it("src/sync-node never touches DOM or Electron globals", () => {
  for (const file of files(root)) {
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source, file).not.toMatch(/\b(document|window|localStorage|sessionStorage|navigator|ipcRenderer|ipcMain|app|shell)\s*\./);
    expect(source, file).not.toMatch(/\bnew\s+(?:Worker|XMLHttpRequest)\b|\bfetch\(/);
  }
});

it("index.ts exports only the curated surface", () => {
  const names = [...readFileSync(join(root, "index.ts"), "utf8").matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m => m[1].split(",").map(n => n.trim().replace(/^type\s+/, "")).filter(Boolean)).sort();
  expect(names).toEqual(["ApplyDependencies","CommandRunner","DEFAULT_STAGING_DIRNAME","FsBlobWriter","FsStoreProvider","FsStoreSession","HydrateOptions","HydrateReport","InitInput","MIN_DELETE_LIMIT","MIN_SCAN_RATIO","NodeHashCache","NodeHost","NodeHostOptions","PreviewSummary","RailReport","ResolveChoice","RpcClient","RpcStoreProvider","RpcStoreSession","STORE_CHUNK_BYTES","ScanIo","ScanOptions","ScanReport","ServeOptions","ServeStats","SpawnCommand","StoreErrorCode","StoreTransport","SyncFailure","SyncLockedError","SyncOverrides","SyncPrivateStorage","SyncRailError","SyncRailStatus","SyncRefusal","SyncStateDirError","SyncStoreError","SyncTarget","TrashIo","WikiSyncConfig","WikiSyncContext","applyGuardedMutation","assertStateDirOutsideVault","classifySyncError","conflictCopyBase","defaultStateDir","deleteLimitFor","describeTarget","durableWrite","ensureDurableDirectory","execRunner","hydrateIcloudPaths","isStoreError","moveToTrash","readLockHolder","resolveStateDir","scanVault","serveStore","spawnSshStore","spawnTransport","syncConflicts","syncGc","syncInit","syncPreview","syncResolve","syncRun","syncStatus","validateExcludeFolders","withPathLock","withVaultMutation"]);
});

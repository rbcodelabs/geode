/**
 * Curated entry point of the Node-only sync layer. Hosts (the headless CLI,
 * Electron main) import from here; everything else in this directory is internal.
 */
export { applyGuardedMutation, durableWrite, ensureDurableDirectory, type ApplyDependencies } from "./sync-apply";
export { moveToTrash, type TrashIo } from "./trash";
export { withPathLock, withVaultMutation } from "./path-lock";
export { SyncPrivateStorage } from "./sync-private-storage";
export { FsBlobWriter, FsStoreProvider, FsStoreSession, STORE_CHUNK_BYTES } from "./fs-store";
export { serveStore, type ServeOptions, type ServeStats } from "./serve";
export { RpcClient, RpcStoreProvider, RpcStoreSession, spawnSshStore, spawnTransport, type SpawnCommand, type StoreTransport } from "./rpc-store";
export { isStoreError, SyncStoreError, type StoreErrorCode } from "./store-errors";
export { NodeHost, SyncLockedError, SyncStateDirError, DEFAULT_STAGING_DIRNAME, defaultStateDir, assertStateDirOutsideVault, type NodeHostOptions } from "./node-host";
export { scanVault, conflictCopyBase, type ScanOptions, type ScanReport, type ScanIo } from "./node-scan";
export { NodeHashCache } from "./node-hash-cache";
export { hydrateIcloudPaths, execRunner, type CommandRunner, type HydrateOptions, type HydrateReport } from "./node-icloud";
export { syncInit, syncPreview, syncRun, syncStatus, syncConflicts, syncResolve, syncGc, classifySyncError, resolveStateDir, validateExcludeFolders, deleteLimitFor, describeTarget, SyncRailError, SyncRefusal, MIN_DELETE_LIMIT, MIN_SCAN_RATIO, type WikiSyncContext, type WikiSyncConfig, type SyncTarget, type SyncOverrides, type SyncFailure, type SyncRailStatus, type PreviewSummary, type RailReport, type ResolveChoice, type InitInput } from "./wiki-sync";
export { readLockHolder } from "./store-lock";

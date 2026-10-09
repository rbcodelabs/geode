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

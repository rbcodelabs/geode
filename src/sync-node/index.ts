/**
 * Curated entry point of the Node-only sync layer. Hosts (the headless CLI,
 * Electron main) import from here; everything else in this directory is internal.
 */
export { applyGuardedMutation, durableWrite, ensureDurableDirectory, type ApplyDependencies } from "./sync-apply";
export { moveToTrash, type TrashIo } from "./trash";
export { withPathLock, withVaultMutation } from "./path-lock";
export { SyncPrivateStorage } from "./sync-private-storage";

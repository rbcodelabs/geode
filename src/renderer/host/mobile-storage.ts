import type { HostServices } from "./contracts";
import { createIdbConfig, createIdbConnection, createIdbDeviceState, createIdbMetadataIndex, pruneUnregisteredVaultRecords } from "./idb-device-state";

export interface DurableMobileStorageOptions {
  /** Config names currently in the legacy localStorage snapshot, so stale per-vault entries there can be pruned too. */
  legacyConfigNames?: () => Iterable<string>;
  /** Runs the once-per-launch prune of unregistered vaults' records. Defaults to a few seconds after the first open. */
  schedulePrune?: (task: () => Promise<unknown>) => void;
}

const PRUNE_DELAY_MS = 5_000;

/**
 * The durable stores the native iOS shell uses in place of the browser host's single localStorage snapshot (about 5 MB
 * on iOS, shared by every config key): device state, the vault-sized reconcile manifest, and the per-vault metadata
 * cache. Small config (settings, workspace, bookmarks) stays in the snapshot, where sync-safety also reads it.
 */
export function withDurableMobileStorage(
  host: HostServices,
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  options: DurableMobileStorageOptions = {},
): HostServices {
  const connection = createIdbConnection(factory);
  const config = createIdbConfig(host.config, connection);
  let activeVault: string | null = null;
  let pruneScheduled = false;
  const schedulePrune = options.schedulePrune ?? (task => { setTimeout(() => { void task().catch(() => {}); }, PRUNE_DELAY_MS); });
  return {
    ...host,
    deviceState: createIdbDeviceState(host.deviceState, connection),
    config,
    metadataIndex: createIdbMetadataIndex(host.metadataIndex, connection, () => activeVault),
    vaultRegistry: {
      ...host.vaultRegistry,
      openVault: async path => {
        activeVault = null;
        const opened = await host.vaultRegistry.openVault(path);
        activeVault = opened.root;
        if (!pruneScheduled) {
          pruneScheduled = true;
          const current = opened.root;
          schedulePrune(() => pruneUnregisteredVaultRecords(
            connection,
            async () => [...await host.vaultRegistry.getRecentVaults(), current, ...(activeVault ? [activeVault] : [])],
            options.legacyConfigNames ? { names: options.legacyConfigNames, config: host.config } : undefined,
          ));
        }
        return opened;
      },
      closeVault: async () => {
        activeVault = null;
        await host.vaultRegistry.closeVault();
      },
    },
  };
}

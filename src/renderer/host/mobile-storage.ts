import type { HostServices } from "./contracts";
import { createIdbConfig, createIdbDeviceState } from "./idb-device-state";

/**
 * The durable stores the native iOS shell uses in place of the browser host's single localStorage snapshot (about 5 MB
 * on iOS, shared by every config key): device state, and the vault-sized reconcile manifest.
 */
export function withDurableMobileStorage(host: HostServices, factory: IDBFactory = indexedDB): HostServices {
  return { ...host, deviceState: createIdbDeviceState(host.deviceState, factory), config: createIdbConfig(host.config, factory) };
}

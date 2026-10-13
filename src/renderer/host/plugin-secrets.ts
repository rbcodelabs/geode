import type { SecureSecretService } from "./contracts";

/**
 * Native (or test) key/value store scoped by an opaque namespace. On iOS this
 * is the Keychain; the namespace is always derived from a plugin id by the
 * host, never supplied by plugin code.
 */
export interface NamespacedSecretBackend {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_BYTES = 64 * 1024;

export interface MobilePluginSecretService extends SecureSecretService {
  /** Mint (or return the existing) per-session capability for a plugin's namespace. */
  capabilityFor(pluginId: string): string | undefined;
}

/**
 * Plugin secret service for hosts without Electron's main process. A plugin
 * only ever receives an unguessable per-session capability that the host maps
 * back to its own namespace, so `loadSecret`/`saveSecret` cannot be pointed at
 * another plugin's keys. `available=false` keeps credentialed features
 * disabled exactly like the browser host always did.
 */
export function createMobilePluginSecretService(backend: NamespacedSecretBackend | undefined): MobilePluginSecretService {
  const byPlugin = new Map<string, string>();
  const byCapability = new Map<string, string>();
  const unavailable = () => new Error("Secure secret storage is unavailable on this host");
  const checkKey = (key: string) => {
    if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) throw new Error("Invalid secret key");
  };
  return {
    available: backend !== undefined,
    capabilityFor(pluginId) {
      if (!backend || !PLUGIN_ID.test(pluginId)) return undefined;
      let capability = byPlugin.get(pluginId);
      if (!capability) {
        capability = `cap_${crypto.randomUUID()}`;
        byPlugin.set(pluginId, capability);
        byCapability.set(capability, pluginId);
      }
      return capability;
    },
    fromCapability(capability) {
      const namespace = byCapability.get(capability);
      if (!backend || !namespace) {
        return { get: async () => null, set: async () => { throw unavailable(); }, remove: async () => {} };
      }
      return {
        get: async (key) => { checkKey(key); return backend.get(namespace, key); },
        set: async (key, value) => {
          checkKey(key);
          if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) throw new Error("Secret value is too large");
          await backend.set(namespace, key, value);
        },
        remove: async (key) => { checkKey(key); await backend.remove(namespace, key); },
      };
    },
  };
}

/** `.geode/plugins/<id>/main(.mobile)?.js` → plugin id, else null. */
export function pluginIdFromEntryPath(path: string): string | null {
  const match = /^\.geode\/plugins\/([a-z0-9][a-z0-9-]*)\/main(?:\.mobile)?\.js$/.exec(path);
  return match ? match[1] : null;
}

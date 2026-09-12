/**
 * Obsidian's `app.secretStorage`.
 *
 * The API is synchronous by design — `getSecret(id): string | null`,
 * `setSecret(id, value): void`, `listSecrets(): string[]` — and hosted plugins
 * depend on that: obsidian-claude-threads calls `.startsWith('sk-')` straight
 * on a read, and assembles a subprocess environment out of several reads with
 * no `await` anywhere. Returning promises here would hand those call sites a
 * `Promise` where a string was expected, which is a worse failure than the one
 * this module exists to fix.
 *
 * So reads are served from an in-memory mirror. The mirror is hydrated once,
 * lazily, through the one blocking `readSecretsSync` bridge call; writes update
 * it immediately and are persisted asynchronously by the main process, which
 * holds the only copy on disk — encrypted with Electron's `safeStorage`, i.e.
 * the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 *
 * Where `safeStorage` has no backend, or where there is no Electron bridge at
 * all (the mobile/browser facade), this degrades to the original localStorage
 * behaviour rather than throwing — but `isEncryptionAvailable()` then reports
 * `false`, so UI that claims "stored in your OS keychain" can tell the truth.
 */

/** Legacy plaintext entries live under this prefix in localStorage. */
const LEGACY_PREFIX = "geode:secret:";

export interface SecretStorage {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
  deleteSecret(id: string): void;
  listSecrets(): string[];
  isEncryptionAvailable(): boolean;
}

interface SecretBridge {
  readSecretsSync?: (migrating: Record<string, string>) => {
    available: boolean;
    secrets: Record<string, string>;
  };
  setSecret?: (id: string, value: string) => Promise<void>;
  deleteSecret?: (id: string) => Promise<void>;
}

type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function legacyEntries(storage: WebStorage | undefined): Record<string, string> {
  const found: Record<string, string> = {};
  if (!storage) return found;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(LEGACY_PREFIX)) continue;
    const value = storage.getItem(key);
    if (typeof value === "string") found[key.slice(LEGACY_PREFIX.length)] = value;
  }
  return found;
}

export function createSecretStorage(
  bridge: SecretBridge | undefined = typeof window === "undefined" ? undefined : window.geode,
  storage: WebStorage | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): SecretStorage {
  /** Null until the first read/write forces hydration. */
  let cache: Map<string, string> | null = null;
  let encrypted = false;

  const hydrate = (): Map<string, string> => {
    if (cache) return cache;
    const legacy = legacyEntries(storage);
    let snapshot: { available: boolean; secrets: Record<string, string> } | undefined;
    try {
      snapshot = bridge?.readSecretsSync?.(legacy);
    } catch (error) {
      console.error("Secret storage: keychain hydration failed; using localStorage", error);
    }
    if (snapshot?.available) {
      encrypted = true;
      cache = new Map(Object.entries(snapshot.secrets));
      // The keychain now holds these, so the plaintext copies must not linger.
      for (const id of Object.keys(legacy)) storage?.removeItem(`${LEGACY_PREFIX}${id}`);
    } else {
      encrypted = false;
      cache = new Map(Object.entries(legacy));
    }
    return cache;
  };

  /** localStorage is still the store of record when there is no keychain. */
  const writeFallback = (id: string, value: string | null): void => {
    if (encrypted) return;
    if (value === null) storage?.removeItem(`${LEGACY_PREFIX}${id}`);
    else storage?.setItem(`${LEGACY_PREFIX}${id}`, value);
  };

  return {
    getSecret(id: string): string | null {
      return hydrate().get(id) ?? null;
    },

    setSecret(id: string, value: string): void {
      hydrate().set(id, value);
      writeFallback(id, value);
      if (!encrypted) return;
      bridge?.setSecret?.(id, value).catch((error: unknown) => {
        console.error(`Secret storage: failed to persist "${id}"`, error);
      });
    },

    deleteSecret(id: string): void {
      hydrate().delete(id);
      writeFallback(id, null);
      if (!encrypted) return;
      bridge?.deleteSecret?.(id).catch((error: unknown) => {
        console.error(`Secret storage: failed to delete "${id}"`, error);
      });
    },

    listSecrets(): string[] {
      return [...hydrate().keys()];
    },

    isEncryptionAvailable(): boolean {
      hydrate();
      return encrypted;
    },
  };
}

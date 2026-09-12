import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./config-file";

/**
 * The slice of Electron's `safeStorage` this store needs. Injected rather than
 * imported so the store is testable under plain node — `electron` cannot be
 * required from a vitest process.
 */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretSnapshot {
  /**
   * Whether an OS-backed keychain is actually encrypting this store. False on
   * hosts where `safeStorage` has no backend (some Linux setups); callers must
   * then keep using their own fallback and must NOT delete their copies.
   */
  available: boolean;
  /** Decrypted id -> value. Always empty when `available` is false. */
  secrets: Record<string, string>;
}

interface PersistedSecrets {
  version: 1;
  secrets: Record<string, string>;
}

/**
 * Obsidian's secret ids are documented as "lowercase alphanumeric with
 * optional dashes". This is deliberately a little wider (dots, underscores,
 * upper case) so plugins that were never that strict still work, but it must
 * start with an alphanumeric — which is what keeps `__proto__` and friends out
 * of the JSON object this is serialized into.
 */
const SECRET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidSecretId(id: unknown): id is string {
  return typeof id === "string" && SECRET_ID_PATTERN.test(id);
}

/**
 * Keychain-backed secret storage for `app.secretStorage`.
 *
 * Ciphertext lives in a single JSON file in the app's userData directory:
 * `{ version: 1, secrets: { id: base64(safeStorage.encryptString(value)) } }`.
 * Plaintext is never written to disk — when `safeStorage` reports no backend
 * this store refuses to hold anything at all and reports `available: false`,
 * leaving the caller to decide what to do (the renderer falls back to its old
 * localStorage behaviour and tells the user the truth about it).
 *
 * Entries that fail to decrypt — a file carried over from another OS user, or
 * a keychain that was reset — are kept as opaque ciphertext and written back
 * untouched, so a single unreadable secret never silently deletes the rest.
 */
export class SecretStore {
  /** Decrypted values, loaded once per process. */
  private plain: Map<string, string> | null = null;
  /** Entries that could not be decrypted, preserved verbatim across writes. */
  private opaque = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly crypto: SecretCrypto,
  ) {}

  isEncryptionAvailable(): boolean {
    try {
      return this.crypto.isEncryptionAvailable();
    } catch (error) {
      console.error("Secret storage: safeStorage availability check failed", error);
      return false;
    }
  }

  /**
   * Read the whole store, folding in any `legacy` plaintext entries the caller
   * is migrating out of an older location. Legacy entries never overwrite one
   * already held here. The caller may delete its plaintext copies only when
   * the returned snapshot says `available`.
   */
  hydrate(legacy: Record<string, string> = {}): SecretSnapshot {
    if (!this.isEncryptionAvailable()) return { available: false, secrets: {} };
    const plain = this.load();
    let migrated = false;
    for (const [id, value] of Object.entries(legacy)) {
      if (typeof value !== "string" || !isValidSecretId(id)) continue;
      if (plain.has(id) || this.opaque.has(id)) continue;
      plain.set(id, value);
      migrated = true;
    }
    if (migrated) this.persist();
    return { available: true, secrets: Object.fromEntries(plain) };
  }

  get(id: string): string | null {
    if (!this.isEncryptionAvailable() || !isValidSecretId(id)) return null;
    return this.load().get(id) ?? null;
  }

  list(): string[] {
    if (!this.isEncryptionAvailable()) return [];
    return [...this.load().keys(), ...this.opaque.keys()];
  }

  set(id: string, value: string): void {
    if (!isValidSecretId(id)) throw new Error(`Invalid secret id: ${String(id)}`);
    if (!this.isEncryptionAvailable()) {
      throw new Error("Secret storage is unavailable: no OS encryption backend");
    }
    const plain = this.load();
    // A rewritten id supersedes any ciphertext we could not read for it.
    this.opaque.delete(id);
    plain.set(id, value);
    this.persist();
  }

  delete(id: string): void {
    if (!this.isEncryptionAvailable() || !isValidSecretId(id)) return;
    const plain = this.load();
    const removed = plain.delete(id) || this.opaque.delete(id);
    if (removed) this.persist();
  }

  /** Resolves once every queued write has landed. Tests and shutdown use this. */
  flush(): Promise<void> {
    return this.writes;
  }

  private load(): Map<string, string> {
    if (this.plain) return this.plain;
    const plain = new Map<string, string>();
    this.plain = plain;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Secret storage: failed to read secrets file", error);
      }
      return plain;
    }
    let parsed: PersistedSecrets;
    try {
      parsed = JSON.parse(raw) as PersistedSecrets;
    } catch (error) {
      console.error("Secret storage: secrets file is not valid JSON; ignoring", error);
      return plain;
    }
    for (const [id, encoded] of Object.entries(parsed?.secrets ?? {})) {
      if (!isValidSecretId(id) || typeof encoded !== "string") continue;
      try {
        plain.set(id, this.crypto.decryptString(Buffer.from(encoded, "base64")));
      } catch {
        // Undecryptable here does not mean corrupt everywhere — keep the bytes.
        this.opaque.set(id, encoded);
      }
    }
    return plain;
  }

  /**
   * Encrypt and write the whole store. Serialized behind `this.writes` so two
   * rapid `setSecret` calls cannot interleave their atomic replaces.
   */
  private persist(): void {
    const snapshot: Record<string, string> = {};
    for (const [id, value] of this.plain ?? []) {
      try {
        snapshot[id] = this.crypto.encryptString(value).toString("base64");
      } catch (error) {
        console.error(`Secret storage: failed to encrypt "${id}"; dropping from this write`, error);
      }
    }
    for (const [id, encoded] of this.opaque) snapshot[id] = encoded;
    const payload: PersistedSecrets = { version: 1, secrets: snapshot };
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await writeJsonAtomic(this.filePath, payload);
      })
      .catch((error) => {
        console.error("Secret storage: failed to write secrets file", error);
      });
  }
}

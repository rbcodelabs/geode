import { describe, expect, it, vi } from "vitest";
import { createSecretStorage } from "../../src/renderer/secret-storage";

/**
 * The renderer half of `app.secretStorage`. Two contracts matter here and both
 * were broken before: the API must stay SYNCHRONOUS (obsidian-claude-threads
 * calls `.startsWith('sk-')` straight on a read and builds a subprocess env
 * map out of several reads with no await), and `isEncryptionAvailable()` must
 * report the truth so UI can stop claiming an OS keychain it does not have.
 */

class FakeStorage {
  private readonly entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
  snapshot() { return Object.fromEntries(this.entries); }
}

/** A bridge standing in for the keychain-backed main process. */
function makeBridge(initial: Record<string, string> = {}, available = true) {
  const persisted = new Map(Object.entries(initial));
  const state = { migrated: undefined as Record<string, string> | undefined };
  return {
    persisted,
    /** What the renderer handed over for migration on its one hydrate call. */
    get migrated() { return state.migrated; },
    readSecretsSync: vi.fn((migrating: Record<string, string>) => {
      state.migrated = migrating;
      if (!available) return { available: false, secrets: {} };
      for (const [id, value] of Object.entries(migrating)) if (!persisted.has(id)) persisted.set(id, value);
      return { available: true, secrets: Object.fromEntries(persisted) };
    }),
    setSecret: vi.fn(async (id: string, value: string) => { persisted.set(id, value); }),
    deleteSecret: vi.fn(async (id: string) => { persisted.delete(id); }),
  };
}

describe("createSecretStorage with a keychain-backed bridge", () => {
  it("serves reads synchronously from the hydrated mirror", () => {
    const storage = createSecretStorage(makeBridge({ "openai-api-key": "sk-live" }), new FakeStorage());

    const value = storage.getSecret("openai-api-key");

    // Not a promise — the whole point.
    expect(value).toBe("sk-live");
    expect(value?.startsWith("sk-")).toBe(true);
    expect(storage.isEncryptionAvailable()).toBe(true);
  });

  it("hydrates once no matter how many reads happen", () => {
    const b = makeBridge({ a: "1" });
    const storage = createSecretStorage(b, new FakeStorage());

    storage.getSecret("a");
    storage.getSecret("a");
    storage.listSecrets();

    expect(b.readSecretsSync).toHaveBeenCalledTimes(1);
  });

  it("makes a written secret readable immediately and persists it behind the scenes", async () => {
    const b = makeBridge();
    const storage = createSecretStorage(b, new FakeStorage());

    storage.setSecret("token", "value");

    expect(storage.getSecret("token")).toBe("value");
    expect(storage.listSecrets()).toEqual(["token"]);
    await vi.waitFor(() => expect(b.setSecret).toHaveBeenCalledWith("token", "value"));
  });

  it("deletes through the bridge", async () => {
    const b = makeBridge({ gone: "x" });
    const storage = createSecretStorage(b, new FakeStorage());

    storage.deleteSecret("gone");

    expect(storage.getSecret("gone")).toBeNull();
    await vi.waitFor(() => expect(b.deleteSecret).toHaveBeenCalledWith("gone"));
  });

  it("migrates legacy plaintext out of localStorage and leaves no copy behind", () => {
    const local = new FakeStorage();
    local.setItem("geode:secret:openai-api-key", "sk-plaintext");
    local.setItem("geode:secret:ct-secret-token", "tok");
    local.setItem("geode:unrelated", "keep-me");
    const b = makeBridge();

    const storage = createSecretStorage(b, local);
    expect(storage.getSecret("openai-api-key")).toBe("sk-plaintext");

    expect(b.migrated).toEqual({ "openai-api-key": "sk-plaintext", "ct-secret-token": "tok" });
    expect(local.snapshot()).toEqual({ "geode:unrelated": "keep-me" });
  });

  it("does not fail a read when the write-back rejects", async () => {
    const b = makeBridge();
    b.setSecret.mockRejectedValueOnce(new Error("disk full"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createSecretStorage(b, new FakeStorage());

    expect(() => storage.setSecret("k", "v")).not.toThrow();
    expect(storage.getSecret("k")).toBe("v");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    errors.mockRestore();
  });
});

describe("createSecretStorage without a keychain", () => {
  it("falls back to localStorage and admits encryption is unavailable", () => {
    const local = new FakeStorage();
    const storage = createSecretStorage(makeBridge({}, false), local);

    storage.setSecret("k", "v");

    expect(storage.isEncryptionAvailable()).toBe(false);
    expect(storage.getSecret("k")).toBe("v");
    // Still the store of record, so the value must actually be there.
    expect(local.getItem("geode:secret:k")).toBe("v");
  });

  it("keeps existing plaintext entries readable rather than deleting them", () => {
    const local = new FakeStorage();
    local.setItem("geode:secret:kept", "value");
    const storage = createSecretStorage(makeBridge({}, false), local);

    expect(storage.getSecret("kept")).toBe("value");
    expect(storage.listSecrets()).toEqual(["kept"]);
    expect(local.getItem("geode:secret:kept")).toBe("value");

    storage.deleteSecret("kept");
    expect(local.getItem("geode:secret:kept")).toBeNull();
  });

  it("works on a host with no secret bridge at all (mobile/browser facade)", () => {
    const local = new FakeStorage();
    const storage = createSecretStorage({}, local);

    storage.setSecret("k", "v");

    expect(storage.isEncryptionAvailable()).toBe(false);
    expect(storage.getSecret("k")).toBe("v");
    expect(local.getItem("geode:secret:k")).toBe("v");
  });

  it("degrades to localStorage when the bridge throws", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const local = new FakeStorage();
    local.setItem("geode:secret:kept", "value");
    const storage = createSecretStorage(
      { readSecretsSync: () => { throw new Error("IPC exploded"); } },
      local,
    );

    expect(storage.getSecret("kept")).toBe("value");
    expect(storage.isEncryptionAvailable()).toBe(false);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("works with no storage and no bridge without throwing", () => {
    const storage = createSecretStorage({}, undefined);
    expect(() => storage.setSecret("k", "v")).not.toThrow();
    expect(storage.getSecret("k")).toBe("v");
    expect(storage.getSecret("absent")).toBeNull();
  });
});

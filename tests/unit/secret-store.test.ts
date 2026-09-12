import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStore, isValidSecretId, type SecretCrypto } from "../../src/main/secret-store";

/**
 * `app.secretStorage` used to persist secrets as plaintext in localStorage,
 * while the UI on top of it (obsidian-claude-threads' OpenAI key field) told
 * the user "Stored in your OS keychain." These cover the store that now backs
 * it with Electron's `safeStorage`: nothing readable ever reaches disk, and a
 * host with no encryption backend says so instead of pretending.
 *
 * `safeStorage` itself cannot be imported under vitest (it needs a running
 * Electron), so the crypto is injected — which is also what lets these tests
 * assert on the exact bytes written.
 */

const MARKER = "encrypted:";

function fakeCrypto(overrides: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`${MARKER}${plain}`, "utf8"),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith(MARKER)) throw new Error("not decryptable by this key");
      return text.slice(MARKER.length);
    },
    ...overrides,
  };
}

const tempDirs: string[] = [];
function storePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-secret-store-"));
  tempDirs.push(dir);
  return path.join(dir, "secrets.json");
}

function readRaw(file: string): { version: number; secrets: Record<string, string> } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("isValidSecretId", () => {
  it("accepts the ids Obsidian plugins actually use", () => {
    expect(isValidSecretId("openai-api-key")).toBe(true);
    expect(isValidSecretId("ct-secret-linear-api-key")).toBe(true);
  });

  it("rejects ids that would collide with object internals or escape the key space", () => {
    expect(isValidSecretId("__proto__")).toBe(false);
    expect(isValidSecretId("../../etc/passwd")).toBe(false);
    expect(isValidSecretId("")).toBe(false);
    expect(isValidSecretId(42)).toBe(false);
  });
});

describe("SecretStore", () => {
  it("round-trips a secret without ever writing readable bytes to disk", async () => {
    const file = storePath();
    const store = new SecretStore(file, fakeCrypto());

    store.set("openai-api-key", "sk-super-secret");
    await store.flush();

    expect(store.get("openai-api-key")).toBe("sk-super-secret");
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("sk-super-secret");
    expect(Buffer.from(readRaw(file).secrets["openai-api-key"], "base64").toString("utf8")).toBe(
      `${MARKER}sk-super-secret`,
    );
  });

  it("reads back what a previous process wrote", async () => {
    const file = storePath();
    const first = new SecretStore(file, fakeCrypto());
    first.set("token", "abc");
    await first.flush();

    const second = new SecretStore(file, fakeCrypto());
    expect(second.get("token")).toBe("abc");
    expect(second.list()).toEqual(["token"]);
  });

  it("migrates legacy plaintext entries on hydrate without overwriting existing ones", async () => {
    const file = storePath();
    const store = new SecretStore(file, fakeCrypto());
    store.set("kept", "from-keychain");
    await store.flush();

    const snapshot = store.hydrate({ kept: "from-localstorage", moved: "legacy-value" });
    await store.flush();

    expect(snapshot.available).toBe(true);
    expect(snapshot.secrets).toEqual({ kept: "from-keychain", moved: "legacy-value" });
    expect(fs.readFileSync(file, "utf8")).not.toContain("legacy-value");
  });

  it("ignores legacy entries with unusable ids", () => {
    const store = new SecretStore(storePath(), fakeCrypto());
    // Built via fromEntries so "__proto__" is a real own property, the way it
    // would arrive from a localStorage scan — an object literal would set the
    // prototype instead and never reach Object.entries.
    const legacy = Object.fromEntries([["__proto__", "x"], ["bad/id", "y"], ["good", "z"]]);

    expect(store.hydrate(legacy).secrets).toEqual({ good: "z" });
  });

  it("reports unavailable, holds nothing, and refuses writes without an encryption backend", () => {
    const file = storePath();
    const store = new SecretStore(file, fakeCrypto({ isEncryptionAvailable: () => false }));

    expect(store.isEncryptionAvailable()).toBe(false);
    expect(store.hydrate({ leaked: "value" })).toEqual({ available: false, secrets: {} });
    expect(store.get("leaked")).toBeNull();
    expect(store.list()).toEqual([]);
    expect(() => store.set("leaked", "value")).toThrow(/no OS encryption backend/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects an invalid id rather than writing it", () => {
    const store = new SecretStore(storePath(), fakeCrypto());
    expect(() => store.set("../escape", "value")).toThrow(/Invalid secret id/);
  });

  it("deletes a secret and persists the removal", async () => {
    const file = storePath();
    const store = new SecretStore(file, fakeCrypto());
    store.set("a", "1");
    store.set("b", "2");
    await store.flush();

    store.delete("a");
    await store.flush();

    expect(store.get("a")).toBeNull();
    expect(store.list()).toEqual(["b"]);
    expect(new SecretStore(file, fakeCrypto()).list()).toEqual(["b"]);
  });

  it("keeps entries it cannot decrypt instead of silently dropping them", async () => {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        secrets: { foreign: Buffer.from("written-by-another-keychain").toString("base64") },
      }),
    );
    const store = new SecretStore(file, fakeCrypto());

    expect(store.get("foreign")).toBeNull();
    expect(store.list()).toContain("foreign");

    store.set("mine", "value");
    await store.flush();

    // The unreadable entry survives the rewrite byte for byte.
    expect(readRaw(file).secrets.foreign).toBe(
      Buffer.from("written-by-another-keychain").toString("base64"),
    );
  });

  it("survives a corrupt secrets file rather than throwing on first read", () => {
    const file = storePath();
    fs.writeFileSync(file, "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new SecretStore(file, fakeCrypto());

    expect(store.get("anything")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("serializes concurrent writes so the last one wins on disk", async () => {
    const file = storePath();
    const store = new SecretStore(file, fakeCrypto());

    store.set("k", "one");
    store.set("k", "two");
    store.set("k", "three");
    await store.flush();

    expect(new SecretStore(file, fakeCrypto()).get("k")).toBe("three");
  });
});

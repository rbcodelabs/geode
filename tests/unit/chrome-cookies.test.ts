import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chromeEpochToUnixSeconds,
  decryptCookieValue,
  deriveSafeStorageKey,
} from "../../src/main/chrome-cookies";

// --- deriveSafeStorageKey ----------------------------------------------------

describe("deriveSafeStorageKey", () => {
  it("matches the documented macOS Chrome scheme: PBKDF2-HMAC-SHA1, salt 'saltysalt', 1003 iterations, 16-byte key", () => {
    const key = deriveSafeStorageKey("test-keychain-password");
    const expected = pbkdf2Sync("test-keychain-password", "saltysalt", 1003, 16, "sha1");
    expect(key.equals(expected)).toBe(true);
    expect(key.length).toBe(16);
  });

  it("produces different keys for different passwords", () => {
    const a = deriveSafeStorageKey("password-a");
    const b = deriveSafeStorageKey("password-b");
    expect(a.equals(b)).toBe(false);
  });
});

// --- decryptCookieValue ------------------------------------------------------

/** Encrypt `plaintext` the way Chrome does, for use as a round-trip test fixture (real Chrome-encrypted bytes aren't available without live Keychain/Chrome access). */
function encryptLikeChrome(plaintext: Buffer, key: Buffer): Buffer {
  const iv = Buffer.from(" ".repeat(16), "latin1");
  const cipher = createCipheriv("aes-128-cbc", key, iv); // default auto-padding = PKCS7
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), encrypted]);
}

describe("decryptCookieValue", () => {
  const key = deriveSafeStorageKey("test-keychain-password");

  it("strips the v10 prefix and decrypts AES-128-CBC with the fixed IV", () => {
    const fixture = encryptLikeChrome(Buffer.from("session-token-abc123", "utf8"), key);
    expect(decryptCookieValue(fixture, key)).toBe("session-token-abc123");
  });

  it("handles the v11 prefix the same way as v10", () => {
    const encrypted = encryptLikeChrome(Buffer.from("value", "utf8"), key).subarray(3);
    const fixture = Buffer.concat([Buffer.from("v11", "latin1"), encrypted]);
    expect(decryptCookieValue(fixture, key)).toBe("value");
  });

  it("returns non-v10/v11 values as-is (legacy plaintext rows)", () => {
    const plain = Buffer.from("already-plaintext", "utf8");
    expect(decryptCookieValue(plain, key)).toBe("already-plaintext");
  });

  it("strips a 32-byte SHA-256 domain-hash prefix only when it matches the given domain", () => {
    const domain = "example.com";
    const domainHash = createHash("sha256").update(domain).digest();
    const plaintext = Buffer.concat([domainHash, Buffer.from("bound-cookie-value", "utf8")]);
    const fixture = encryptLikeChrome(plaintext, key);
    expect(decryptCookieValue(fixture, key, domain)).toBe("bound-cookie-value");
  });

  it("does not strip a 32+ byte plaintext when the domain hash doesn't match (no false-positive strip)", () => {
    const plaintext = Buffer.from("a".repeat(40), "utf8"); // >32 bytes, no domain-hash prefix
    const fixture = encryptLikeChrome(plaintext, key);
    expect(decryptCookieValue(fixture, key, "example.com")).toBe("a".repeat(40));
  });

  it("returns an empty string for an empty encrypted value", () => {
    expect(decryptCookieValue(Buffer.alloc(0), key)).toBe("");
  });
});

// --- chromeEpochToUnixSeconds -------------------------------------------------

describe("chromeEpochToUnixSeconds", () => {
  it("converts a known expires_utc (microseconds since 1601-01-01) to the correct Unix seconds", () => {
    // 2024-01-01T00:00:00Z in Chrome's epoch: seconds-since-1970 (1704067200)
    // plus the 1601->1970 offset (11644473600), in microseconds.
    const unixSeconds2024 = 1704067200;
    const expiresUtc = (unixSeconds2024 + 11644473600) * 1_000_000;
    expect(chromeEpochToUnixSeconds(expiresUtc)).toBe(unixSeconds2024);
  });

  it("treats expires_utc === 0 as a session cookie (undefined, not epoch 1601)", () => {
    expect(chromeEpochToUnixSeconds(0)).toBeUndefined();
  });
});

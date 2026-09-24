import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  chromeCookieToSetDetails,
  chromeEpochToUnixSeconds,
  chromeSameSiteToElectron,
  decryptCookieValue,
  deriveSafeStorageKey,
  isHostOnlyCookie,
  readCookieRows,
} from "../../src/main/chrome-cookies";

/**
 * Every cookie name/domain below is a real-world shape, but every VALUE is
 * synthetic. Nothing here is copied from a live cookie store.
 */
const SYNTHETIC_VALUE = "synthetic-test-value";

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

  it("handles a BigInt expires_utc that exceeds Number.MAX_SAFE_INTEGER", () => {
    // Far-future cookies are read from SQLite as BigInt because their value
    // overflows a JS number. This is the exact value that crashed the live
    // import: 13436061507056382 microseconds since 1601-01-01.
    const expiresUtc = 13436061507056382n;
    expect(expiresUtc > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(chromeEpochToUnixSeconds(expiresUtc)).toBeCloseTo(1791587907.056382, 3);
  });

  it("treats a BigInt 0n expires_utc as a session cookie", () => {
    expect(chromeEpochToUnixSeconds(0n)).toBeUndefined();
  });
});

// --- chromeSameSiteToElectron -------------------------------------------------

describe("chromeSameSiteToElectron", () => {
  // Chrome stores net::CookieSameSite as an int; Electron's cookies.set takes a
  // string enum. Dropping the attribute (the old behavior) silently downgrades
  // SameSite=None cookies to Lax, after which Chromium never sends them
  // cross-site — which is the failure that breaks Gmail.
  it("maps Chrome's int enum onto Electron's string enum", () => {
    expect(chromeSameSiteToElectron(-1)).toBe("unspecified");
    expect(chromeSameSiteToElectron(0)).toBe("no_restriction");
    expect(chromeSameSiteToElectron(1)).toBe("lax");
    expect(chromeSameSiteToElectron(2)).toBe("strict");
  });

  it("maps the same values read as BigInt (node:sqlite BigInt mode)", () => {
    expect(chromeSameSiteToElectron(-1n)).toBe("unspecified");
    expect(chromeSameSiteToElectron(0n)).toBe("no_restriction");
    expect(chromeSameSiteToElectron(1n)).toBe("lax");
    expect(chromeSameSiteToElectron(2n)).toBe("strict");
  });

  it("treats a missing column (null/undefined) as unspecified, not as None", () => {
    // 0 is a meaningful value here, so the nullish check must not collapse it.
    expect(chromeSameSiteToElectron(null)).toBe("unspecified");
    expect(chromeSameSiteToElectron(undefined)).toBe("unspecified");
    expect(chromeSameSiteToElectron(0)).toBe("no_restriction");
  });

  it("degrades an unrecognized future value to unspecified rather than guessing", () => {
    expect(chromeSameSiteToElectron(99)).toBe("unspecified");
  });
});

// --- isHostOnlyCookie ---------------------------------------------------------

describe("isHostOnlyCookie", () => {
  it("treats a leading dot as a domain cookie and its absence as host-only", () => {
    expect(isHostOnlyCookie("mail.google.com")).toBe(true);
    expect(isHostOnlyCookie(".google.com")).toBe(false);
  });
});

// --- chromeCookieToSetDetails -------------------------------------------------

/** A minimal persistent, secure, host-only row; override per test. */
function row(overrides: Partial<Parameters<typeof chromeCookieToSetDetails>[0]> = {}) {
  return {
    host_key: "mail.google.com",
    name: "SOME_COOKIE",
    path: "/",
    is_secure: 1,
    expires_utc: (1_800_000_000 + 11644473600) * 1_000_000,
    ...overrides,
  };
}

describe("chromeCookieToSetDetails — host-only vs domain (defect 1)", () => {
  it("OMITS domain for a host-only row so Chromium accepts a __Host- cookie", () => {
    // This is the headline fix. Chromium rejects any __Host- cookie carrying a
    // Domain attribute: "The cookie was set with an invalid __Host- or
    // __Secure- prefix". Passing host_key unconditionally made every __Host-
    // cookie in the profile unimportable.
    const details = chromeCookieToSetDetails(
      row({ name: "__Host-GMAIL_SCH_GML", host_key: "mail.google.com" }),
      SYNTHETIC_VALUE,
    );
    expect(details).not.toHaveProperty("domain");
    expect(details.url).toBe("https://mail.google.com/");
  });

  it("keeps host_key verbatim (leading dot included) for a domain row", () => {
    const details = chromeCookieToSetDetails(
      row({ name: "__Secure-3PSID", host_key: ".google.com" }),
      SYNTHETIC_VALUE,
    );
    expect(details.domain).toBe(".google.com");
    // The URL drops the dot — it needs a concrete host.
    expect(details.url).toBe("https://google.com/");
  });

  it("omits domain for an ordinary host-only cookie too, so it is not widened to subdomains", () => {
    // Electron normalizes a supplied `domain` "with a preceding dot", so
    // passing it turned mail.google.com into .mail.google.com.
    const details = chromeCookieToSetDetails(row({ name: "OSID" }), SYNTHETIC_VALUE);
    expect(details).not.toHaveProperty("domain");
  });

  it("asserts Secure from a __Host-/__Secure- prefix, which Chromium requires for both", () => {
    for (const name of ["__Host-GMAIL_SCH", "__Secure-OSID"]) {
      expect(chromeCookieToSetDetails(row({ name, is_secure: 0 }), SYNTHETIC_VALUE).secure).toBe(true);
    }
    // No prefix: the column is authoritative.
    expect(chromeCookieToSetDetails(row({ name: "PLAIN", is_secure: 0 }), SYNTHETIC_VALUE).secure).toBe(false);
  });

  it("passes a __Host- cookie's path through unchanged rather than inventing one", () => {
    expect(chromeCookieToSetDetails(row({ name: "__Host-X", path: "/" }), SYNTHETIC_VALUE).path).toBe("/");
  });
});

describe("chromeCookieToSetDetails — httpOnly and sameSite (defect 2)", () => {
  it("carries httpOnly across instead of defaulting it to false", () => {
    expect(chromeCookieToSetDetails(row({ is_httponly: 1 }), SYNTHETIC_VALUE).httpOnly).toBe(true);
    expect(chromeCookieToSetDetails(row({ is_httponly: 0 }), SYNTHETIC_VALUE).httpOnly).toBe(false);
    // Column absent from an old schema: absent, not true.
    expect(chromeCookieToSetDetails(row(), SYNTHETIC_VALUE).httpOnly).toBe(false);
  });

  it("carries sameSite across instead of letting it default to lax", () => {
    expect(chromeCookieToSetDetails(row({ samesite: 0 }), SYNTHETIC_VALUE).sameSite).toBe("no_restriction");
    expect(chromeCookieToSetDetails(row({ samesite: 2 }), SYNTHETIC_VALUE).sameSite).toBe("strict");
  });

  it("keeps SameSite=None on a secure cookie — the case cross-site auth depends on", () => {
    const details = chromeCookieToSetDetails(
      row({ name: "__Secure-3PSID", host_key: ".google.com", is_secure: 1, samesite: 0 }),
      SYNTHETIC_VALUE,
    );
    expect(details.sameSite).toBe("no_restriction");
    expect(details.secure).toBe(true);
  });

  it("demotes SameSite=None to unspecified when the row is not Secure, rather than letting Chromium reject the pair", () => {
    // Chromium requires Secure for SameSite=None. Forcing secure:true instead
    // would contradict the http:// URL this row implies, so the unhonorable
    // attribute is dropped and the cookie still imports.
    const details = chromeCookieToSetDetails(
      row({ name: "LEGACY", host_key: "example.com", is_secure: 0, samesite: 0 }),
      SYNTHETIC_VALUE,
    );
    expect(details.sameSite).toBe("unspecified");
    expect(details.secure).toBe(false);
    expect(details.url).toBe("http://example.com/");
  });

  it("leaves lax/strict alone on an insecure row (only None needs Secure)", () => {
    expect(
      chromeCookieToSetDetails(row({ is_secure: 0, samesite: 1 }), SYNTHETIC_VALUE).sameSite,
    ).toBe("lax");
    expect(
      chromeCookieToSetDetails(row({ is_secure: 0, samesite: 2 }), SYNTHETIC_VALUE).sameSite,
    ).toBe("strict");
  });
});

describe("chromeCookieToSetDetails — expiry (defect 3)", () => {
  it("omits expirationDate for a session cookie, which is what makes it memory-only", () => {
    const details = chromeCookieToSetDetails(row({ name: "GMAIL_AT", expires_utc: 0 }), SYNTHETIC_VALUE);
    expect(details).not.toHaveProperty("expirationDate");
  });

  it("sets expirationDate for a persistent cookie", () => {
    expect(chromeCookieToSetDetails(row(), SYNTHETIC_VALUE).expirationDate).toBe(1_800_000_000);
  });
});

// --- readCookieRows -----------------------------------------------------------

/**
 * Declared types matter, not just names: node:sqlite's `setReadBigInts(true)`
 * keys off a column's declared affinity, so a column created without `INTEGER`
 * comes back as a JS number and the fixture stops modelling the real thing.
 * These match Chrome's own `cookies` schema.
 */
const COLUMN_TYPES: Record<string, string> = {
  host_key: "TEXT NOT NULL",
  name: "TEXT NOT NULL",
  value: "TEXT NOT NULL",
  encrypted_value: "BLOB",
  path: "TEXT NOT NULL",
  is_secure: "INTEGER NOT NULL",
  expires_utc: "INTEGER NOT NULL",
  is_httponly: "INTEGER NOT NULL",
  samesite: "INTEGER NOT NULL",
};

/**
 * Build a synthetic Chrome-shaped Cookies DB. `columns` lets a test model an
 * older schema that predates is_httponly/samesite.
 */
function writeCookieDb(
  rows: Record<string, string | number | bigint | null | Uint8Array>[],
  columns: string[],
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cookie-fixture-"));
  const dbPath = path.join(dir, "Cookies");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies (${columns.map((c) => `${c} ${COLUMN_TYPES[c]}`).join(", ")})`);
  const insert = db.prepare(
    `INSERT INTO cookies (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const r of rows) insert.run(...columns.map((c) => r[c] ?? null));
  db.close();
  return dbPath;
}

const FULL_COLUMNS = Object.keys(COLUMN_TYPES);

const fixtureDirs: string[] = [];
afterAll(() => {
  for (const p of fixtureDirs) fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

function fixture(
  rows: Record<string, string | number | bigint | null | Uint8Array>[],
  columns = FULL_COLUMNS,
) {
  const p = writeCookieDb(rows, columns);
  fixtureDirs.push(p);
  return p;
}

describe("readCookieRows", () => {
  it("reads is_httponly and samesite — the two columns the old SELECT never asked for (defect 2)", async () => {
    const dbPath = fixture([
      {
        host_key: ".google.com",
        name: "__Secure-3PSID",
        value: SYNTHETIC_VALUE,
        encrypted_value: new Uint8Array(),
        path: "/",
        is_secure: 1,
        expires_utc: 13436061507056382n,
        is_httponly: 1,
        samesite: 0,
      },
    ]);
    const [row] = await readCookieRows(dbPath);
    // Regression guard: before the fix these were undefined on every row,
    // because the SELECT simply never named them.
    expect(row.is_httponly).toBe(1n);
    expect(row.samesite).toBe(0n);
    expect(row.host_key).toBe(".google.com");
    // BigInt mode still holds for the far-future expiry that once crashed the import.
    expect(row.expires_utc).toBe(13436061507056382n);
  });

  it("still imports from an older schema that lacks is_httponly and samesite", async () => {
    // The columns are probed rather than assumed: selecting a column the
    // profile doesn't have fails the whole statement, turning a partial
    // import into a total one.
    const legacyColumns = FULL_COLUMNS.filter((c) => c !== "is_httponly" && c !== "samesite");
    const dbPath = fixture(
      [
        {
          host_key: "example.com",
          name: "LEGACY",
          value: SYNTHETIC_VALUE,
          encrypted_value: new Uint8Array(),
          path: "/",
          is_secure: 0,
          expires_utc: 0,
        },
      ],
      legacyColumns,
    );
    const [row] = await readCookieRows(dbPath);
    expect(row.name).toBe("LEGACY");
    expect(row.is_httponly).toBeUndefined();
    // ...and the mapper treats the absent column as unspecified, not None.
    expect(chromeCookieToSetDetails(row, SYNTHETIC_VALUE).sameSite).toBe("unspecified");
  });

  it("leaves the source database untouched (it is copied before being opened)", async () => {
    const dbPath = fixture([
      {
        host_key: "example.com",
        name: "A",
        value: SYNTHETIC_VALUE,
        encrypted_value: new Uint8Array(),
        path: "/",
        is_secure: 1,
        expires_utc: 0,
        is_httponly: 0,
        samesite: 1,
      },
    ]);
    const before = fs.statSync(dbPath).mtimeMs;
    await readCookieRows(dbPath);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before);
  });
});

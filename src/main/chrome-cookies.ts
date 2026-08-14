/**
 * Chrome cookie import (Web Viewer differentiator, macOS-only v1 — see
 * plan's "Out of scope": Windows DPAPI / Linux libsecret decryption aren't
 * implemented). Enumerates local Chrome profiles, decrypts their cookie
 * store using the documented macOS Chrome scheme, and injects the result
 * into Geode's `persist:webviewer` session so Web Viewer tabs open already
 * authenticated. Manual, one-time, user-initiated only (see chrome-cookie-modal.ts).
 *
 * Pure helpers (deriveSafeStorageKey, decryptCookieValue,
 * chromeEpochToUnixSeconds) are exported and unit-tested independently of
 * Electron/filesystem/Keychain access (tests/unit/chrome-cookies.test.ts).
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { session } from "electron";

const execFileAsync = promisify(execFile);

export interface ChromeProfile {
  /** Absolute path to the profile directory (e.g. ".../Chrome/Default"). */
  dir: string;
  /** Display name from Local State's profile.info_cache, falling back to the directory name. */
  name: string;
}

export interface ChromeCookieImportResult {
  imported: number;
  skipped: number;
}

function chromeUserDataDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

/** Path to a profile's Cookies SQLite DB — Chrome M96+ moved it under Network/. */
function cookiesDbPath(profileDir: string): string | null {
  const modern = path.join(profileDir, "Network", "Cookies");
  if (fsSync.existsSync(modern)) return modern;
  const legacy = path.join(profileDir, "Cookies");
  if (fsSync.existsSync(legacy)) return legacy;
  return null;
}

/** Enumerate Chrome profile directories that have a Cookies DB, with display names for the picker. */
export async function listChromeProfiles(): Promise<ChromeProfile[]> {
  const userDataDir = chromeUserDataDir();
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  let infoCache: Record<string, { name?: string }> = {};
  try {
    const localState = JSON.parse(await fs.readFile(path.join(userDataDir, "Local State"), "utf8"));
    infoCache = localState?.profile?.info_cache ?? {};
  } catch {
    // Local State missing or unparsable: fall back to directory names below.
  }

  const profiles: ChromeProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(userDataDir, entry.name);
    if (!cookiesDbPath(dir)) continue;
    profiles.push({ dir, name: infoCache[entry.name]?.name ?? entry.name });
  }
  return profiles;
}

/**
 * Derive the AES key Chrome uses to encrypt cookie values on macOS: PBKDF2-
 * HMAC-SHA1 of the "Chrome Safe Storage" Keychain password, salt "saltysalt",
 * 1003 iterations, 16-byte (AES-128) key length. This is the documented
 * scheme Chromium itself uses (`os_crypt_mac.mm`).
 */
export function deriveSafeStorageKey(keychainPassword: string): Buffer {
  return crypto.pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");
}

/** Read the "Chrome Safe Storage" password from the macOS login Keychain. Prompts the user for consent (Touch ID/password) the first time. */
async function readSafeStoragePassword(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-w",
    "-a",
    "Chrome",
    "-s",
    "Chrome Safe Storage",
  ]);
  const password = stdout.trim();
  if (!password) throw new Error('No "Chrome Safe Storage" Keychain item found — is Chrome installed?');
  return password;
}

/** AES-128-CBC IV Chrome uses for cookie encryption: 16 literal spaces. */
const COOKIE_IV = Buffer.from(" ".repeat(16), "latin1");

function stripPkcs7Padding(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const padLen = buf[buf.length - 1];
  if (padLen > 0 && padLen <= 16 && padLen <= buf.length) return buf.subarray(0, buf.length - padLen);
  return buf; // malformed padding: return as-is rather than throw
}

/**
 * Decrypt one cookie's `encrypted_value` blob. Values not using the
 * documented "v10"/"v11" scheme (e.g. already-plaintext legacy rows) are
 * returned as-is. `domain`, if given, lets us verify — rather than blindly
 * assume — whether Chrome prefixed the plaintext with a 32-byte SHA-256
 * domain-binding hash (added in newer Chrome versions): only strip it when
 * the hash actually matches, so cookie values that don't have this prefix
 * aren't corrupted by an unconditional slice.
 */
export function decryptCookieValue(encryptedValue: Buffer, key: Buffer, domain?: string): string {
  if (encryptedValue.length === 0) return "";
  const prefix = encryptedValue.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return encryptedValue.toString("utf8");

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, COOKIE_IV);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
  const plaintext = stripPkcs7Padding(padded);

  if (domain && plaintext.length > 32) {
    const domainHash = crypto.createHash("sha256").update(domain).digest();
    if (plaintext.subarray(0, 32).equals(domainHash)) {
      return plaintext.subarray(32).toString("utf8");
    }
  }
  return plaintext.toString("utf8");
}

/** Windows FILETIME epoch (1601-01-01) to Unix epoch (1970-01-01), in seconds. */
const WINDOWS_TO_UNIX_EPOCH_OFFSET_SECONDS = 11644473600;

/**
 * Convert Chrome's `expires_utc` (microseconds since 1601-01-01) to Unix
 * epoch seconds, as `session.cookies.set`'s `expirationDate` expects. `0`
 * means a session cookie with no expiration — returned as `undefined` so
 * callers omit `expirationDate` entirely (a session cookie, not one that
 * expired in 1601).
 *
 * Accepts `bigint` as well as `number`: `expires_utc` for far-future cookies
 * exceeds `Number.MAX_SAFE_INTEGER`, so it is read from SQLite as a BigInt.
 * Converting to `number` before the division is safe — the result is in
 * seconds (~1e10), well within the safe-integer range.
 */
export function chromeEpochToUnixSeconds(expiresUtc: number | bigint): number | undefined {
  if (!expiresUtc) return undefined;
  return Number(expiresUtc) / 1_000_000 - WINDOWS_TO_UNIX_EPOCH_OFFSET_SECONDS;
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  // Integer columns are read in BigInt mode (see readCookieRows) so that
  // far-future `expires_utc` values, which exceed Number.MAX_SAFE_INTEGER,
  // don't throw a RangeError when SQLite returns them.
  is_secure: number | bigint;
  expires_utc: number | bigint;
}

/** Read all cookie rows out of a Chrome profile's Cookies DB. Copies the file first — Chrome keeps its live DB locked while running. */
async function readCookieRows(dbPath: string): Promise<CookieRow[]> {
  const tmpPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "geode-chrome-cookies-")),
    "Cookies"
  );
  await fs.copyFile(dbPath, tmpPath);
  try {
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        "SELECT host_key, name, value, encrypted_value, path, is_secure, expires_utc FROM cookies"
      );
      // Read integer columns as BigInt: `expires_utc` for far-future cookies
      // exceeds Number.MAX_SAFE_INTEGER, and node:sqlite throws a RangeError
      // rather than silently losing precision when returning such a value as
      // a JS number.
      stmt.setReadBigInts(true);
      return stmt.all() as unknown as CookieRow[];
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(path.dirname(tmpPath), { recursive: true, force: true });
  }
}

/**
 * Import cookies from a Chrome profile into Geode's `persist:webviewer`
 * session. Decrypts each row, converts it to Electron's cookie shape, and
 * calls `session.cookies.set`. Rows that fail to decrypt or produce an
 * empty value are skipped rather than aborting the whole import.
 */
export async function importChromeCookies(profileDir: string): Promise<ChromeCookieImportResult> {
  const dbPath = cookiesDbPath(profileDir);
  if (!dbPath) throw new Error(`No Cookies database found in ${profileDir}`);

  const key = deriveSafeStorageKey(await readSafeStoragePassword());
  const rows = await readCookieRows(dbPath);

  const target = session.fromPartition("persist:webviewer");
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    let value: string;
    try {
      const encrypted = Buffer.from(row.encrypted_value);
      value = encrypted.length > 0 ? decryptCookieValue(encrypted, key, row.host_key) : row.value;
    } catch {
      skipped++;
      continue;
    }
    if (!value) {
      skipped++;
      continue;
    }

    // host_key can have a leading "." for domain cookies; Electron's
    // cookies.set wants a concrete URL, so build one from the domain/path,
    // stripping the leading dot only for the scheme+host portion.
    const domain = row.host_key.startsWith(".") ? row.host_key.slice(1) : row.host_key;
    const scheme = row.is_secure ? "https" : "http";
    const url = `${scheme}://${domain}${row.path}`;

    try {
      await target.cookies.set({
        url,
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path,
        secure: !!row.is_secure,
        expirationDate: chromeEpochToUnixSeconds(row.expires_utc),
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  await target.cookies.flushStore();
  return { imported, skipped };
}

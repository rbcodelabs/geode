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
  /**
   * How many of the imported cookies were session-scoped (Chrome's
   * `expires_utc === 0`, so no `expirationDate`). Electron keeps session
   * cookies in memory only and never writes them to disk, so these are gone
   * after a Geode restart and the affected sites need a re-import. Surfaced to
   * the user rather than hidden — see chrome-cookie-modal.ts.
   */
  sessionScoped: number;
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

export interface CookieRow {
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
  /**
   * Optional because they are only present when the profile's schema has them
   * (see OPTIONAL_COOKIE_COLUMNS) — a cookie store old enough to lack either
   * still imports, it just can't carry the attribute.
   */
  is_httponly?: number | bigint | null;
  samesite?: number | bigint | null;
}

/** Columns every supported Chrome cookie schema has. */
const REQUIRED_COOKIE_COLUMNS = [
  "host_key",
  "name",
  "value",
  "encrypted_value",
  "path",
  "is_secure",
  "expires_utc",
] as const;

/**
 * Columns selected when present. Both have been in Chrome's schema for many
 * years, but selecting a column a profile doesn't have makes SQLite fail the
 * whole statement ("no such column"), turning a partial import into a total
 * one — so their presence is probed rather than assumed.
 */
const OPTIONAL_COOKIE_COLUMNS = ["is_httponly", "samesite"] as const;

/** Which of the required + optional columns this cookie store actually has. */
function presentCookieColumns(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info('cookies')").all() as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  return [...REQUIRED_COOKIE_COLUMNS, ...OPTIONAL_COOKIE_COLUMNS].filter((c) => present.has(c));
}

/** Read all cookie rows out of a Chrome profile's Cookies DB. Copies the file first — Chrome keeps its live DB locked while running. */
export async function readCookieRows(dbPath: string): Promise<CookieRow[]> {
  const tmpPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "geode-chrome-cookies-")),
    "Cookies"
  );
  await fs.copyFile(dbPath, tmpPath);
  try {
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const stmt = db.prepare(`SELECT ${presentCookieColumns(db).join(", ")} FROM cookies`);
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

/** The SameSite policies Electron's `cookies.set` accepts (electron.d.ts, `CookiesSetDetails.sameSite`). */
export type ElectronSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/**
 * Map Chrome's integer `cookies.samesite` column onto Electron's string enum.
 * Chrome stores `net::CookieSameSite` (cookie_constants.h): `-1` UNSPECIFIED,
 * `0` NO_RESTRICTION (`SameSite=None`), `1` LAX, `2` STRICT.
 *
 * Getting this wrong is what breaks cross-site auth: a cookie that Chrome
 * holds as `SameSite=None` becomes Lax if the attribute is dropped, and
 * Chromium then refuses to send it on cross-site requests. Anything
 * unrecognized maps to `"unspecified"` so a future Chrome value degrades to
 * Chromium's own default instead of being silently coerced to something
 * stricter or looser.
 */
export function chromeSameSiteToElectron(samesite: number | bigint | null | undefined): ElectronSameSite {
  switch (Number(samesite ?? -1)) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

/**
 * Whether a Chrome `host_key` denotes a host-only cookie. Chrome marks domain
 * cookies (those that were set with a `Domain` attribute, and so apply to
 * subdomains) with a leading dot; a `host_key` without one is bound to exactly
 * that host.
 */
export function isHostOnlyCookie(hostKey: string): boolean {
  return !hostKey.startsWith(".");
}

/**
 * Convert one decrypted Chrome cookie row into Electron's `cookies.set` shape.
 *
 * Three things here are load-bearing, each of which was previously wrong:
 *
 *  1. `domain` is set ONLY for domain cookies. Chromium rejects any
 *     `__Host-`-prefixed cookie that carries a Domain attribute outright
 *     ("The cookie was set with an invalid __Host- or __Secure- prefix"), so
 *     passing `host_key` unconditionally made every `__Host-` cookie
 *     unimportable. For host-only rows the `url` binds the host instead, which
 *     also stops Electron widening `mail.google.com` into `.mail.google.com`.
 *  2. `sameSite` and `httpOnly` are carried across rather than defaulted away.
 *  3. `SameSite=None` is only legal on a Secure cookie. Rather than let
 *     Chromium reject the pair, an insecure row claiming None is demoted to
 *     `"unspecified"` — the attribute cannot be honored, so the cookie is
 *     imported under Chromium's default instead of being dropped entirely.
 *
 * `__Host-` and `__Secure-` both also require Secure, and both are Secure by
 * construction in any cookie store Chrome wrote, so the flag is asserted from
 * the prefix as well as the column. `path` is passed through unchanged:
 * `__Host-` additionally requires exactly `/`, which Chrome already enforced
 * on the way in, and inventing a different path here would silently widen the
 * cookie's scope.
 */
export function chromeCookieToSetDetails(
  row: Pick<CookieRow, "host_key" | "name" | "path" | "is_secure" | "expires_utc"> &
    Partial<Pick<CookieRow, "is_httponly" | "samesite">>,
  value: string
): Electron.CookiesSetDetails {
  const hostOnly = isHostOnlyCookie(row.host_key);
  const host = hostOnly ? row.host_key : row.host_key.slice(1);
  const cookiePath = row.path || "/";

  const prefixRequiresSecure = row.name.startsWith("__Host-") || row.name.startsWith("__Secure-");
  const secure = !!row.is_secure || prefixRequiresSecure;

  let sameSite = chromeSameSiteToElectron(row.samesite);
  if (sameSite === "no_restriction" && !secure) sameSite = "unspecified";

  const details: Electron.CookiesSetDetails = {
    url: `${secure ? "https" : "http"}://${host}${cookiePath}`,
    name: row.name,
    value,
    path: cookiePath,
    secure,
    httpOnly: !!row.is_httponly,
    sameSite,
  };
  // Domain cookies keep host_key verbatim (leading dot included); host-only
  // cookies must omit the field entirely — see (1) above.
  if (!hostOnly) details.domain = row.host_key;

  const expirationDate = chromeEpochToUnixSeconds(row.expires_utc);
  if (expirationDate !== undefined) details.expirationDate = expirationDate;

  return details;
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
  let sessionScoped = 0;

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

    const details = chromeCookieToSetDetails(row, value);
    try {
      await target.cookies.set(details);
      imported++;
      // No expirationDate means a session cookie: Electron holds it in memory
      // only, so it will not survive a restart. Counted so the UI can say so.
      if (details.expirationDate === undefined) sessionScoped++;
    } catch {
      skipped++;
    }
  }

  await target.cookies.flushStore();
  return { imported, skipped, sessionScoped };
}

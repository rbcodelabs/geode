/**
 * Pure naming policy for the iCloud sync remote folder (ADR 0030). No Node imports: this runs in the renderer
 * on every platform, and everything that touches the container goes through the bridge.
 *
 * The remote folder is a *user choice* (so a second device with a different local vault path can bind to the
 * same remote), not something derived from the local path. Resolution order at `open()`:
 *   1. the folder the user chose for this vault (device state, keyed by vault id);
 *   2. a default derived from the vault folder's basename.
 */

export const TRASH_DIR = ".geode-trash";
export const STATE_DIR = ".geode-sync";
export const MARKER_FILE = `${STATE_DIR}/marker.json`;
export const OPS_DIR = `${STATE_DIR}/ops`;
export const TMP_PREFIX = ".geode-tmp-";

const MAX_NAME = 80;
const JUNK_NAMES = new Set([".DS_Store", ".localized", "Icon\r", ".Trash", ".fseventsd", ".Spotlight-V100", ".TemporaryItems", ".DocumentRevisions-V100", ".VolumeIcon.icns"]);
const JUNK_PREFIXES = ["._", ".com.apple.", TMP_PREFIX];

export function isJunkName(name: string): boolean {
  return JUNK_NAMES.has(name) || JUNK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Names the bridge's `walk` can skip outright so junk and our own bookkeeping are never hashed. */
export const WALK_SKIP = {
  skipNames: [...JUNK_NAMES],
  skipPrefixes: JUNK_PREFIXES,
  skipTopLevel: [TRASH_DIR, STATE_DIR],
} as const;

/**
 * Make a user-supplied folder name safe: NFC, no path separators or control
 * characters, no leading dots, bounded length. Returns "" when nothing usable is left.
 */
export function sanitizeFolderName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\p{Cc}/\\:]/gu, "_")
    .trim()
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

async function sha256Prefix(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Collision-safe name derived from untrusted text (a path or vault id): if
 * sanitising altered it, a hash of the original is appended so distinct inputs
 * stay distinct. Used for derived defaults, never for names the user typed.
 */
export async function vaultFolderName(vaultId: string): Promise<string> {
  const nfc = vaultId.normalize("NFC");
  const safe = nfc.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "_").trim().slice(0, MAX_NAME);
  if (safe && safe === nfc) return safe;
  return `${safe || "vault"}-${await sha256Prefix(nfc)}`;
}

/** Default for a vault: its folder's basename, collision-safe. */
export async function defaultFolderName(vaultId: string): Promise<string> {
  const trimmed = vaultId.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop() || vaultId;
  return vaultFolderName(base);
}

/** Folder name `open()` should use for this vault. */
export async function resolveFolderName(vaultId: string, chosen?: string): Promise<string> {
  const picked = chosen ? sanitizeFolderName(chosen) : "";
  return picked || defaultFolderName(vaultId);
}

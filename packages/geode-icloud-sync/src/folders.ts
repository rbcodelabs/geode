/**
 * Remote-folder naming and selection for the iCloud provider.
 *
 * The remote folder is a *user choice* (so a second Mac with a different local
 * vault path can bind to the same remote), not something derived from the local
 * path. Resolution order at `open()`:
 *   1. the folder the user chose for this vault (plugin data, keyed by vaultId);
 *   2. the legacy path-derived name, but only if that folder already exists;
 *   3. a default derived from the vault folder's basename.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ICLOUD_DRIVE_DIR = path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
export const DEFAULT_APP_FOLDER = "Geode";
export const TRASH_DIR = ".geode-trash";
export const STATE_DIR = ".geode-sync";
export const MARKER_FILE = `${STATE_DIR}/marker.json`;
export const TMP_PREFIX = ".geode-tmp-";

const MAX_NAME = 80;
const JUNK_NAMES = new Set([".DS_Store", ".localized", "Icon\r", ".Trash", ".fseventsd", ".Spotlight-V100", ".TemporaryItems", ".DocumentRevisions-V100", ".VolumeIcon.icns"]);

export function isJunkName(name: string): boolean {
  return JUNK_NAMES.has(name) || name.startsWith("._") || name.startsWith(".com.apple.") || name.startsWith(TMP_PREFIX);
}

export interface FolderLocation {
  icloudDrive?: string;
  appFolder?: string;
}

export function foldersRoot(loc: FolderLocation): string {
  return path.join(loc.icloudDrive ?? ICLOUD_DRIVE_DIR, loc.appFolder ?? DEFAULT_APP_FOLDER);
}

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

/**
 * Collision-safe name derived from untrusted text (a path or vault id): if
 * sanitising altered it, a hash of the original is appended so distinct inputs
 * stay distinct. Used for derived defaults, never for names the user typed.
 */
export function vaultFolderName(vaultId: string): string {
  const nfc = vaultId.normalize("NFC");
  // Legacy rule, kept byte-for-byte: existing remote folders were created with it.
  const safe = nfc.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "_").trim().slice(0, MAX_NAME);
  if (safe && safe === nfc) return safe;
  return `${safe || "vault"}-${createHash("sha256").update(nfc).digest("hex").slice(0, 8)}`;
}

/** The pre-settings name: derived from the whole local vault path. */
export const legacyFolderName = vaultFolderName;

/** Default for a vault: its folder's basename, collision-safe. */
export function defaultFolderName(vaultId: string): string {
  const base = path.basename(vaultId.replace(/[/\\]+$/, "")) || vaultId;
  return vaultFolderName(base);
}

export type FolderState = "missing" | "empty" | "marked" | "unmarked";

/** `unmarked` = has user content but no `.geode-sync/marker.json`, so it is not a Geode remote. */
export async function inspectFolder(loc: FolderLocation, name: string): Promise<FolderState> {
  const dir = path.join(foldersRoot(loc), name);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (await fileExists(path.join(dir, MARKER_FILE))) return "marked";
  return entries.some((n) => !isJunkName(n) && n !== STATE_DIR) ? "unmarked" : "empty";
}

/** Existing remote folders another device could bind to (only those carrying the marker). */
export async function listRemoteFolders(loc: FolderLocation): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(foldersRoot(loc));
  } catch {
    return [];
  }
  const marked: string[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    if (await fileExists(path.join(foldersRoot(loc), name, MARKER_FILE))) marked.push(name.normalize("NFC"));
  }
  return marked;
}

/** Folder name `open()` should use for this vault. */
export async function resolveFolderName(loc: FolderLocation, vaultId: string, chosen?: string): Promise<string> {
  const picked = chosen ? sanitizeFolderName(chosen) : "";
  if (picked) return picked;
  const legacy = legacyFolderName(vaultId);
  if ((await inspectFolder(loc, legacy)) !== "missing") return legacy;
  return defaultFolderName(vaultId);
}

export type ApplyResult = { ok: true; name: string; changed: boolean } | { ok: false; reason: "active" | "invalid-name" | "not-a-geode-folder"; message: string };

export interface FolderSelectionDeps extends FolderLocation {
  vaultId: string;
  load: () => Promise<{ folders?: Record<string, string> } | null>;
  save: (data: { folders: Record<string, string> }) => Promise<void>;
  /** True while the provider is the vault's active sync transport. */
  isActive: () => boolean;
}

/** Per-vault folder choice persisted in plugin data. Backs the settings tab; no UI code here so it is testable. */
export class FolderSelection {
  constructor(private readonly deps: FolderSelectionDeps) {}

  async chosen(): Promise<string | undefined> {
    const stored = (await this.deps.load())?.folders?.[this.deps.vaultId];
    return typeof stored === "string" && stored ? stored : undefined;
  }

  effective(): Promise<string> {
    return this.chosen().then((chosen) => resolveFolderName(this.deps, this.deps.vaultId, chosen));
  }

  list(): Promise<string[]> {
    return listRemoteFolders(this.deps);
  }

  async apply(raw: string): Promise<ApplyResult> {
    if (this.deps.isActive()) {
      return { ok: false, reason: "active", message: "Disconnect iCloud sync in Settings → Sync before changing the remote folder." };
    }
    const name = sanitizeFolderName(raw);
    if (!name) return { ok: false, reason: "invalid-name", message: "Enter a folder name (no leading dots or path separators)." };
    if ((await inspectFolder(this.deps, name)) === "unmarked") {
      return { ok: false, reason: "not-a-geode-folder", message: `"${name}" already contains files that are not a Geode sync folder. Choose a different name.` };
    }
    const data = (await this.deps.load()) ?? {};
    await this.deps.save({ ...data, folders: { ...(data.folders ?? {}), [this.deps.vaultId]: name } });
    return { ok: true, name, changed: name !== raw.trim() };
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

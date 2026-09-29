import { IMAGE_EXTENSIONS, pathParent, type TFile } from "./types";

/**
 * Saving pasted and dropped images as vault attachments.
 *
 * Everything here is deliberately free of DOM and Electron types so the naming,
 * placement and collision rules can be unit-tested; the CodeMirror event
 * plumbing lives in `markdown/attachment-handlers.ts`.
 */

/** The slice of a `File` this module needs; `File` satisfies it structurally. */
export interface AttachmentSource {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The slice of `DataTransfer` this module needs. */
export interface TransferLike {
  files: ArrayLike<AttachmentSource>;
  getData(format: string): string;
}

/** The slice of `Vault` `saveImageAttachments` writes through. */
export interface AttachmentVault {
  getConfig(key: string): unknown;
  getFolderByPath(path: string): { children: { name: string }[] } | null;
  createFolder(path: string): Promise<unknown>;
  createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
}

export type AttachmentOrigin = "paste" | "drop";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? null;
}

function nameExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Obsidian's clipboard-image name: `Pasted image YYYYMMDDHHmmss.<ext>` in local time. */
export function pastedImageName(extension: string, now: Date): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}

export function isImageSource(file: AttachmentSource): boolean {
  return IMAGE_EXTENSIONS.has(nameExtension(file.name).toLowerCase()) || extensionForMime(file.type) !== null;
}

/**
 * Replace the characters that cannot appear in a vault filename or that would
 * break a `[[wikilink]]` to it (`# ^ [ ] |`), then drop leading dots so the file
 * cannot be hidden.
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim().replace(/^\.+/, "");
}

/**
 * The vault filename for an incoming image, or null when `file` is not an
 * image. The clipboard hands screenshots over as a generic `image.png`, which
 * Obsidian renames to a timestamped `Pasted image …`; files that arrive with a
 * real name (Finder copy, drag from disk) keep it.
 */
export function attachmentFileName(file: AttachmentSource, origin: AttachmentOrigin, now: Date): string | null {
  if (!isImageSource(file)) return null;
  const nameExt = nameExtension(file.name);
  const ext = IMAGE_EXTENSIONS.has(nameExt.toLowerCase()) ? nameExt : extensionForMime(file.type);
  if (!ext) return null;

  const generic = file.name.trim() === "" || /^image\.[a-z0-9]+$/i.test(file.name.trim());
  if (origin === "paste" && generic) return pastedImageName(ext, now);

  const cleaned = sanitizeFileName(file.name);
  if (!cleaned) return pastedImageName(ext, now);
  // Keep the name as given when its extension is already an image one;
  // otherwise (`photo`, `photo.pdf` carrying image bytes) trust the MIME type.
  return IMAGE_EXTENSIONS.has(nameExtension(cleaned).toLowerCase()) ? cleaned : `${cleaned}.${ext}`;
}

/**
 * Resolve Obsidian's `attachmentFolderPath` setting to a vault-relative folder
 * ("" is the vault root). `undefined` — a vault with no such setting — means
 * the root, which is Obsidian's default too. `./` and `./sub` are relative to
 * the note being edited. Anything that would escape the vault falls back to the
 * root rather than writing somewhere surprising.
 */
export function resolveAttachmentFolder(setting: unknown, sourcePath: string): string {
  if (typeof setting !== "string") return "";
  const value = setting.trim();
  if (value === "" || value === "/") return "";
  const relative = value.startsWith("./");
  const parts = (relative ? value.slice(2) : value).split("/").filter((part) => part !== "");
  if (parts.some((part) => part === ".." || part === ".")) return "";
  const base = relative ? pathParent(sourcePath) : "";
  return [base, ...parts].filter((part) => part !== "").join("/");
}

/**
 * `<folder>/<name>`, made unique by appending ` 1`, ` 2`, … to the basename
 * (Obsidian's convention). Comparison is case-insensitive because the default
 * macOS and Windows filesystems are, and a case-only difference would otherwise
 * overwrite an existing attachment.
 */
export function uniqueAttachmentPath(folder: string, name: string, existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((existing) => existing.toLowerCase()));
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 1; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}${ext}`;
  return folder ? `${folder}/${candidate}` : candidate;
}

function filesOf(transfer: TransferLike | null): AttachmentSource[] {
  return transfer ? Array.from(transfer.files) : [];
}

/**
 * Images to attach for a paste, or `[]` to leave the paste to CodeMirror.
 * Anything carrying text/plain is left alone: spreadsheets and rich-text
 * editors put a preview image on the clipboard next to the text the user
 * actually wants.
 */
export function imageFilesFromPaste(transfer: TransferLike | null): AttachmentSource[] {
  if (!transfer || transfer.getData("text/plain") !== "") return [];
  return filesOf(transfer).filter(isImageSource);
}

/** Image files in a drop, or `[]` for text and in-app drags. */
export function imageFilesFromDrop(transfer: TransferLike | null): AttachmentSource[] {
  return filesOf(transfer).filter(isImageSource);
}

/**
 * Write each image into the vault's attachment folder and return the created
 * files in order. Sequential on purpose: each file's name must be chosen after
 * the previous one exists so a batch of same-named files does not collide.
 * Rejects on the first write failure.
 */
export async function saveImageAttachments(
  vault: AttachmentVault,
  files: AttachmentSource[],
  options: { sourcePath: string; origin: AttachmentOrigin; now?: Date },
): Promise<TFile[]> {
  const now = options.now ?? new Date();
  const folder = resolveAttachmentFolder(vault.getConfig("attachmentFolderPath"), options.sourcePath);
  const saved: TFile[] = [];
  for (const file of files) {
    const name = attachmentFileName(file, options.origin, now);
    if (name === null) continue;
    if (folder && !vault.getFolderByPath(folder)) await vault.createFolder(folder);
    const existing = (vault.getFolderByPath(folder)?.children ?? []).map((child) => child.name);
    const path = uniqueAttachmentPath(folder, name, existing);
    saved.push(await vault.createBinary(path, await file.arrayBuffer()));
  }
  return saved;
}

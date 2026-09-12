/**
 * `BasesView.createFileForView` — the Bases write path's "add a note" entry
 * point, used by a view's quick-add affordance (`kanban-bases-view`'s per-column
 * `+` button) to create a note that will land in the column the user clicked.
 *
 * Composed from pieces that already exist: `patchFrontmatterText` to build the
 * YAML block, `Vault.availablePath` to avoid clobbering a note of the same
 * name, and `Vault.create` to write it. Deliberately one write, not
 * create-then-`processFrontMatter`: a two-step version can leave a half-made
 * note behind when the frontmatter step fails, and on this path that note would
 * appear on the board in the wrong column.
 */
import { patchFrontmatterText } from "../../frontmatter-io";
import { normalizePath, pathName, pathParent, type TFile, type TFolder } from "../../types";

/** The slice of `Vault` this needs — narrow so it can be driven without an `App`. */
export interface CreateFileForViewVault {
  getFolderByPath(path: string): TFolder | null;
  availablePath(folder: string, base: string, ext: string): string;
  create(path: string, data: string): Promise<TFile>;
}

/**
 * Resolve the vault path a new note should be written to.
 *
 * @throws when the name is missing, escapes the vault, or names a folder that
 * does not exist. Every one of those is a case where Geode could still write
 * *somewhere* — the vault root is always available — and writing a user's note
 * to a place they did not configure is worse than refusing. The Bases quick-add
 * caller turns the rejection into a visible notice.
 */
export function resolveNewFilePath(
  vault: CreateFileForViewVault,
  viewType: string,
  baseFileName: string | undefined
): string {
  const requested = baseFileName?.trim();
  if (!requested) {
    // Obsidian would pop its new-note menu to collect a name here. Geode has no
    // such surface for a plugin-hosted Bases view, and inventing an "Untitled"
    // would put an unnamed note on the user's board.
    throw new Error(
      `Bases view "${viewType}" called createFileForView() without a file name. Geode cannot ` +
        `prompt for one, so the view must supply the name it wants.`
    );
  }

  const normalized = normalizePath(requested);
  if (normalized === "/" || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(
      `Bases view "${viewType}" asked to create "${requested}", which does not resolve to a path inside the vault.`
    );
  }

  // Views name markdown notes; `.md` is optional in what they pass.
  const withoutExtension = normalized.replace(/\.md$/i, "");
  const folder = pathParent(withoutExtension);
  const base = pathName(withoutExtension);
  if (!base) {
    throw new Error(`Bases view "${viewType}" asked to create "${requested}", which has no file name.`);
  }
  if (folder && !vault.getFolderByPath(folder)) {
    throw new Error(
      `Bases view "${viewType}" asked to create "${requested}", but the folder "${folder}" does not exist. ` +
        `Create it first, or point the view's folder setting at one that exists.`
    );
  }

  return vault.availablePath(folder, base, "md");
}

/**
 * Build the note's initial contents.
 *
 * Runs the view's processor against an empty frontmatter object and serialises
 * the result, reusing the exact transform `FileManager.processFrontMatter` uses
 * — so a value written at creation time is spelled the same way as one written
 * by a later drag. Starting from `""` means there are no pre-existing keys to
 * preserve or lose.
 */
export function buildNewFileContents(frontmatterProcessor?: (frontmatter: any) => void): string {
  if (!frontmatterProcessor) return "";
  return patchFrontmatterText("", (frontmatter) => frontmatterProcessor(frontmatter));
}

/** Create the note. Returns it so callers can act on it; the public API returns void. */
export async function createFileForView(
  vault: CreateFileForViewVault,
  viewType: string,
  baseFileName?: string,
  frontmatterProcessor?: (frontmatter: any) => void
): Promise<TFile> {
  const path = resolveNewFilePath(vault, viewType, baseFileName);
  return vault.create(path, buildNewFileContents(frontmatterProcessor));
}

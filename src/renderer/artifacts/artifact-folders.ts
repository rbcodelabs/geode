import type { TAbstractFile, TFile, TFolder } from "../types";

/** A vault folder is an artifact when it directly contains this manifest file. */
export const ARTIFACT_MANIFEST_NAME = "artifact.json";

function isFolder(entry: TAbstractFile): entry is TFolder {
  return (entry as TFolder).kind === "folder";
}

/** True when `folder` directly contains an `artifact.json` file (not a folder of that name). */
export function isArtifactFolder(folder: TFolder): boolean {
  return folder.children.some((child) => !isFolder(child) && child.name === ARTIFACT_MANIFEST_NAME);
}

/**
 * Every artifact folder under `root`, sorted by path. Artifacts do not nest:
 * once a folder is an artifact, its subfolders are artifact assets, not
 * further artifacts.
 */
export function collectArtifactFolders(root: TFolder): TFolder[] {
  const found: TFolder[] = [];
  const visit = (folder: TFolder): void => {
    if (isArtifactFolder(folder)) {
      found.push(folder);
      return;
    }
    for (const child of folder.children) if (isFolder(child)) visit(child);
  };
  visit(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The design board a /design artifact may carry next to its manifest. */
export const ARTIFACT_BOARD_NAME = "board.canvas";

/** Files in an artifact root that stand for "the artifact itself" when picked in the explorer. */
const ARTIFACT_IDENTITY_FILES = new Set([ARTIFACT_MANIFEST_NAME, "index.html"]);

/** The `board.canvas` file directly inside an artifact folder, or null (no board, or not an artifact). */
export function findArtifactBoard(folder: TFolder): TFile | null {
  if (!isArtifactFolder(folder)) return null;
  const board = folder.children.find((child) => !isFolder(child) && child.name === ARTIFACT_BOARD_NAME);
  return (board as TFile | undefined) ?? null;
}

/**
 * Explorer-open resolution. Opening an artifact folder, its `artifact.json`
 * or its `index.html` lands on the artifact's `board.canvas` when it has one;
 * returns that board, or null to keep the file's normal open behavior.
 * `parent` is the file's containing folder (null when it is not in the tree).
 */
export function resolveArtifactBoardForFile(file: Pick<TFile, "name">, parent: TFolder | null): TFile | null {
  if (!parent || !ARTIFACT_IDENTITY_FILES.has(file.name)) return null;
  return findArtifactBoard(parent);
}

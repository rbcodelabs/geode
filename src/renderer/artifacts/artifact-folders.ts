import type { TAbstractFile, TFolder } from "../types";

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

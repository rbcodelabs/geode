import path from "node:path";
import { promises as fs } from "node:fs";

export type ArtifactPathErrorCode = "invalid_root" | "outside_root" | "missing_entry" | "entry_not_file";

export class ArtifactPathError extends Error {
  constructor(readonly code: ArtifactPathErrorCode, message: string) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

export interface ArtifactPathFs {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const defaultFs: ArtifactPathFs = {
  realpath: (target) => fs.realpath(target),
  stat: (target) => fs.stat(target),
};

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveArtifactFile(
  artifactRoot: string,
  relativePath: string,
  pathFs: ArtifactPathFs = defaultFs,
): Promise<{ root: string; file: string }> {
  let realRoot: string;
  try {
    realRoot = await pathFs.realpath(artifactRoot);
    if (!(await pathFs.stat(realRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ArtifactPathError("invalid_root", "Artifact root does not exist or is not a directory.");
  }

  const lexicalEntry = path.resolve(realRoot, relativePath);
  if (!isPathInside(realRoot, lexicalEntry)) {
    throw new ArtifactPathError("outside_root", "Artifact entry resolves outside its root.");
  }

  let realEntry: string;
  try {
    realEntry = await pathFs.realpath(lexicalEntry);
  } catch {
    throw new ArtifactPathError("missing_entry", "Artifact entry does not exist.");
  }
  if (!isPathInside(realRoot, realEntry)) {
    throw new ArtifactPathError("outside_root", "Artifact entry escapes its root through a symbolic link.");
  }
  if (!(await pathFs.stat(realEntry)).isFile()) {
    throw new ArtifactPathError("entry_not_file", "Artifact entry must be a regular file.");
  }
  return { root: realRoot, file: realEntry };
}

export async function resolveArtifactEntry(
  artifactRoot: string,
  entry: string,
  pathFs: ArtifactPathFs = defaultFs,
): Promise<{ root: string; entry: string }> {
  const resolved = await resolveArtifactFile(artifactRoot, entry, pathFs);
  return { root: resolved.root, entry: resolved.file };
}

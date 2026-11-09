import { promises as fs } from "node:fs";
import * as path from "node:path";
import { RESERVED_ARTIFACT_DIRNAME } from "../artifacts/reserved-paths";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function statIds(target: string): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    const { dev, ino } = await fs.stat(target, { bigint: true });
    return { dev, ino };
  } catch {
    return null;
  }
}

/** Layer 3: does `start` or any ancestor of it below `realRoot` have the reserved directory's identity? */
async function ancestorHasIdentity(realRoot: string, start: string, reserved: { dev: bigint; ino: bigint }): Promise<boolean> {
  let current = start;
  while (current !== realRoot && isInside(realRoot, current)) {
    const ids = await statIds(current);
    if (ids && ids.dev === reserved.dev && ids.ino === reserved.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * Layers 2 and 3 of the reserved-directory deny (ADR 0006 D7). `target` is an absolute path inside `realRoot`
 * (the realpath of the artifact root), as typed by the requester; it need not exist.
 *
 * - Realpath: the target resolves into the real path of `<root>/.threads-design` (symlink aliases).
 * - Inode: the target, or an ancestor below the root, has the same (dev, ino) as the reserved directory
 *   (case and normalization aliases on case-insensitive volumes; the JS realpath keeps the typed case on macOS).
 *
 * Residual, accepted for P1: a hard link to a file inside the directory placed elsewhere in the artifact has
 * a different path and ancestry, so neither layer sees it.
 */
export async function isReservedOnDisk(realRoot: string, target: string): Promise<boolean> {
  const reservedPath = path.join(realRoot, RESERVED_ARTIFACT_DIRNAME);
  const reservedIds = await statIds(reservedPath);
  if (!reservedIds) return false; // nothing to protect (yet); layer 1 still applies

  let reservedReal = reservedPath;
  try {
    reservedReal = await fs.realpath(reservedPath);
  } catch {
    // keep the typed path
  }

  let realTarget: string | null = null;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    // target missing: the lexical ancestor walk below still applies
  }
  if (realTarget && isInside(reservedReal, realTarget)) return true;

  if (await ancestorHasIdentity(realRoot, target, reservedIds)) return true;
  if (realTarget && (await ancestorHasIdentity(realRoot, realTarget, reservedIds))) return true;
  return false;
}

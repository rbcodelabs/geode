import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * `<vault>/.geode/policy.json` is host-owned: plugins, agents and the renderer
 * may read it but must not create, change, move or delete it, or a plugin could
 * loosen the very file that restricts it. This module is the single check the
 * main-process write handlers call (docs/adr/0051-policy-layering.md).
 *
 * What it does NOT do: stop code that already has Node access. The renderer
 * runs with `nodeIntegration: true`, so a plugin can `require("fs")` and write
 * the file directly; the ADR records that as a known, unprotectable path.
 */

export const POLICY_FILE_ERROR = "Refusing to modify .geode/policy.json: it is a host-owned policy file.";

export class HostOwnedPolicyFileError extends Error {
  readonly code = "HOST_OWNED_POLICY_FILE";
  constructor() {
    super(POLICY_FILE_ERROR);
    this.name = "HostOwnedPolicyFileError";
  }
}

/** What the caller is about to do to the target. */
export type PolicyGuardOp =
  /** Create or overwrite a file at the target. */
  | "write"
  /** Create a directory at the target. */
  | "mkdir"
  /** Delete, trash or recursively remove the target (and everything under it). */
  | "remove"
  /** Move the target away. */
  | "rename-from"
  /** Move something onto the target. */
  | "rename-to";

const MAX_SYMLINK_HOPS = 40;

/**
 * Fold one path segment the way a hostile writer could exploit: case
 * (case-insensitive APFS/NTFS), compatibility forms (NFKC), and Windows'
 * silent stripping of trailing dots/spaces and `:stream` suffixes. Folding is
 * deliberately over-broad: on a case-sensitive Linux disk it also refuses
 * `.GEODE/POLICY.JSON`, which Geode never reads. Refusing a name nobody
 * legitimately writes is cheap; missing an alias is not.
 */
export function foldPolicySegment(segment: string): string {
  const noStream = segment.split(":")[0];
  return noStream.normalize("NFKC").toLowerCase().replace(/[. ]+$/, "");
}

function foldPath(p: string): string {
  return p.split(/[\\/]+/).map(foldPolicySegment).join("/");
}

/**
 * Resolve symlinks for a path that may not exist yet: realpath the deepest
 * existing ancestor, follow a dangling final symlink by hand, and append the
 * rest. Follows what a write to `p` would really touch.
 */
async function canonicalize(p: string, hops = 0): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) return p;
  try {
    return await fsp.realpath(p);
  } catch {
    // Fall through: the path (or some ancestor) does not exist.
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) {
      const link = await fsp.readlink(p);
      return canonicalize(path.resolve(parent, link), hops + 1);
    }
  } catch {
    // Nothing at p; resolve the parent and re-append the name.
  }
  return path.join(await canonicalize(parent, hops + 1), path.basename(p));
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a, { bigint: true }), fsp.stat(b, { bigint: true })]);
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/**
 * Throw `HostOwnedPolicyFileError` if `op` on `target` (an absolute path inside
 * the vault at `root`) would create, change, replace or remove
 * `<root>/.geode/policy.json`. Catches, in addition to the plain path:
 *  - case-insensitive aliases, `..`, trailing dots/spaces, `:stream` suffixes
 *    (lexical folding of the canonical path);
 *  - symlinks anywhere on the path, including a symlinked `.geode` or a
 *    symlink whose target is the policy file (canonicalization);
 *  - hard links and 8.3 short names of an existing policy file (same dev+ino);
 *  - removing or replacing `.geode` itself while it contains a policy file.
 */
export async function assertNotPolicyFile(root: string, target: string, op: PolicyGuardOp): Promise<void> {
  const policyAbs = path.join(root, ".geode", "policy.json");
  const [canonTarget, canonPolicy] = await Promise.all([
    canonicalize(path.resolve(root, target)),
    canonicalize(policyAbs),
  ]);
  const policyDir = path.dirname(canonPolicy);
  const t = foldPath(canonTarget);
  const p = foldPath(canonPolicy);
  const d = foldPath(policyDir);

  const isPolicy = t === p;
  // Destructive ops on an ancestor take the policy file with them (or, for
  // rename-to, replace the directory that holds it).
  const isAncestorOfPolicy = p.startsWith(t + "/");
  // `.geode` (the policy dir) itself, even if the policy file does not exist yet.
  const isPolicyDir = t === d;

  let hit = isPolicy;
  if (op === "remove" || op === "rename-from") {
    if (isAncestorOfPolicy) hit = hit || (await fileExists(canonPolicy));
  } else if (op === "rename-to") {
    // Moving a directory onto `.geode` would forge a policy tree.
    hit = hit || isPolicyDir;
  }
  if (!hit && !isAncestorOfPolicy) {
    // Aliases the string compare cannot see (hard link, short name) exist only
    // when the policy file does, so compare identity.
    hit = await sameFile(canonTarget, canonPolicy);
  }
  if (hit) throw new HostOwnedPolicyFileError();
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

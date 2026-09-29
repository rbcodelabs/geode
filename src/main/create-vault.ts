/**
 * Creates a brand-new, empty vault folder for the picker's "Create new vault"
 * flow. Kept free of Electron imports so it is unit-testable; main.ts wires it
 * to the `create-vault` IPC handler. The renderer validates too, but only this
 * module's checks are authoritative.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { vaultNameMessage, vaultNameProblem } from "../shared/vault-name";

export async function createVaultFolder(parent: unknown, name: unknown): Promise<string> {
  if (typeof parent !== "string" || typeof name !== "string") throw new Error("Invalid vault location or name");
  const problem = vaultNameProblem(name);
  if (problem) throw new Error(vaultNameMessage(problem));
  if (!parent || !path.isAbsolute(parent)) throw new Error("Choose a location for the vault.");
  const parentDir = path.resolve(parent);
  const parentStat = await fsp.stat(parentDir).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error(`"${parentDir}" is not a folder`);
  const folderName = name.trim();
  const target = path.join(parentDir, folderName);
  // Defence in depth: the name check already rejects separators, but never
  // create anything that doesn't resolve to a direct child of the parent.
  if (path.dirname(target) !== parentDir) throw new Error("Invalid vault name");
  try {
    // Non-recursive: an existing folder must error rather than be reused.
    await fsp.mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A folder named ${folderName} already exists in ${parentDir}`);
    }
    throw error;
  }
  return target;
}

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Injectable filesystem seam so tests (and hosts) can simulate cross-device moves. */
export interface TrashIo { rename?(from: string, to: string): Promise<void>; }

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function mkdirDurable(directory: string): Promise<void> {
  const missing: string[] = []; let current = directory;
  while (true) {
    const stat = await fs.stat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat) { if (!stat.isDirectory()) throw new Error("Trash parent is not a directory"); break; }
    missing.push(current); const parent = path.dirname(current); if (parent === current) throw new Error("Missing filesystem root"); current = parent;
  }
  for (const entry of missing.reverse()) {
    await fs.mkdir(entry, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await syncDirectory(path.dirname(entry));
  }
}

/**
 * Moves `<vaultRoot>/<relPath>` to `<trashDir>/<opId>/<relPath>`. Uses rename;
 * on EXDEV (trash on another volume) copies, fsyncs the copy and its directory,
 * then unlinks the source, so the bytes are durable in the trash before the
 * vault copy disappears. Returns the destination path.
 */
export async function moveToTrash(vaultRoot: string, relPath: string, trashDir: string, opId: string, io: TrashIo = {}): Promise<string> {
  if (!path.isAbsolute(trashDir)) throw new Error("trashDir must be absolute");
  if (!/^[0-9a-f-]{36}$/i.test(opId)) throw new Error("Invalid sync operation identity");
  if (!relPath || relPath.split("/").some(segment => !segment || segment === "." || segment === "..") || relPath.includes("\\") || relPath.includes("\0")) throw new Error("Unsafe trash path");
  const root = path.resolve(vaultRoot), trash = path.resolve(trashDir);
  if (trash === root || trash.startsWith(root + path.sep) || root.startsWith(trash + path.sep)) throw new Error("trashDir must be outside the vault");
  const source = path.resolve(root, relPath);
  if (!source.startsWith(root + path.sep)) throw new Error("Unsafe trash path");
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error("Sync cannot trash symbolic links");
  const destination = path.join(trash, opId, relPath);
  await mkdirDurable(path.dirname(destination));
  const rename = io.rename ?? fs.rename;
  try { await rename(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    if (stat.isDirectory()) { await fs.mkdir(destination, { recursive: true }); await fs.rmdir(source); }
    else if (stat.isFile()) {
      const partial = destination + ".partial-" + opId;
      await fs.copyFile(source, partial);
      const file = await fs.open(partial, "r+"); try { await file.sync(); } finally { await file.close(); }
      await fs.rename(partial, destination);
      await fs.unlink(source);
    } else throw new Error("Unsupported file type for trash");
  }
  await syncDirectory(path.dirname(destination));
  await syncDirectory(path.dirname(source));
  return destination;
}

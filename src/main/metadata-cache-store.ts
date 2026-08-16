import * as path from "node:path";
import * as fsp from "node:fs/promises";

export const METADATA_CACHE_RELATIVE_PATH = path.join(".geode", "metadata-cache", "cache.json");

/** Read the renderer metadata cache. Missing/unreadable data is a cache miss. */
export async function readMetadataCache(root: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, METADATA_CACHE_RELATIVE_PATH), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Replace the cache atomically. The temporary file lives beside the target,
 * ensuring rename is a same-volume atomic operation on every supported OS.
 */
type CacheFileOps = Pick<typeof fsp, "mkdir" | "writeFile" | "rename" | "rm">;

export async function writeMetadataCache(
  root: string,
  data: unknown,
  fileOps: CacheFileOps = fsp
): Promise<void> {
  const target = path.join(root, METADATA_CACHE_RELATIVE_PATH);
  const dir = path.dirname(target);
  await fileOps.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.cache.${process.pid}.${Date.now()}.tmp`);
  try {
    await fileOps.writeFile(temporary, JSON.stringify(data), "utf8");
    await fileOps.rename(temporary, target);
  } catch (error) {
    await fileOps.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

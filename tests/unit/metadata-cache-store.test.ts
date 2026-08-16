import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  METADATA_CACHE_RELATIVE_PATH,
  readMetadataCache,
  writeMetadataCache,
} from "../../src/main/metadata-cache-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("metadata cache store", () => {
  it("round-trips JSON and atomically renames a same-directory temporary file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-metadata-cache-"));
    roots.push(root);
    const rename = vi.fn(fsp.rename);
    await writeMetadataCache(root, { schemaVersion: 1, entries: {} }, { ...fsp, rename });

    expect(rename).toHaveBeenCalledOnce();
    const [temporary, target] = rename.mock.calls[0];
    expect(path.dirname(temporary as string)).toBe(path.dirname(target as string));
    expect(target).toBe(path.join(root, METADATA_CACHE_RELATIVE_PATH));
    await expect(readMetadataCache(root)).resolves.toEqual({ schemaVersion: 1, entries: {} });
    expect((await fsp.readdir(path.dirname(target as string))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("treats missing and corrupt files as cache misses", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-metadata-cache-"));
    roots.push(root);
    await expect(readMetadataCache(root)).resolves.toBeNull();
    const target = path.join(root, METADATA_CACHE_RELATIVE_PATH);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "not json");
    await expect(readMetadataCache(root)).resolves.toBeNull();
  });
});

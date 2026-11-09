import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isReservedOnDisk } from "../../src/main/artifact-reserved-dir";

type Ids = { dev: bigint; ino: bigint };
// Every path is built with node:path exactly as the module builds its own (on Windows: D:\art\.threads-design),
// so the fake fs keys match on every platform. Hard-coded POSIX strings never matched on win32.
const root = path.resolve(path.sep, "art");
const p = (...segments: string[]) => path.join(root, ...segments);

/** A fake fs: `ids` maps an absolute path to its (dev, ino); realpath is the identity unless remapped. */
const fakeFs = (ids: Array<[string, Ids]>, real: Array<[string, string]> = []) => {
  const idMap = new Map(ids);
  const realMap = new Map(real);
  return {
    stat: async (target: string) => { const v = idMap.get(target); if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    realpath: async (target: string) => realMap.get(target) ?? target,
  };
};

describe("isReservedOnDisk inode layer (review A12)", () => {
  it("denies a case alias that shares the reserved directory's (dev, ino)", async () => {
    const fs = fakeFs([
      [p(".threads-design"), { dev: 1n, ino: 42n }],
      [p(".Threads-Design"), { dev: 1n, ino: 42n }],
      [p(".Threads-Design", "c.json"), { dev: 1n, ino: 77n }],
    ]);
    expect(await isReservedOnDisk(root, p(".Threads-Design", "c.json"), fs)).toBe(true);
  });

  it("does not deny anything when the filesystem reports inode 0 for every file (FAT, SMB, some FUSE, odd NTFS/ReFS)", async () => {
    const zero = { dev: 1n, ino: 0n };
    const fs = fakeFs([[p(".threads-design"), zero], [p("index.html"), zero], [p("sub"), zero], [p("sub", "app.js"), zero]]);
    expect(await isReservedOnDisk(root, p("index.html"), fs)).toBe(false);
    expect(await isReservedOnDisk(root, p("sub", "app.js"), fs)).toBe(false);
  });

  it("still denies a symlink alias through the realpath layer when inodes are unreliable", async () => {
    const zero = { dev: 1n, ino: 0n };
    const fs = fakeFs(
      [[p(".threads-design"), zero], [p("link"), zero], [p("link", "c.json"), zero]],
      [[p("link", "c.json"), p(".threads-design", "c.json")]],
    );
    expect(await isReservedOnDisk(root, p("link", "c.json"), fs)).toBe(true);
  });

  it("does not deny an unrelated file whose inode differs", async () => {
    const fs = fakeFs([[p(".threads-design"), { dev: 1n, ino: 42n }], [p("index.html"), { dev: 1n, ino: 43n }]]);
    expect(await isReservedOnDisk(root, p("index.html"), fs)).toBe(false);
  });
});

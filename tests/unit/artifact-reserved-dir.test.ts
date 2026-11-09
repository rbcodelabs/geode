import { describe, expect, it } from "vitest";
import { isReservedOnDisk } from "../../src/main/artifact-reserved-dir";

type Ids = { dev: bigint; ino: bigint };
/** A fake fs: `ids` maps an absolute path to its (dev, ino); realpath is the identity unless remapped. */
const fakeFs = (ids: Record<string, Ids>, real: Record<string, string> = {}) => ({
  stat: async (p: string) => { const v = ids[p]; if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
  realpath: async (p: string) => real[p] ?? p,
});

describe("isReservedOnDisk inode layer (review A12)", () => {
  const root = "/art";
  it("denies a case alias that shares the reserved directory's (dev, ino)", async () => {
    const fs = fakeFs({ "/art/.threads-design": { dev: 1n, ino: 42n }, "/art/.Threads-Design": { dev: 1n, ino: 42n }, "/art/.Threads-Design/c.json": { dev: 1n, ino: 77n } });
    expect(await isReservedOnDisk(root, "/art/.Threads-Design/c.json", fs)).toBe(true);
  });

  it("does not deny anything when the filesystem reports inode 0 for every file (FAT, SMB, some FUSE)", async () => {
    const zero = { dev: 1n, ino: 0n };
    const fs = fakeFs({ "/art/.threads-design": zero, "/art/index.html": zero, "/art/sub": zero, "/art/sub/app.js": zero });
    expect(await isReservedOnDisk(root, "/art/index.html", fs)).toBe(false);
    expect(await isReservedOnDisk(root, "/art/sub/app.js", fs)).toBe(false);
  });

  it("still denies a symlink alias through the realpath layer when inodes are unreliable", async () => {
    const zero = { dev: 1n, ino: 0n };
    const fs = fakeFs(
      { "/art/.threads-design": zero, "/art/link": zero, "/art/link/c.json": zero },
      { "/art/link/c.json": "/art/.threads-design/c.json" },
    );
    expect(await isReservedOnDisk(root, "/art/link/c.json", fs)).toBe(true);
  });

  it("does not deny an unrelated file whose inode differs", async () => {
    const fs = fakeFs({ "/art/.threads-design": { dev: 1n, ino: 42n }, "/art/index.html": { dev: 1n, ino: 43n } });
    expect(await isReservedOnDisk(root, "/art/index.html", fs)).toBe(false);
  });
});

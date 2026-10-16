import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readAuthorizedImage, imageReadIo, type ImageReadIo, type ImageFileHandle } from "../../src/main/image-resource";
import { ImageCleanupUncertainError } from "../../src/shared/image-cleanup";

/** Header-family vectors only. These deliberately do not establish native decode validity. */
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex");
const jpeg = Buffer.from("ffd8ffe00010", "hex");
const gif = Buffer.from("47494638396101000100000000", "hex");
const webp = Buffer.from("5249464612000000574542505650384c050000002f0000000000", "hex");
const bmp = Buffer.from("424d1a000000000000001a0000000c0000000100010001001800", "hex");
const avif = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
const vectors = [
  ["Photo.png", "image/png", png], ["Photo.JPEG", "image/jpeg", jpeg], ["Photo.gif", "image/gif", gif],
  ["Photo.webp", "image/webp", webp], ["Photo.bmp", "image/bmp", bmp], ["Photo.avif", "image/avif", avif],
] as const;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geode-image-reader-")); directories.push(directory);
  const root = path.join(directory, "vault"); await fs.mkdir(root); await fs.writeFile(path.join(root, "Photo.png"), png);
  await fs.writeFile(path.join(directory, "Outside.png"), png);
  return { root, directory, request: { root, expectedRoot: root, path: "Photo.png", current: () => true } };
}
for (const [name, mime, bytes] of vectors) it(`admits the exact bounded ${mime} header-family bytes without claiming decode`, async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.root, name), bytes);
  const before = createHash("sha256").update(bytes).digest("hex");
  const result = await readAuthorizedImage({ ...f.request, path: name });
  expect(result.mime).toBe(mime); expect(Buffer.from(result.bytes)).toEqual(bytes);
  expect(createHash("sha256").update(await fs.readFile(path.join(f.root, name))).digest("hex")).toBe(before);
});
for (const relative of ["./Photo.png", "../Outside.png", "", "/Photo.png", "a/../Photo.png", "a//Photo.png", "Photo.png/", "Photo.png\\", "https://example.invalid/Photo.png"]) {
  it(`refuses lexical image path ${relative}`, async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, "a")); await fs.writeFile(path.join(f.root, "a", "Photo.png"), png);
    await expect(readAuthorizedImage({ ...f.request, path: relative })).rejects.toThrow();
  });
}
it("refuses a same-root request whose main authority is no longer current", async () => {
  const f = await fixture(); await expect(readAuthorizedImage({ ...f.request, current: () => false })).rejects.toThrow();
});
it("refuses mismatched captured root authority", async () => {
  const f = await fixture(); await expect(readAuthorizedImage({ ...f.request, expectedRoot: f.directory })).rejects.toThrow();
});
it("refuses a symlink escaping the canonical root despite valid raster bytes", async () => {
  const f = await fixture(); await fs.symlink(path.join(f.directory, "Outside.png"), path.join(f.root, "Link.png"));
  await expect(readAuthorizedImage({ ...f.request, path: "Link.png" })).rejects.toThrow();
});
for (const limit of [1, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 32 * 1024 * 1024 + 1]) it(`refuses invalid or insufficient lower byte limit ${limit}`, async () => {
  const f = await fixture(); await expect(readAuthorizedImage({ ...f.request, limit })).rejects.toThrow();
});
it("does not admit SVG markup disguised by a supported extension", async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.root, "Photo.png"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  await expect(readAuthorizedImage(f.request)).rejects.toThrow();
});
it("rejects an extension/header-family mismatch", async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.root, "Photo.png"), jpeg);
  await expect(readAuthorizedImage(f.request)).rejects.toThrow();
});
it("refuses an AVIF declared box beyond its bounded bytes", async () => {
  const f = await fixture(); const bytes = Buffer.from(avif); bytes.writeUInt32BE(4096, 0); await fs.writeFile(path.join(f.root, "Photo.avif"), bytes);
  await expect(readAuthorizedImage({ ...f.request, path: "Photo.avif" })).rejects.toThrow();
});
it("refuses an arbitrary ISO-BMFF video brand with no explicit AVIF brand", async () => {
  const f = await fixture(); const bytes = Buffer.from(avif); bytes.write("mp42", 8); bytes.write("isom", 16); await fs.writeFile(path.join(f.root, "Photo.avif"), bytes);
  await expect(readAuthorizedImage({ ...f.request, path: "Photo.avif" })).rejects.toThrow();
});
it("refuses an AVIF extended box size beyond safe/bounded input", async () => {
  const f = await fixture(); const bytes = Buffer.alloc(32); bytes.writeUInt32BE(1); bytes.write("ftyp", 4); bytes.writeBigUInt64BE(2n ** 60n, 8); bytes.write("avif", 16); bytes.write("avif", 24);
  await fs.writeFile(path.join(f.root, "Photo.avif"), bytes);
  await expect(readAuthorizedImage({ ...f.request, path: "Photo.avif" })).rejects.toThrow();
});
it("refuses a truncated AVIF compatible brand table", async () => {
  const f = await fixture(); const bytes = Buffer.from(avif.subarray(0, 23)); bytes.writeUInt32BE(23); bytes.write("mif1", 8);
  await fs.writeFile(path.join(f.root, "Photo.avif"), bytes);
  await expect(readAuthorizedImage({ ...f.request, path: "Photo.avif" })).rejects.toThrow();
});
it.each(["riff", "chunk"])("refuses WebP %s length outside the actual byte boundary", async field => {
  const f = await fixture(); const bytes = Buffer.from(webp); bytes.writeUInt32LE(0xffffffff, field === "riff" ? 4 : 16);
  await fs.writeFile(path.join(f.root, "Photo.webp"), bytes);
  await expect(readAuthorizedImage({ ...f.request, path: "Photo.webp" })).rejects.toThrow();
});
function instrument(after: (stage: string) => Promise<void> | void = () => {}) {
  const handles: ImageFileHandle[] = [];
  const close = vi.fn(async (handle: ImageFileHandle) => { await handle.close(); await after("close"); });
  const reads: { length: number; position: number }[] = [];
  const io: ImageReadIo = {
    realpath: async value => { const result = await imageReadIo.realpath(value); await after("realpath"); return result; },
    stat: async value => { const result = await imageReadIo.stat(value); await after("path-stat"); return result; },
    open: async (value, flags) => {
      const handle = await imageReadIo.open(value, flags); handles.push(handle); await after("open");
      return {
        stat: async () => { const result = await handle.stat(); await after("handle-stat"); return result; },
        read: async (bytes, offset, length, position) => { reads.push({ length, position }); const result = await handle.read(bytes, offset, length, position); await after("read"); return result; },
        close: () => close(handle),
      };
    },
    allocate: vi.fn(size => new Uint8Array(size)),
  };
  return { io, close, reads, cleanup: async () => { await Promise.allSettled(handles.map(handle => handle.close())); } };
}
for (const stage of ["realpath", "path-stat", "open", "handle-stat", "read", "close"]) it(`checks live authority after actual awaited ${stage}`, async () => {
  const f = await fixture(); let current = true, entered = 0;
  const probe = instrument(async point => { if (point === stage) { entered++; current = false; } });
  try {
    await expect(readAuthorizedImage({ ...f.request, current: () => current }, probe.io)).rejects.toThrow();
    expect(entered).toBeGreaterThan(0);
  } finally { await probe.cleanup(); }
});
it.each(["replace", "truncate", "grow", "same-size"])("refuses actual target %s during an awaited read", async mutation => {
  const f = await fixture(); let changed = false;
  const target = path.join(f.root, "Photo.png");
  const probe = instrument(async stage => {
    if (stage !== "read" || changed) return; changed = true;
    if (mutation === "replace") { await fs.rename(target, target + ".old"); await fs.writeFile(target, png); }
    if (mutation === "truncate") await fs.truncate(target, 1);
    if (mutation === "grow") await fs.appendFile(target, Buffer.from([0]));
    if (mutation === "same-size") { await fs.writeFile(target, Buffer.alloc(png.length)); await fs.utimes(target, new Date(), new Date(Date.now() + 2000)); }
  });
  try {
    await expect(readAuthorizedImage(f.request, probe.io)).rejects.toThrow();
    expect(changed).toBe(true); expect(probe.close).toHaveBeenCalledOnce();
  } finally { await probe.cleanup(); }
});
it("refuses canonical root replacement while the open inode remains reachable through a hard link", async () => {
  const f = await fixture(); let changed = false;
  const probe = instrument(async stage => {
    if (stage !== "open" || changed) return; changed = true;
    const old = f.root + "-old"; await fs.rename(f.root, old); await fs.mkdir(f.root);
    await fs.link(path.join(old, "Photo.png"), path.join(f.root, "Photo.png"));
  });
  try { await expect(readAuthorizedImage(f.request, probe.io)).rejects.toThrow(); expect(changed).toBe(true); }
  finally { await probe.cleanup(); }
});
it("preserves both primary read and actual close errors, closing the owned handle once", async () => {
  const f = await fixture(), primary = new Error("read failed"), cleanup = new Error("close failed");
  const probe = instrument(); const open = probe.io.open;
  probe.io.open = async (...args) => {
    const handle = await open(...args);
    return { stat: () => handle.stat(), read: async () => { throw primary; }, close: vi.fn(async () => { await handle.close(); throw cleanup; }) };
  };
  try { await expect(readAuthorizedImage(f.request, probe.io)).rejects.toMatchObject({ errors: [primary, cleanup] }); expect(probe.close).toHaveBeenCalledOnce(); }
  finally { await probe.cleanup(); }
});
it("never requests more than64KiB per chunk and preserves the complete bounded bytes", async () => {
  const f = await fixture(); const bytes = Buffer.alloc(128 * 1024); png.copy(bytes); await fs.writeFile(path.join(f.root, "Photo.png"), bytes);
  const probe = instrument();
  try {
    const result = await readAuthorizedImage(f.request, probe.io); expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(probe.reads.every(row => row.length <= 65536)).toBe(true);
    expect(probe.reads.reduce((sum, row) => sum + row.length, 0)).toBeLessThanOrEqual(bytes.length + 1);
  } finally { await probe.cleanup(); }
});
it("rejects an oversized observed file before output allocation", async () => {
  const f = await fixture(); const probe = instrument();
  const stat = probe.io.stat;
  probe.io.stat = async value => Object.assign(await stat(value), { size: 32 * 1024 * 1024 + 1 });
  probe.io.allocate = vi.fn(() => { throw new Error("forbidden oversized allocation"); });
  try { await expect(readAuthorizedImage(f.request, probe.io)).rejects.toThrow(); expect(probe.io.allocate).not.toHaveBeenCalled(); }
  finally { await probe.cleanup(); }
});
it("admits exactly32MiB with a separate overflow probe and no cap+1 allocation", async () => {
  const f = await fixture(), size = 32 * 1024 * 1024;
  const handle = await fs.open(path.join(f.root, "Photo.png"), "r+");
  await handle.truncate(size); await handle.close();
  const probe = instrument();
  try {
    const result = await readAuthorizedImage(f.request, probe.io);
    expect(result.bytes.byteLength).toBe(size);
    expect(Buffer.from(result.bytes).subarray(0, png.length)).toEqual(png);
    expect(probe.io.allocate).toHaveBeenNthCalledWith(1, size);
    expect(probe.io.allocate).toHaveBeenNthCalledWith(2, 1);
    expect(probe.io.allocate).toHaveBeenCalledTimes(2);
    expect(probe.reads).toHaveLength(size / 65536 + 1);
    expect(probe.reads.at(-1)).toEqual({ length: 1, position: size });
    expect(probe.reads.every(row => row.length <= 65536)).toBe(true);
    expect(probe.close).toHaveBeenCalledOnce();
  } finally { await probe.cleanup(); }
});
it("refuses an actual cap+1 file before opening or allocating", async () => {
  const f = await fixture();
  const handle = await fs.open(path.join(f.root, "Photo.png"), "r+");
  await handle.truncate(32 * 1024 * 1024 + 1); await handle.close();
  const probe = instrument(); probe.io.open = vi.fn(probe.io.open);
  await expect(readAuthorizedImage(f.request, probe.io)).rejects.toThrow();
  expect(probe.io.open).not.toHaveBeenCalled(); expect(probe.io.allocate).not.toHaveBeenCalled();
});
it("retains a close-only failure instead of publishing successful bytes", async () => {
  const f = await fixture(), cleanup = new Error("actual handle closed but cleanup rejected");
  const probe = instrument(), open = probe.io.open;
  probe.io.open = async (...args) => {
    const handle = await open(...args);
    return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs), close: async () => { await handle.close(); throw cleanup; } };
  };
  try {
    const error = await readAuthorizedImage(f.request, probe.io).catch(error => error);
    expect(error).toBeInstanceOf(ImageCleanupUncertainError); expect(error.errors).toEqual([cleanup]);
    expect(probe.close).toHaveBeenCalledOnce();
  }
  finally { await probe.cleanup(); }
});
it("refuses an internal directory and a file used as its root without allocation", async () => {
  const f = await fixture(); await fs.mkdir(path.join(f.root, "Directory.png"));
  const probe = instrument();
  await expect(readAuthorizedImage({ ...f.request, path: "Directory.png" }, probe.io)).rejects.toThrow();
  const root = path.join(f.root, "Photo.png");
  await expect(readAuthorizedImage({ ...f.request, root, expectedRoot: root }, probe.io)).rejects.toThrow();
  expect(probe.io.allocate).not.toHaveBeenCalled();
});
it.each(["root", "target", "same-size"])("refuses actual %s replacement while final handle close is awaited", async mutation => {
  const f = await fixture(); let changed = false;
  const probe = instrument(async stage => {
    if (stage !== "close" || changed) return; changed = true;
    const target = path.join(f.root, "Photo.png");
    if (mutation === "root") {
      const old = f.root + "-old"; await fs.rename(f.root, old); await fs.mkdir(f.root);
      await fs.link(path.join(old, "Photo.png"), target);
    } else if (mutation === "target") {
      await fs.rename(target, target + ".old"); await fs.writeFile(target, png);
    } else {
      await fs.writeFile(target, Buffer.alloc(png.length)); await fs.utimes(target, new Date(), new Date(Date.now() + 2000));
    }
  });
  try {
    await expect(readAuthorizedImage(f.request, probe.io)).rejects.toThrow();
    expect(changed).toBe(true); expect(probe.close).toHaveBeenCalledOnce();
  } finally { await probe.cleanup(); }
});

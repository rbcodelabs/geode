import { expect, it, vi } from "vitest";
import { fsyncDirectory } from "../../src/shared/fsync-directory";

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
const handleFailingSync = (code: string) => {
  const handle = { sync: vi.fn(async () => { throw errno(code); }), close: vi.fn(async () => {}) };
  return { handle, open: vi.fn(async () => handle) };
};

it("flushes a directory handle and closes it", async () => {
  const handle = { sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const open = vi.fn(async () => handle);
  await fsyncDirectory("/vault/.geode", { open, platform: "linux" });
  expect(open).toHaveBeenCalledWith("/vault/.geode", "r");
  expect(handle.sync).toHaveBeenCalledOnce();
  expect(handle.close).toHaveBeenCalledOnce();
});

it("treats Windows' EPERM on directory fsync as already durable, and still closes the handle", async () => {
  const { handle, open } = handleFailingSync("EPERM");
  await expect(fsyncDirectory("C:\\vault\\.geode", { open, platform: "win32" })).resolves.toBeUndefined();
  expect(handle.close).toHaveBeenCalledOnce();
});

it("tolerates Windows refusing to open a directory at all", async () => {
  for (const code of ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"]) {
    const open = vi.fn(async () => { throw errno(code); });
    await expect(fsyncDirectory("C:\\vault", { open, platform: "win32" })).resolves.toBeUndefined();
  }
});

it("does not swallow genuine I/O errors on Windows", async () => {
  const { handle, open } = handleFailingSync("EIO");
  await expect(fsyncDirectory("C:\\vault", { open, platform: "win32" })).rejects.toMatchObject({ code: "EIO" });
  expect(handle.close).toHaveBeenCalledOnce();
});

it("keeps failing loudly on POSIX platforms, where directory fsync must work", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const { open } = handleFailingSync("EPERM");
    await expect(fsyncDirectory("/vault", { open, platform })).rejects.toMatchObject({ code: "EPERM" });
  }
});

it("propagates ENOENT so callers can decide whether a missing directory is acceptable", async () => {
  const open = vi.fn(async () => { throw errno("ENOENT"); });
  await expect(fsyncDirectory("/missing", { open, platform: "win32" })).rejects.toMatchObject({ code: "ENOENT" });
});

import { expect, it, vi } from "vitest";
import { registerImageReadIpc, type ImageReadAuthority, type ImageReadEvent, type ImageReaderRequest, type ImageReadResult } from "../../src/main/image-ipc";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAuthorizedImage, imageReadIo } from "../../src/main/image-resource";
import { ImageCleanupUncertainError } from "../../src/shared/image-cleanup";

// Phase1 exercises the original request shape so version admission cannot mask
// the completion race. The R2 envelope migration must retain every oracle.
const id = "a".repeat(64), root = "/synthetic";
const bytes = () => ({ bytes: new ArrayBuffer(8), mime: "image/png" as const });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(rootValue = root) {
  const handlers = new Map<string, (event: ImageReadEvent, request: unknown) => Promise<unknown>>();
  const frame = {}, window = {}, identity = {};
  const event: ImageReadEvent = { sender: { isDestroyed: () => false, mainFrame: frame }, senderFrame: frame };
  const authority: ImageReadAuthority = { window, frame, identity, root: rootValue, current: () => true };
  const read = vi.fn(async (_request: ImageReaderRequest): Promise<ImageReadResult> => bytes());
  const stop = registerImageReadIpc({ handle: (channel, callback) => { handlers.set(channel, callback); },
    removeHandler: channel => { handlers.delete(channel); } }, () => authority, read);
  const call = (nextId = id) => handlers.get("image-resources-read")!(event, { root: rootValue, path: "Photo.png", id: nextId });
  const cancel = (nextId = id) => handlers.get("image-resources-cancel")!(event, { root: rootValue, id: nextId });
  return { read, call, cancel, stop, authority, event };
}
it("retains completed read admission until its owner explicitly finishes", async () => {
  const f = fixture();
  try {
    await f.call();
    await expect(f.call("b".repeat(64))).rejects.toThrow(/receipt|busy/i);
    expect(f.read).toHaveBeenCalledOnce();
  } finally { await f.stop(); }
});
it("recognizes exact cancellation arriving after read completion as completed", async () => {
  const f = fixture();
  try {
    await f.call();
    await expect(f.cancel()).resolves.toMatchObject({ kind: "retired", outcome: "completed" });
    expect(f.read).toHaveBeenCalledOnce();
  } finally { await f.stop(); }
});
it("waits for an actual held read before acknowledging accepted cancellation", async () => {
  const f = fixture(), gate = deferred<ImageReadResult>();
  f.read.mockImplementation(() => gate.promise);
  const pending = f.call(); void pending.catch(() => {});
  let acknowledged = false;
  const cancel = f.cancel().then(value => { acknowledged = true; return value; }); void cancel.catch(() => {});
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(f.read.mock.calls[0][0].current()).toBe(false);
    expect(acknowledged).toBe(false);
    gate.resolve(bytes());
    await pending.catch(() => {});
    await expect(cancel).resolves.toMatchObject({ kind: "retired", outcome: "cancelled" });
  } finally { gate.resolve(bytes()); await Promise.allSettled([pending, cancel]); await f.stop(); }
});
it("keeps a clean failed read receipt until explicit consumption", async () => {
  const f = fixture(); f.read.mockRejectedValueOnce(new Error("synthetic read failure"));
  try {
    await expect(f.call()).rejects.toThrow("synthetic read failure");
    await expect(f.call("b".repeat(64))).rejects.toThrow(/receipt|busy/i);
    expect(f.read).toHaveBeenCalledOnce();
  } finally { await f.stop(); }
});
it("keeps exact completed cancellation outcome stable across duplicate calls", async () => {
  const f = fixture();
  try {
    await f.call();
    const [first, second] = await Promise.all([f.cancel(), f.cancel()]);
    expect(first).toMatchObject({ kind: "retired", outcome: "completed" });
    expect(second).toEqual(first);
  } finally { await f.stop(); }
});
it("keeps the original currentness guard during a held cancellation", async () => {
  const f = fixture(), gate = deferred<ImageReadResult>();
  f.read.mockImplementation(() => gate.promise);
  const pending = f.call(); void pending.catch(() => {});
  try {
    f.authority.identity = {};
    expect(f.read.mock.calls[0][0].current()).toBe(false);
    gate.resolve(bytes()); await expect(pending).rejects.toThrow();
  } finally { gate.resolve(bytes()); await pending.catch(() => {}); await f.stop(); }
});
it("does not admit a second actual read while the first read is held", async () => {
  const f = fixture(), gate = deferred<ImageReadResult>();
  f.read.mockImplementation(() => gate.promise);
  const pending = f.call(); void pending.catch(() => {});
  try {
    await expect(f.call("b".repeat(64))).rejects.toThrow(/busy/i);
    expect(f.read).toHaveBeenCalledOnce();
  } finally { gate.resolve(bytes()); await pending.catch(() => {}); await f.stop(); }
});
it("preserves existing cleanup uncertainty across registrar disposal", async () => {
  const f = fixture(), primary = new Error("synthetic primary"), close = new Error("synthetic close");
  const failure = new ImageCleanupUncertainError([primary, close]); f.read.mockRejectedValue(failure);
  await expect(f.call()).resolves.toMatchObject({ kind: "cleanup-uncertain", error: failure });
  await expect(f.call("b".repeat(64))).resolves.toMatchObject({ kind: "cleanup-uncertain", error: failure });
  expect(f.read).toHaveBeenCalledOnce();
  await expect(f.stop()).rejects.toBe(failure);
});

it("does not acknowledge cancellation while an actual raster descriptor close is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "geode-image-receipt-"));
  const closeEntered = deferred<void>(), releaseClose = deferred<void>();
  const f = fixture(directory); let opened = 0, closed = 0, acknowledged = false;
  await copyFile(resolve("tests/fixtures/image-decoder/synthetic.png"), join(directory, "Photo.png"));
  f.read.mockImplementation(request => readAuthorizedImage(request, { ...imageReadIo,
    open: async (...args) => {
      const handle = await imageReadIo.open(...args); opened++;
      return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs),
        close: async () => { closeEntered.resolve(); await releaseClose.promise; await handle.close(); closed++; } };
    } }));
  const pending = f.call(); void pending.catch(() => {});
  let cancellation: Promise<unknown> | undefined;
  try {
    await Promise.race([closeEntered.promise, pending.then(
      () => { throw new Error("Actual read returned before the close-entry witness."); },
      error => { throw new Error("Actual read failed before the close-entry witness.", { cause: error }); },
    )]);
    cancellation = f.cancel().then(value => { acknowledged = true; return value; }); void cancellation.catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(opened).toBe(1); expect(closed).toBe(0); expect(acknowledged).toBe(false);
    releaseClose.resolve(); await pending.catch(() => {});
    await expect(cancellation).resolves.toMatchObject({ kind: "retired", outcome: "cancelled" });
    expect(closed).toBe(1);
  } finally {
    releaseClose.resolve(); await Promise.allSettled([pending, ...(cancellation ? [cancellation] : [])]);
    await f.stop(); await rm(directory, { recursive: true, force: true });
  }
});

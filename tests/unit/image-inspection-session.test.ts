import { expect, it, vi } from "vitest";
import { ImageInspectionSession, assertImageDimensions, type ImageIntent, type ImageBytes, type ImageSessionAdapter } from "../../src/renderer/image-inspection/image-session";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bytes: ImageBytes = { bytes: new ArrayBuffer(8), mime: "image/png" };
const dimensions = { width: 2, height: 3 };
function fixture() {
  const ownerToken = {}, file = {}, vault = {};
  let current = true, next = 0;
  const intent: ImageIntent = { ownerToken, file, vault, root: "/synthetic/vault", path: "Photo.png", snapshot: "![[Photo.png]]", current: () => current };
  const adapter: ImageSessionAdapter = {
    read: vi.fn(async () => bytes), cancel: vi.fn(async () => {}), createURL: vi.fn(() => `blob:synthetic-${++next}`),
    decode: vi.fn(async () => dimensions), hide: vi.fn(), clear: vi.fn(), release: vi.fn(), revoke: vi.fn(), publish: vi.fn(),
  };
  return { intent, adapter, session: new ImageInspectionSession(ownerToken, adapter), invalidate: () => { current = false; } };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

it("publishes one current decoded image as a working positive control", async () => {
  const f = fixture(); await f.session.show(f.intent);
  expect(f.adapter.publish).toHaveBeenCalledWith("blob:synthetic-1", dimensions);
  await f.session.close();
});
it("reports missing host capability explicitly without a fallback", async () => {
  const f = fixture(); await expect(new ImageInspectionSession(f.intent.ownerToken).show(f.intent)).rejects.toThrow(/unsupported/i);
});
it("refuses wrong view ownership even for the same indexed file and Vault", async () => {
  const f = fixture(); await expect(f.session.show({ ...f.intent, ownerToken: {} })).rejects.toThrow();
  expect(f.adapter.read).not.toHaveBeenCalled();
});
it("refuses initially stale source authority before invoking read", async () => {
  const f = fixture(); f.invalidate(); await expect(f.session.show(f.intent)).rejects.toThrow();
  expect(f.adapter.read).not.toHaveBeenCalled();
});
it("close hides and cancels synchronously but awaits actual read settlement", async () => {
  const f = fixture(), read = deferred<ImageBytes>(); f.adapter.read = vi.fn(() => read.promise);
  const showing = f.session.show(f.intent).catch(error => error); await flush();
  const closing = f.session.close(); let closed = false; void closing.then(() => { closed = true; });
  expect(f.adapter.hide).toHaveBeenCalledOnce(); expect(f.adapter.clear).toHaveBeenCalledOnce(); expect(f.adapter.release).toHaveBeenCalledOnce();
  expect(f.adapter.cancel).toHaveBeenCalledOnce(); await flush(); expect(closed).toBe(false);
  read.resolve(bytes); await closing; expect(await showing).toBeInstanceOf(Error);
  expect(f.adapter.createURL).not.toHaveBeenCalled(); expect(f.adapter.publish).not.toHaveBeenCalled();
});
it("close waits for decode after its cancellation acknowledgement and revokes once", async () => {
  const f = fixture(), decode = deferred<typeof dimensions>(); f.adapter.decode = vi.fn(() => decode.promise);
  const showing = f.session.show(f.intent).catch(error => error); await flush();
  const closing = f.session.close(); let closed = false; void closing.then(() => { closed = true; });
  await flush(); expect(closed).toBe(false); expect(f.adapter.clear).toHaveBeenCalledOnce();
  decode.resolve(dimensions); await closing; expect(await showing).toBeInstanceOf(Error);
  expect(f.adapter.publish).not.toHaveBeenCalled(); expect(f.adapter.revoke).toHaveBeenCalledExactlyOnceWith("blob:synthetic-1");
});
it("retains only latest pending C and cannot run it while A decode is unsettled", async () => {
  const f = fixture(), decode = deferred<typeof dimensions>();
  f.adapter.decode = vi.fn().mockReturnValueOnce(decode.promise).mockResolvedValue(dimensions);
  const a = f.session.show(f.intent).catch(error => error); await flush();
  const b = f.session.show({ ...f.intent, path: "B.png" }).catch(error => error);
  const c = f.session.show({ ...f.intent, path: "C.png" }); await flush();
  expect(f.adapter.read).toHaveBeenCalledTimes(1); expect(await b).toBeInstanceOf(Error);
  decode.resolve(dimensions); await c; expect(await a).toBeInstanceOf(Error);
  expect(vi.mocked(f.adapter.read).mock.calls.map(([intent]) => intent.path)).toEqual(["Photo.png", "C.png"]);
  expect(f.adapter.publish).toHaveBeenCalledExactlyOnceWith("blob:synthetic-2", dimensions);
  expect(f.adapter.revoke).toHaveBeenCalledExactlyOnceWith("blob:synthetic-1"); await f.session.close();
});
it.each(["file", "vault", "root", "snapshot"] as const)("rejects changed captured %s after read before any URL", async field => {
  const f = fixture(), read = deferred<ImageBytes>(); f.adapter.read = vi.fn(() => read.promise);
  const showing = f.session.show(f.intent).catch(error => error); await flush();
  if (field === "file" || field === "vault") f.intent[field] = {};
  else f.intent[field] = "changed";
  read.resolve(bytes); expect(await showing).toBeInstanceOf(Error); expect(f.adapter.createURL).not.toHaveBeenCalled();
  await f.session.close();
});
it("invalidating authority during decode suppresses publication and revokes the owned URL", async () => {
  const f = fixture(), decode = deferred<typeof dimensions>(); f.adapter.decode = vi.fn(() => decode.promise);
  const showing = f.session.show(f.intent).catch(error => error); await flush(); f.invalidate(); decode.resolve(dimensions);
  expect(await showing).toBeInstanceOf(Error); expect(f.adapter.publish).not.toHaveBeenCalled();
  expect(f.adapter.revoke).toHaveBeenCalledExactlyOnceWith("blob:synthetic-1"); await f.session.close();
});
it("a settled decode rejection remains recoverable and releases its URL", async () => {
  const f = fixture(), primary = new Error("native decode rejected");
  f.adapter.decode = vi.fn().mockRejectedValueOnce(primary).mockResolvedValue(dimensions);
  await expect(f.session.show(f.intent)).rejects.toBe(primary);
  expect(f.adapter.revoke).toHaveBeenCalledExactlyOnceWith("blob:synthetic-1");
  await f.session.show(f.intent); expect(f.adapter.publish).toHaveBeenCalledExactlyOnceWith("blob:synthetic-2", dimensions); await f.session.close();
});
it("cleanup failure preserves primary error, seals admission and repeats the same close outcome", async () => {
  const f = fixture(), primary = new Error("decode error"), cleanup = new Error("revoke uncertain");
  f.adapter.decode = vi.fn(async () => { throw primary; }); f.adapter.revoke = vi.fn(() => { throw cleanup; });
  const error = await f.session.show(f.intent).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([primary, cleanup]);
  const first = f.session.close(), second = f.session.close(); expect(second).toBe(first);
  await expect(first).rejects.toBe(error); await expect(f.session.show(f.intent)).rejects.toBe(error);
  expect(f.adapter.read).toHaveBeenCalledOnce(); expect(f.adapter.revoke).toHaveBeenCalledOnce();
});
it("registers close before callbacks so reentrant close shares the same pending promise", async () => {
  const f = fixture(), decode = deferred<typeof dimensions>(); f.adapter.decode = vi.fn(() => decode.promise);
  const showing = f.session.show(f.intent).catch(error => error); await flush();
  let reentrant: Promise<void> | undefined; f.adapter.hide = vi.fn(() => { reentrant = f.session.close(); });
  const closing = f.session.close(); expect(reentrant).toBe(closing); expect(f.session.close()).toBe(closing);
  decode.resolve(dimensions); await closing; await showing;
  await expect(f.session.show(f.intent)).rejects.toThrow(); expect(f.adapter.read).toHaveBeenCalledOnce();
});
it("same-file separate view sessions do not cancel each other", async () => {
  const first = fixture(), second = fixture(); second.intent.file = first.intent.file; second.intent.vault = first.intent.vault;
  await first.session.show(first.intent); await second.session.show(second.intent); await first.session.close();
  expect(second.adapter.cancel).not.toHaveBeenCalled(); expect(second.adapter.revoke).not.toHaveBeenCalled(); await second.session.close();
});
it.each([{ width: 0, height: 1 }, { width: NaN, height: 1 }, { width: Infinity, height: 1 }, { width: 1.5, height: 1 }, { width: 8000, height: 8001 }, { width: Number.MAX_SAFE_INTEGER, height: 2 }])("refuses unsafe/over64M pixel dimensions %j without allocating", value => {
  expect(() => assertImageDimensions(value)).toThrow();
});
it("accepts exactly64M natural pixels without allocating a bitmap", () => { expect(() => assertImageDimensions({ width: 8000, height: 8000 })).not.toThrow(); });
it("explicit invalidation clears immediately and retains actual decode AND cancel settlement before next intent", async () => {
  const f = fixture(), decode = deferred<typeof dimensions>(), cancel = deferred<void>();
  f.adapter.decode = vi.fn().mockReturnValueOnce(decode.promise).mockResolvedValue(dimensions);
  f.adapter.cancel = vi.fn(() => cancel.promise);
  const a = f.session.show(f.intent).catch(error => error); await flush(); f.invalidate();
  const invalidating = f.session.invalidate(); let retired = false; void invalidating.then(() => { retired = true; });
  expect(f.adapter.hide).toHaveBeenCalledOnce(); expect(f.adapter.clear).toHaveBeenCalledOnce(); expect(f.adapter.release).toHaveBeenCalledOnce();
  expect(f.adapter.cancel).toHaveBeenCalledOnce(); expect(f.session.invalidate()).toBe(invalidating);
  const next = { ...f.intent, current: () => true, snapshot: "changed" };
  const b = f.session.show(next); await flush(); expect(f.adapter.read).toHaveBeenCalledTimes(1);
  decode.resolve(dimensions); await flush(); expect(retired).toBe(false); expect(f.adapter.read).toHaveBeenCalledTimes(1);
  cancel.resolve(); await invalidating; await b; expect(await a).toBeInstanceOf(Error);
  expect(f.adapter.publish).toHaveBeenCalledExactlyOnceWith("blob:synthetic-2", dimensions); await f.session.close();
});
it("uses distinct64hex read IDs and cancellation retains its captured old ID", async () => {
  const f = fixture(), read = deferred<ImageBytes>();
  f.adapter.read = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(bytes);
  const first = f.session.show(f.intent).catch(error => error); await flush();
  const retiring = f.session.invalidate(); read.resolve(bytes); await retiring; await first;
  await f.session.show(f.intent);
  const calls = vi.mocked(f.adapter.read).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[0][1]).toMatch(/^[0-9a-f]{64}$/); expect(calls[1][1]).toMatch(/^[0-9a-f]{64}$/);
  expect(calls[0][1]).not.toBe(calls[1][1]);
  expect(f.adapter.cancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "Photo.png" }), calls[0][1]);
  expect(vi.mocked(f.adapter.cancel).mock.calls[0][1]).not.toBe(calls[1][1]);
  await f.session.close();
});
it("a rejected cancellation never releases an unsettled read and seals subsequent work", async () => {
  const f = fixture(), read = deferred<ImageBytes>(), cleanup = new Error("cancel cleanup uncertain");
  f.adapter.read = vi.fn(() => read.promise); f.adapter.cancel = vi.fn(async () => { throw cleanup; });
  const showing = f.session.show(f.intent).catch(error => error); await flush();
  const closing = f.session.close(); const outcome = closing.catch(error => error); let settled = false; void outcome.then(() => { settled = true; });
  await flush(); expect(settled).toBe(false); expect(f.adapter.read).toHaveBeenCalledOnce();
  read.resolve(bytes); const error = await outcome; expect(error.errors).toContain(cleanup);
  expect(await showing).toBe(error); expect(f.session.close()).toBe(closing);
  await expect(f.session.show(f.intent)).rejects.toBe(error); expect(f.adapter.createURL).not.toHaveBeenCalled();
});
it("a late URL created during reentrant invalidation is revoked once without starting decode", async () => {
  const f = fixture(); let retiring: Promise<void> | undefined;
  f.adapter.createURL = vi.fn(() => { retiring = f.session.invalidate(); return "blob:late-owned"; });
  await expect(f.session.show(f.intent)).rejects.toThrow(); await retiring;
  expect(f.adapter.decode).not.toHaveBeenCalled(); expect(f.adapter.revoke).toHaveBeenCalledExactlyOnceWith("blob:late-owned");
  await f.session.close(); expect(f.adapter.revoke).toHaveBeenCalledOnce();
});
it("preserves failed presentation cleanup and still attempts every other release", async () => {
  const f = fixture(), cleanup = new Error("presentation hide failed"); await f.session.show(f.intent);
  f.adapter.hide = vi.fn(() => { throw cleanup; });
  const closing = f.session.close(); await expect(closing).rejects.toBe(cleanup);
  expect(f.adapter.clear).toHaveBeenCalledOnce(); expect(f.adapter.release).toHaveBeenCalledOnce(); expect(f.adapter.revoke).toHaveBeenCalledOnce();
  expect(f.session.close()).toBe(closing); await expect(f.session.show(f.intent)).rejects.toBe(cleanup);
});
it("a normal settled read rejection permits the next image without a replacement session", async () => {
  const f = fixture(), primary = new Error("missing image");
  f.adapter.read = vi.fn().mockRejectedValueOnce(primary).mockResolvedValue(bytes);
  await expect(f.session.show(f.intent)).rejects.toBe(primary); await f.session.show(f.intent);
  expect(f.adapter.publish).toHaveBeenCalledOnce(); await f.session.close();
});
it("an incomplete host capability is explicitly unsupported before any read", async () => {
  const f = fixture(); delete (f.adapter as Partial<ImageSessionAdapter>).decode;
  await expect(f.session.show(f.intent)).rejects.toThrow(/unsupported/i);
  expect(f.adapter.read).not.toHaveBeenCalled(); await f.session.close();
});
it("reentrant final authority invalidation cannot report success or bypass newly registered cancellation", async () => {
  const f = fixture(), cancel = deferred<void>(); let published = false, checksAfterPublish = 0;
  let invalidating: Promise<void> | undefined;
  f.adapter.cancel = vi.fn(() => cancel.promise);
  f.adapter.publish = vi.fn(() => { published = true; });
  f.intent.current = () => {
    if (published && ++checksAfterPublish === 2) invalidating = f.session.invalidate();
    return true;
  };
  const showing = f.session.show(f.intent).catch(error => error); let settled = false; void showing.then(() => { settled = true; });
  try {
    await flush(); expect(invalidating).toBeDefined(); expect(f.adapter.cancel).toHaveBeenCalledOnce();
    expect(settled).toBe(false); expect(f.adapter.clear).toHaveBeenCalledOnce();
    cancel.resolve(); expect(await showing).toBeInstanceOf(Error); await invalidating;
    expect(f.adapter.revoke).toHaveBeenCalledOnce();
  } finally { cancel.resolve(); await showing; await invalidating; await f.session.close(); }
});

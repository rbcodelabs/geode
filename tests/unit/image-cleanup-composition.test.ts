import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { registerImageReadIpc, type ImageReadAuthority, type ImageReadEvent } from "../../src/main/image-ipc";
import { imageReadIo, readAuthorizedImage } from "../../src/main/image-resource";
import { ImageCleanupUncertainError } from "../../src/shared/image-cleanup";
import { ImageInspectionSession, type ImageSessionAdapter } from "../../src/renderer/image-inspection/image-session";

it("actual close failure seals the stable window across new registrar/session/root and prevents any new I/O", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geode-image-cleanup-"));
  const root = path.join(directory, "vault"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "Photo.png"), Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex"));
  const handlers = new Map<string, (event: ImageReadEvent, request: unknown) => Promise<unknown>>();
  const frame = {}, window = {}, cleanup = new Error("actual close wrapper failed");
  const event = { sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame };
  let authority: ImageReadAuthority = { window, frame, identity: {}, root, current: () => true };
  const open = vi.fn(async (target: string, flags: number) => {
    const handle = await imageReadIo.open(target, flags);
    return { stat: () => handle.stat(), read: (...args: Parameters<typeof handle.read>) => handle.read(...args), close: async () => { await handle.close(); throw cleanup; } };
  });
  const reader = vi.fn(request => readAuthorizedImage(request, { ...imageReadIo, open }));
  const ipc = { handle: (name: string, handler: (event: ImageReadEvent, request: unknown) => Promise<unknown>) => { handlers.set(name, handler); }, removeHandler: (name: string) => { handlers.delete(name); } };
  const call = () => handlers.get("image-resources-read")!(event, { root: authority.root, path: "Photo.png", id: "a".repeat(64) });
  const cancel = () => handlers.get("image-resources-cancel")!(event, { root: authority.root, id: "a".repeat(64) });
  let dispose = registerImageReadIpc(ipc, () => authority, reader);
  try {
    const failure = await call();
    expect(failure).toMatchObject({ kind: "cleanup-uncertain", error: expect.any(ImageCleanupUncertainError) });
    const error = (failure as { error: ImageCleanupUncertainError }).error; expect(error.errors).toEqual([cleanup]);
    expect(await cancel()).toBe(failure); expect(await call()).toBe(failure);
    authority = { ...authority, identity: {}, root: directory };
    expect(await call()).toBe(failure); expect(reader).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
    const closing = dispose(); expect(dispose()).toBe(closing); await expect(closing).rejects.toBe(error);
    dispose = registerImageReadIpc(ipc, () => authority, reader);
    expect(await call()).toBe(failure); expect(await cancel()).toBe(failure); expect(reader).toHaveBeenCalledOnce();
    await expect(dispose()).rejects.toBe(error);
  } finally { await dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); }
});
it.each(["read", "cancel"] as const)("trusted %s cleanup tag seals session without depending on Error prototype", async channel => {
  const ownerToken = {}, error = { code: "SYNTHETIC_CLEANUP", details: "serialized host failure" };
  const failure = { kind: "cleanup-uncertain" as const, error };
  const adapter = {
    read: vi.fn(async () => channel === "read" ? failure : { bytes: new ArrayBuffer(8), mime: "image/png" }),
    cancel: vi.fn(async () => failure), createURL: vi.fn(() => "blob:synthetic"), decode: vi.fn(async () => ({ width: 1, height: 1 })),
    hide: vi.fn(), clear: vi.fn(), release: vi.fn(), revoke: vi.fn(), publish: vi.fn(),
  };
  const session = new ImageInspectionSession(ownerToken, adapter as unknown as ImageSessionAdapter);
  const intent = { ownerToken, file: {}, vault: {}, root: "/synthetic", path: "Photo.png", snapshot: "source", current: () => true };
  if (channel === "read") await expect(session.show(intent)).rejects.toBe(error);
  else {
    let finish!: (value: { width: number; height: number }) => void;
    adapter.decode = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const showing = session.show(intent).catch(value => value);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    const invalidating = session.invalidate().catch(value => value);
    finish({ width: 1, height: 1 });
    expect(await invalidating).toBeInstanceOf(AggregateError);
    expect((await showing).errors).toContain(error);
  }
  const closing = session.close(); expect(session.close()).toBe(closing);
  const outcome = await closing.catch(value => value);
  if (channel === "read") expect(outcome).toBe(error); else expect(outcome.errors).toContain(error);
  await expect(session.show(intent)).rejects.toBe(outcome); expect(adapter.read).toHaveBeenCalledOnce();
});
it("preserves trusted host uncertainty AND a presentation cleanup failure", async () => {
  const ownerToken = {}, primary = new Error("host descriptor uncertain"), cleanup = new Error("hide uncertain");
  const session = new ImageInspectionSession(ownerToken, {
    read: async () => ({ kind: "cleanup-uncertain", error: primary }), cancel: () => {}, createURL: () => { throw new Error("must not create"); },
    decode: async () => ({ width: 1, height: 1 }), publish: () => {}, hide: () => { throw cleanup; }, clear: () => {}, release: () => {}, revoke: () => {},
  });
  const error = await session.show({ ownerToken, file: {}, vault: {}, root: "/synthetic", path: "Photo.png", snapshot: "source", current: () => true }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([primary, cleanup]);
  await expect(session.close()).rejects.toBe(error);
});
it.each([false, true])("registrar replacement retains an actual unsettled close (late uncertainty=%s)", async lateFailure => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geode-image-retirement-"));
  await fs.writeFile(path.join(directory, "Photo.png"), Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex"));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), closingEntered = new Promise<void>(resolve => { entered = resolve; });
  const cleanup = new Error("late descriptor uncertainty"), frame = {}, window = {};
  const event = { sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame };
  const authority = { window, frame, identity: {}, root: directory, current: () => true };
  const handlers = new Map<string, (event: ImageReadEvent, request: unknown) => Promise<unknown>>();
  const ipc = { handle: (name: string, handler: (event: ImageReadEvent, request: unknown) => Promise<unknown>) => { handlers.set(name, handler); }, removeHandler: (name: string) => { handlers.delete(name); } };
  const open = vi.fn(async (target: string, flags: number) => {
    const handle = await imageReadIo.open(target, flags);
    return { stat: () => handle.stat(), read: (...args: Parameters<typeof handle.read>) => handle.read(...args), close: async () => {
      await handle.close(); entered(); await gate; if (lateFailure) throw cleanup;
    } };
  });
  const firstReader = vi.fn(request => readAuthorizedImage(request, { ...imageReadIo, open }));
  const disposeA = registerImageReadIpc(ipc, () => authority, firstReader);
  const request = { root: directory, path: "Photo.png", id: "b".repeat(64) };
  const first = handlers.get("image-resources-read")!(event, request).catch(error => error);
  await closingEntered;
  const closingA = disposeA(); void closingA.catch(() => {});
  const replacementReader = vi.fn(async () => ({ bytes: new ArrayBuffer(8), mime: "image/png" as const }));
  const replacementAuthority = { ...authority, identity: {} };
  const disposeB = registerImageReadIpc(ipc, () => replacementAuthority, replacementReader);
  const callB = () => handlers.get("image-resources-read")!(event, { ...request, id: "c".repeat(64) });
  try {
    expect(disposeA()).toBe(closingA);
    await expect(callB()).rejects.toThrow(/busy/i); expect(replacementReader).not.toHaveBeenCalled();
    release(); const outcome = await first;
    if (lateFailure) {
      expect(outcome).toMatchObject({ kind: "cleanup-uncertain" });
      expect(await callB()).toBe(outcome); expect(replacementReader).not.toHaveBeenCalled();
      await expect(closingA).rejects.toBe(outcome.error); await expect(disposeB()).rejects.toBe(outcome.error);
    } else {
      expect(outcome).toBeInstanceOf(Error); await closingA;
      await expect(callB()).resolves.toMatchObject({ mime: "image/png" }); expect(replacementReader).toHaveBeenCalledOnce(); await disposeB();
    }
    expect(firstReader).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
  } finally { release(); await first; await closingA.catch(() => {}); await disposeB().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); }
});

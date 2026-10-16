import { expect, it, vi } from "vitest";
import { registerImageReadIpc, type ImageReadAuthority, type ImageReadEvent, type ImageReaderRequest, type ImageReadResult } from "../../src/main/image-ipc";

const id = "a".repeat(64);
function fixture() {
  const handlers = new Map<string, (event: ImageReadEvent, request: unknown) => Promise<unknown>>();
  const frame = {}, windowIdentity = {}, session = {};
  const event = { sender: { isDestroyed: () => false, mainFrame: frame }, senderFrame: frame };
  let authority: ImageReadAuthority | null = { window: windowIdentity, frame, identity: session, root: "/synthetic", current: () => true };
  const read = vi.fn(async (_request: ImageReaderRequest): Promise<ImageReadResult> => ({ bytes: new ArrayBuffer(8), mime: "image/png" as const }));
  registerImageReadIpc({ handle: (channel, callback) => { handlers.set(channel, callback); }, removeHandler: channel => { handlers.delete(channel); } }, () => authority, read);
  const call = (request: unknown = { root: "/synthetic", path: "Photo.png", id }, suppliedEvent = event) => handlers.get("image-resources-read")!(suppliedEvent, request);
  const cancel = (request: unknown = { root: "/synthetic", id }, suppliedEvent = event) => handlers.get("image-resources-cancel")!(suppliedEvent, request);
  return { event, frame, read, call, cancel, get authority() { return authority; }, setAuthority: (value: ImageReadAuthority | null) => { authority = value; } };
}
it("admits an exact current known-main-frame request through an unregistered registrar", async () => {
  const f = fixture();
  await expect(f.call()).resolves.toMatchObject({ mime: "image/png" });
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.read.mock.calls[0][0]).toMatchObject({ root: "/synthetic", expectedRoot: "/synthetic", path: "Photo.png" });
  expect(f.read.mock.calls[0][0].current()).toBe(true);
});
for (const [caseIndex, request] of [null, [], {}, { root: "", path: "Photo.png", id }, { root: "/synthetic", path: "", id },
  { root: "/synthetic", path: "Photo.png", id: "a".repeat(63) }, { root: "/synthetic", path: "Photo.png", id: "g".repeat(64) },
  { root: "/synthetic", path: "Photo.png", id, extra: true }, { root: "x".repeat(4097), path: "Photo.png", id },
  { root: "/synthetic", path: "x".repeat(4097), id }, Object.assign(Object.create({ inherited: true }), { root: "/synthetic", path: "Photo.png", id })].entries()) {
  it(`rejects malformed own-schema case ${caseIndex} before reading`, async () => {
    const f = fixture(); await expect(f.call(request)).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  });
}
for (const change of ["unknown", "subframe", "missing-frame", "destroyed", "wrong-root", "stale-session"] as const) {
  it(`rejects ${change} authority before any reader invocation`, async () => {
    const f = fixture();
    if (change === "unknown") f.setAuthority(null);
    if (change === "subframe") f.event.senderFrame = {};
    if (change === "missing-frame") f.event.senderFrame = null as never;
    if (change === "destroyed") f.event.sender.isDestroyed = () => true;
    if (change === "wrong-root") f.setAuthority({ ...f.authority!, root: "/other" });
    if (change === "stale-session") f.setAuthority({ ...f.authority!, current: () => false });
    await expect(f.call()).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  });
}
it("retains one window slot after cancel and session rotation until the actual read settles", async () => {
  const f = fixture(); let finish: (() => void) | undefined; let calls = 0;
  f.read.mockImplementation(() => ++calls === 1
    ? new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); })
    : Promise.resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }));
  const first = f.call(); void first.catch(() => {}); await Promise.resolve();
  try {
    expect(f.read).toHaveBeenCalledOnce(); await f.cancel();
    f.setAuthority({ ...f.authority!, identity: {}, root: "/next" });
    await expect(f.call({ root: "/next", path: "Next.png", id: "b".repeat(64) })).rejects.toThrow(/busy/i);
    expect(f.read).toHaveBeenCalledOnce(); finish!(); await expect(first).rejects.toThrow();
    await expect(f.call({ root: "/next", path: "Next.png", id: "b".repeat(64) })).resolves.toMatchObject({ mime: "image/png" });
  } finally { finish?.(); await first.catch(() => {}); }
});
it("invalidates an in-flight same-root read when its captured session identity changes", async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  f.read.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); }));
  const pending = f.call(); void pending.catch(() => {}); await Promise.resolve();
  try {
    const captured = f.read.mock.calls[0][0]; f.setAuthority({ ...f.authority!, identity: {} });
    expect(captured.current()).toBe(false); finish!(); await expect(pending).rejects.toThrow();
  } finally { finish?.(); await pending.catch(() => {}); }
});
it.each(["identity", "root", "window", "current"] as const)("retains original authority when its provider mutates %s in place", async field => {
  const f = fixture(); let finish!: () => void, calls = 0, originalCurrent = true;
  const provider = f.authority!; provider.current = () => originalCurrent;
  const original = { ...provider };
  f.read.mockImplementation(() => ++calls === 1 ? new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); })
    : Promise.resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }));
  const pending = f.call(); void pending.catch(() => {}); await Promise.resolve();
  try {
    if (field === "current") { originalCurrent = false; provider.current = () => true; }
    else if (field === "root") provider.root = "/changed";
    else provider[field] = {};
    expect(f.read.mock.calls[0][0].current()).toBe(false);
    finish(); await expect(pending).rejects.toThrow();
    Object.assign(provider, original); originalCurrent = true;
    await expect(f.call()).resolves.toMatchObject({ mime: "image/png" });
    expect(f.read).toHaveBeenCalledTimes(2);
  } finally { finish(); await pending.catch(() => {}); }
});
it("calls the captured authority method with its original provider receiver", async () => {
  const f = fixture(), provider = f.authority!;
  provider.current = function () { return this === provider; };
  await expect(f.call()).resolves.toMatchObject({ mime: "image/png" });
});
for (const change of ["main-frame", "sender-frame", "destroyed"] as const) it(`invalidates pending bytes after ${change} replacement`, async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  f.read.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); }));
  const pending = f.call(); void pending.catch(() => {}); await Promise.resolve();
  try {
    if (change === "main-frame") f.event.sender.mainFrame = {};
    if (change === "sender-frame") f.event.senderFrame = {};
    if (change === "destroyed") f.event.sender.isDestroyed = () => true;
    expect(f.read.mock.calls[0][0].current()).toBe(false);
    finish!(); await expect(pending).rejects.toThrow();
  } finally { finish?.(); await pending.catch(() => {}); }
});
for (const cancelRequest of [{ root: "/synthetic", id: "b".repeat(64) }, { root: "/other", id },
  { root: "/synthetic", id, extra: true }, { root: "/synthetic", id: "not-an-id" }, null]) {
  it(`refuses malformed or stale cancel ${JSON.stringify(cancelRequest)} without invalidating the active read`, async () => {
    const f = fixture(); let finish: (() => void) | undefined;
    f.read.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); }));
    const pending = f.call(); void pending.catch(() => {}); await Promise.resolve();
    try {
      await expect(f.cancel(cancelRequest)).rejects.toThrow();
      expect(f.read.mock.calls[0][0].current()).toBe(true);
      finish!(); await expect(pending).resolves.toMatchObject({ mime: "image/png" });
    } finally { finish?.(); await pending.catch(() => {}); }
  });
}
it("keeps duplicate old cancellation from invalidating a later request", async () => {
  const f = fixture(); await f.call();
  let finish: (() => void) | undefined;
  f.read.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); }));
  const pending = f.call({ root: "/synthetic", path: "Other.png", id: "b".repeat(64) }); void pending.catch(() => {}); await Promise.resolve();
  try {
    await expect(f.cancel()).rejects.toThrow();
    expect(f.read.mock.calls[1][0].current()).toBe(true); finish!(); await pending;
  } finally { finish?.(); await pending.catch(() => {}); }
});
it("admits independent windows while a cancelled window read remains unsettled", async () => {
  const handlers = new Map<string, (event: ImageReadEvent, request: unknown) => Promise<unknown>>();
  const frameA = {}, frameB = {};
  const a = { sender: { isDestroyed: () => false, mainFrame: frameA }, senderFrame: frameA };
  const b = { sender: { isDestroyed: () => false, mainFrame: frameB }, senderFrame: frameB };
  const authority = new Map<object, ImageReadAuthority>([[a.sender, { window: {}, frame: frameA, identity: {}, root: "/synthetic", current: () => true }],
    [b.sender, { window: {}, frame: frameB, identity: {}, root: "/synthetic", current: () => true }]]);
  let finish: (() => void) | undefined; let calls = 0;
  const read = vi.fn(() => ++calls === 1 ? new Promise<{ bytes: ArrayBuffer; mime: "image/png" }>(resolve => { finish = () => resolve({ bytes: new ArrayBuffer(8), mime: "image/png" }); }) : Promise.resolve({ bytes: new ArrayBuffer(8), mime: "image/png" as const }));
  const unregister = registerImageReadIpc({ handle: (channel, callback) => { handlers.set(channel, callback); }, removeHandler: channel => { handlers.delete(channel); } }, event => authority.get(event.sender) ?? null, read);
  const first = handlers.get("image-resources-read")!(a, { root: "/synthetic", path: "A.png", id }); void first.catch(() => {}); await Promise.resolve();
  try {
    await expect(handlers.get("image-resources-cancel")!(b, { root: "/synthetic", id })).rejects.toThrow();
    await handlers.get("image-resources-cancel")!(a, { root: "/synthetic", id });
    await expect(handlers.get("image-resources-read")!(b, { root: "/synthetic", path: "B.png", id })).resolves.toMatchObject({ mime: "image/png" });
    let disposed = false; const closing = unregister().then(() => { disposed = true; });
    expect(handlers.size).toBe(0); await Promise.resolve(); expect(disposed).toBe(false);
    finish!(); await expect(first).rejects.toThrow(); await closing; expect(disposed).toBe(true);
  } finally { finish?.(); await first.catch(() => {}); await unregister(); }
});
it.each([false, true])("rolls back only its installed handler after partial registration; cleanupFailure=%s", async cleanupFails => {
  const registration = new Error("foreign cancel handler already exists"), cleanup = new Error("remove read failed");
  const frame = {}, event = { sender: { isDestroyed: () => false, mainFrame: frame }, senderFrame: frame };
  const authority = { window: {}, frame, identity: {}, root: "/synthetic", current: () => true };
  const foreign = vi.fn(async () => "foreign"), handlers = new Map<string, (...args: any[]) => Promise<unknown>>([["image-resources-cancel", foreign]]);
  let captured: ((event: ImageReadEvent, request: unknown) => Promise<unknown>) | undefined;
  const read = vi.fn(async () => ({ bytes: new ArrayBuffer(8), mime: "image/png" as const }));
  const remove = vi.fn((channel: string) => { if (cleanupFails) throw cleanup; handlers.delete(channel); });
  let failure: unknown;
  try {
    registerImageReadIpc({ handle: (channel, callback) => {
      if (handlers.has(channel)) throw registration;
      handlers.set(channel, callback); captured = callback;
    }, removeHandler: remove }, () => authority, read);
  } catch (error) { failure = error; }
  expect(remove).toHaveBeenCalledExactlyOnceWith("image-resources-read");
  expect(handlers.get("image-resources-cancel")).toBe(foreign);
  if (cleanupFails) expect((failure as AggregateError).errors).toEqual([registration, cleanup]); else expect(failure).toBe(registration);
  await expect(captured!(event, { root: "/synthetic", path: "Photo.png", id })).rejects.toThrow(/unavailable/i);
  expect(read).not.toHaveBeenCalled();
});
it("retains the same unregister promise and cleanup failure on every call", async () => {
  const failure = new Error("handler removal failed"), remove = vi.fn(() => { throw failure; });
  const unregister = registerImageReadIpc({ handle() {}, removeHandler: remove }, () => null, async () => ({ bytes: new ArrayBuffer(8), mime: "image/png" }));
  const first = unregister(), second = unregister();
  expect(second).toBe(first); await expect(first).rejects.toMatchObject({ errors: [failure, failure] });
  const third = unregister(); expect(third).toBe(first); await expect(third).rejects.toMatchObject({ errors: [failure, failure] });
  expect(remove).toHaveBeenCalledTimes(2);
});

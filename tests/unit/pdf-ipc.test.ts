import { expect, it, vi } from "vitest";
const api = await import("../../src/main/pdf-ipc").catch(() => ({})) as typeof import("../../src/main/pdf-ipc");
function setup(reader = vi.fn(async () => new ArrayBuffer(6))) {
  const frame = {}, sender = { mainFrame: frame, isDestroyed: () => false }, event = { sender, senderFrame: frame };
  let handler!: (event: any, request: unknown) => Promise<ArrayBuffer>;
  const register = { handle: vi.fn((_channel, receive) => { handler = receive; }) }, authority = vi.fn(() => ({ root: "/vault", current: () => true }));
  api.registerPdfReadIpc(register as any, authority, reader as any); return { handler, register, event, reader, authority };
}
it("captures only main-frame authorized PDF read requests and preserves their root/session check", async () => {
  expect(api.registerPdfReadIpc).toBeTypeOf("function"); const fixture = setup();
  await fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" });
  expect(fixture.register.handle).toHaveBeenCalledWith("vault-read-pdf", expect.any(Function));
  expect(fixture.reader).toHaveBeenCalledWith({ root: "/vault", expectedRoot: "/vault", path: "Guide.pdf", current: expect.any(Function) });
});
it("rejects subframe senders and unexpected request capabilities before any read", async () => {
  expect(api.registerPdfReadIpc).toBeTypeOf("function"); const fixture = setup();
  await expect(fixture.handler({ ...fixture.event, senderFrame: {} }, { root: "/vault", path: "Guide.pdf" })).rejects.toThrow(/PDF|frame/i);
  for (const request of [null, { root: "/vault", path: "Guide.pdf", url: "file:///private" }, { root: "/vault", path: 3 }, { root: "/vault", path: "x".repeat(4097) }]) await expect(fixture.handler(fixture.event, request)).rejects.toThrow(/PDF|request/i);
  expect(fixture.reader).not.toHaveBeenCalled();
});
it("bounds concurrent native reads and releases the slot after success or failure", async () => {
  expect(api.registerPdfReadIpc).toBeTypeOf("function"); let resolve!: (bytes: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>(done => resolve = done), fixture = setup(vi.fn(() => pending));
  const reads = Array.from({ length: 4 }, () => fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" }));
  await expect(fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" })).rejects.toThrow(/busy|limit/i);
  expect(fixture.reader).toHaveBeenCalledTimes(4); resolve(new ArrayBuffer(6)); await Promise.all(reads);
  await fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" }); expect(fixture.reader).toHaveBeenCalledTimes(5);
  fixture.reader.mockRejectedValueOnce(Error("read failed")); await expect(fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" })).rejects.toThrow(/read failed/);
  await fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" }); expect(fixture.reader).toHaveBeenCalledTimes(7);
});

it("invalidates the captured read when its sender or main frame retires", async () => {
  expect(api.registerPdfReadIpc).toBeTypeOf("function"); const fixture = setup();
  await fixture.handler(fixture.event, { root: "/vault", path: "Guide.pdf" });
  const captured = fixture.reader.mock.calls[0][0] as any; expect(captured.current()).toBe(true);
  fixture.event.sender.mainFrame = {} as any; expect(captured.current()).toBe(false);
  fixture.event.sender.mainFrame = fixture.event.senderFrame; fixture.event.sender.isDestroyed = () => true; expect(captured.current()).toBe(false);
});

/** Controlled DOM/native Promise stand-ins on the actual proof adapter; not browser evidence. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.stubGlobal("addEventListener", vi.fn());
const { observedSession } = await import("../../scripts/image-decoder-proof/native-helper");
const png = { family: "png", mime: "image/png" as const, path: "A.png", bytes: [1, 2], sha256: "a".repeat(64), width: 8, height: 8,
  reader: { mime: "image/png", bytes: 2, sha256: "a".repeat(64) } };
let targets: ControlledImage[], native: { resolve(): void; reject(error: unknown): void }[], serial: number;
class ControlledImage {
  attrs = new Map<string, string>(); isConnected = false; hidden = false; naturalWidth = 8; naturalHeight = 8;
  get src() { return this.getAttribute("src") ?? ""; } set src(value: string) { this.attrs.set("src", value); }
  get currentSrc() { return this.src; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); if (name === "src") { this.naturalWidth = 0; this.naturalHeight = 0; } }
  remove() { this.isConnected = false; }
  addEventListener() {} removeEventListener() {}
  decode() { return new Promise<void>((resolve, reject) => { native.push({ resolve, reject }); }); }
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  targets = []; native = []; serial = 0;
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => `blob:controlled/${++serial}`); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("document", { createElement: () => { const element = new ControlledImage(); targets.push(element); return element; },
    body: { appendChild: (element: ControlledImage) => { element.isConnected = true; } } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function state() {
  const events: any[] = []; const value = observedSession(new Map([["A.png", png], ["B.png", png], ["C.png", png]]), events, "controlled");
  let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve; }); value.watchDecode(admitted);
  return { ...value, events, admission };
}
const result = (promise: Promise<void>) => promise.then(() => undefined, error => error);
it("retains exact detached pending decoder source and blocks close until native settlement", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  const element = targets[0], original = element.getAttribute("src"); let closed = false;
  const closing = s.close().then(() => { closed = true; }); await drain();
  expect(element.getAttribute("src")).toBe(original); expect(element.isConnected).toBe(false); expect(closed).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(original);
  native[0].resolve(); await closing; expect(await showing).toBeInstanceOf(Error);
  expect(element.getAttribute("src")).toBeNull(); expect(closed).toBe(true);
});
it("retired native rejection clears only after actual rejection without obsolete publication", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission; const original = targets[0].src;
  const closing = s.close(); expect(targets[0].src).toBe(original);
  native[0].reject(new DOMException("controlled corrupt", "EncodingError")); await closing;
  expect(await showing).toBeInstanceOf(Error); expect(targets[0].getAttribute("src")).toBeNull(); expect(s.events.some(e => e.name === "publish")).toBe(false);
});
it("keeps only latest intent behind actual native settlement and decoder cleanup", async () => {
  const s = state(), a = result(s.session.show(s.intent("A.png"))); await s.admission;
  const original = targets[0].src, b = result(s.session.show(s.intent("B.png"))), c = s.session.show(s.intent("C.png"));
  await drain(); expect(native).toHaveLength(1); expect(targets[0].src).toBe(original);
  native[0].resolve(); await a; await b; await drain(); expect(native).toHaveLength(2); expect(targets[0].getAttribute("src")).toBeNull();
  native[1].resolve(); await c; await s.close(); expect(s.events.filter(e => e.name === "readStart").map(e => e.path)).toEqual(["A.png", "C.png"]);
});
it("a published successful decode has real synchronous source removal on close", async () => {
  const s = state(), showing = s.session.show(s.intent("A.png")); await s.admission; native[0].resolve(); await showing;
  expect(targets[0].isConnected).toBe(true); const closing = s.close();
  expect(targets[0].getAttribute("src")).toBeNull(); expect(targets[0].isConnected).toBe(false); expect(targets[0].hidden).toBe(true); await closing;
});
it("close before decode admission does not create an element or await a nonexistent native promise", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.close();
  expect(await showing).toBeInstanceOf(Error); expect(targets).toHaveLength(0); expect(native).toHaveLength(0);
});
it("deferred source-clear failure preserves uncertainty and refuses the latest successor", async () => {
  const s = state(), a = result(s.session.show(s.intent("A.png"))); await s.admission;
  const failure = new Error("controlled source clear failure"), remove = vi.spyOn(targets[0], "removeAttribute").mockImplementation(() => { throw failure; });
  const c = result(s.session.show(s.intent("C.png"))); await drain(); expect(remove).not.toHaveBeenCalled();
  native[0].resolve(); expect(await a).toBeTruthy(); expect(await c).toBeTruthy(); expect(native).toHaveLength(1);
  const close1 = result(s.session.close()), close2 = result(s.session.close()); expect(await close1).toBe(await close2);
});
it("ordinary settled corrupt rejection remains recoverable and preserves the native error", async () => {
  const s = state(), failure = new DOMException("controlled corrupt", "EncodingError"), first = result(s.session.show(s.intent("A.png")));
  await s.admission; native[0].reject(failure); expect(await first).toBe(failure); expect(targets[0].getAttribute("src")).toBeNull();
  const next = s.session.show(s.intent("C.png")); await drain(); native[1].resolve(); await next; await s.close();
  expect(native).toHaveLength(2);
});
it("close after native settlement before publish prevents promotion", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  native[0].resolve(); let closing!: Promise<void>; queueMicrotask(() => { closing = s.close(); });
  await showing; await closing; expect(s.events.some(e => e.name === "publish")).toBe(false); expect(targets[0].isConnected).toBe(false);
});
it("reentrant close from actual promotion cannot leave a stale connected presentation", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  let closing!: Promise<void>;
  vi.spyOn(document.body, "appendChild").mockImplementation((element: any) => { closing = s.close(); element.isConnected = true; return element; });
  native[0].resolve(); await showing; await closing;
  expect(targets[0].isConnected).toBe(false); expect(s.events.some(e => e.name === "publish")).toBe(false);
});
it("duplicate exact cancel acknowledgements share cleanup and retain its failure", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  const failure = new Error("controlled listeners"), remove = vi.spyOn(targets[0], "removeEventListener").mockImplementation(() => { throw failure; });
  const id = s.events.find(e => e.name === "readStart").id;
  const cancel1 = s.adapter.cancel(s.intent("A.png"), id), cancel2 = s.adapter.cancel(s.intent("A.png"), id);
  expect(cancel1).toBe(cancel2); native[0].resolve(); const reply: any = await cancel1;
  expect(reply.kind).toBe("cleanup-uncertain"); expect(reply.error).toBe(failure); expect(await s.adapter.cancel(s.intent("A.png"), id)).toBe(reply);
  expect(remove).toHaveBeenCalledTimes(1); expect(await showing).toBeTruthy(); await result(s.session.close());
});
it("revoke failure still drains native work and blocks successor admission", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  const failure = new Error("controlled revoke"); vi.mocked(URL.revokeObjectURL).mockImplementation(() => { throw failure; });
  const next = result(s.session.show(s.intent("C.png"))); let closed = false; const closing = result(s.session.close()).then(value => { closed = true; return value; });
  await drain(); expect(closed).toBe(false); expect(native).toHaveLength(1); native[0].resolve();
  expect(await closing).toBeTruthy(); expect(await showing).toBeTruthy(); expect(await next).toBeTruthy(); expect(native).toHaveLength(1);
});
it("native rejection and deferred cleanup failure both remain visible", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  const original = new DOMException("native rejection", "EncodingError"), cleanup = new Error("source clear");
  vi.spyOn(targets[0], "removeAttribute").mockImplementation(() => { throw cleanup; });
  const closing = result(s.close()); native[0].reject(original); const failure = await showing;
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toContain(original); expect(failure.errors).toContain(cleanup);
  expect(await closing).toBeTruthy();
});
it("native dimensions are captured before deferred source clearing resets them", async () => {
  const s = state(), showing = result(s.session.show(s.intent("A.png"))); await s.admission;
  const closing = s.close(); native[0].resolve(); await showing; await closing;
  expect(s.events.find(e => e.name === "decodeSettled")).toMatchObject({ width: 8, height: 8 }); expect(targets[0].naturalWidth).toBe(0);
});
it("a stale cancel ID cannot retire the successor's immutable decoder", async () => {
  const s = state(), first = s.session.show(s.intent("A.png")); await s.admission; native[0].resolve(); await first;
  const oldID = s.events.find(e => e.name === "readStart").id, second = s.session.show(s.intent("C.png")); await drain();
  const source = targets[1].src; expect(() => s.adapter.cancel(s.intent("A.png"), oldID)).toThrow(/exact active/);
  expect(targets[1].src).toBe(source); native[1].resolve(); await second; await s.close();
});
it("synchronous settled listener cleanup failure stays sticky on duplicate release", async () => {
  const s = state(), showing = s.session.show(s.intent("A.png")); await s.admission; native[0].resolve(); await showing;
  const failure = new Error("settled listener failure"), release = vi.spyOn(targets[0], "removeEventListener").mockImplementation(() => { throw failure; });
  const closing = result(s.session.close()); expect(await closing).toBeTruthy();
  expect(() => s.adapter.release()).toThrow(failure); expect(() => s.adapter.release()).toThrow(failure); expect(release).toHaveBeenCalledTimes(1);
  expect(await result(s.session.show(s.intent("C.png")))).toBeTruthy(); expect(native).toHaveLength(1);
});

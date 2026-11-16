import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS,
  WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS,
  WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS,
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerFeedbackHandler,
  type WebViewerFeedbackRequest,
  type WebViewerFeedbackResult,
  type WebViewerPageTarget,
  type WebViewerThreadList,
} from "../../src/web-viewer/feedback-contract";
import {
  WebViewerFeedbackService,
  createReadOnlyWebViewerFeedbackView,
} from "../../src/renderer/web-viewer/feedback-registry";
import { Plugin } from "../../src/renderer/plugin";

const pageTarget: WebViewerPageTarget = {
  url: "http://127.0.0.1:5173/dashboard",
  origin: "http://127.0.0.1:5173",
  title: "Dashboard",
};

const sampleScreenshotBytes = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes[8] = 0x42;
  return bytes;
};

const makeRequest = (over: Partial<WebViewerFeedbackRequest> = {}): WebViewerFeedbackRequest => ({
  contractVersion: 1,
  page: pageTarget,
  threadId: "thread-1",
  comment: "Fix button padding",
  selection: {
    schemaVersion: 1,
    selectionId: `sel_${"a".repeat(32)}`,
    viewSessionId: "wv-1",
    viewportPreset: "desktop",
    capturedAt: "2026-11-15T12:00:00.000Z",
    route: "/dashboard",
    tag: "button",
    selector: "#save",
    selectorAlternates: [],
    textAnchor: { tag: "button", text: "Save" },
    landmark: null,
    outerHTML: { html: '<button id="save">Save</button>', truncated: false },
    ancestors: [],
    computedStyles: { display: "inline-flex" },
    boundingBox: {
      viewport: { x: 10, y: 20, width: 100, height: 40 },
      document: { x: 10, y: 20, width: 100, height: 40 },
    },
    viewport: { width: 1440, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
    a11y: { role: "button", name: "Save", tabIndex: 0 },
  },
  screenshot: {
    mimeType: "image/png",
    bytes: sampleScreenshotBytes(),
    width: 116,
    height: 56,
    cssRect: { x: 2, y: 12, width: 116, height: 56 },
    devicePixelRatio: 2,
    downscaled: false,
  },
  screenshotOmitted: null,
  stale: false,
  submittedAt: "2026-11-15T12:00:01.000Z",
  ...over,
});

const ownerA = { pluginId: "agent-threads", displayName: "Claude Threads" };
const ownerB = { pluginId: "other-plugin", displayName: "Other Plugin" };

const defaultThreadList: WebViewerThreadList = {
  threads: [
    { id: "thread-1", title: "UI Polish", subtitle: "geode", active: true, busy: false, planMode: false },
  ],
  allowNewThread: true,
};

const acceptedSent: WebViewerFeedbackResult = {
  status: "accepted",
  delivery: "sent",
  threadId: "thread-1",
  message: "Sent to UI Polish.",
};

const makeHandler = (over: Partial<WebViewerFeedbackHandler> = {}): WebViewerFeedbackHandler => ({
  contractVersion: 1,
  listThreads: vi.fn(async () => defaultThreadList),
  submit: vi.fn(async () => acceptedSent),
  ...over,
});

class TestPlugin extends Plugin {
  onload(): void {}
}

const makePlugin = (service: WebViewerFeedbackService | undefined, id = "agent-threads", name = "Claude Threads") =>
  new TestPlugin(
    {
      webViewerFeedback: service ? createReadOnlyWebViewerFeedbackView(service) : undefined,
      webViewerFeedbackService: service,
    } as never,
    { id, name, version: "1.0.0", minAppVersion: "0.1.0" } as never,
  );

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe("contract constants and read-only facade", () => {
  it("exposes contract v1, 5 s thread timeout, 15 s submit timeout, and __new__ sentinel", () => {
    expect([...WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS]).toEqual([1]);
    expect(WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS).toBe(5_000);
    expect(WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS).toBe(15_000);
    expect(WEB_VIEWER_NEW_THREAD_ID).toBe("__new__");
  });

  it("exposes a frozen read-only view without register, listThreads, or submit", () => {
    const svc = new WebViewerFeedbackService();
    const view = createReadOnlyWebViewerFeedbackView(svc);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.contractVersions)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(["contractVersions", "has", "onDidChange"]);
    expect((view as unknown as Record<string, unknown>).register).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).listThreads).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).submit).toBeUndefined();
  });
});

describe("registration, conflict, and version validation", () => {
  it("registers, notifies listeners, prevents conflicts per pluginId, and disposes idempotently", () => {
    const svc = new WebViewerFeedbackService();
    const onChange = vi.fn();
    svc.onDidChange(() => {
      throw new Error("listener boom");
    });
    const unsubscribe = svc.onDidChange(onChange);

    expect(svc.has(pageTarget)).toBe(false);
    const reg = svc.register(ownerA, makeHandler());
    expect(reg.status).toBe("registered");
    expect(svc.has(pageTarget)).toBe(true);
    expect(svc.describeHandler(pageTarget)).toBe("Claude Threads");
    expect(onChange).toHaveBeenCalledTimes(1);

    const conflict = svc.register(ownerA, makeHandler());
    expect(conflict.status).toBe("conflict");
    conflict.dispose();
    expect(svc.has(pageTarget)).toBe(true);

    reg.dispose();
    expect(svc.has(pageTarget)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    reg.dispose();
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    svc.register(ownerB, makeHandler());
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported versions, missing methods, throwing handler getters, and disabled hosts", () => {
    const svc = new WebViewerFeedbackService();
    expect(svc.register(ownerA, { ...makeHandler(), contractVersion: 2 as never }).status).toBe("unsupported-version");
    expect(svc.register(ownerA, { contractVersion: 1, submit: async () => acceptedSent } as never).status).toBe("invalid");
    expect(svc.register(ownerA, { contractVersion: 1, listThreads: async () => defaultThreadList } as never).status).toBe("invalid");
    expect(svc.register(ownerA, null as never).status).toBe("invalid");
    const hostileHandler = Object.defineProperty(
      { listThreads: async () => defaultThreadList, submit: async () => acceptedSent },
      "contractVersion",
      { get() { throw new Error("getter"); } },
    );
    expect(svc.register(ownerA, hostileHandler as never).status).toBe("invalid");
    expect(new WebViewerFeedbackService({ enabled: false }).register(ownerA, makeHandler()).status).toBe("unavailable");
  });
});

describe("listThreads hardening, sanitization, and timeouts", () => {
  it("never executes hostile getters on top-level, array index, item own property, or prototype", async () => {
    const getterSpy = vi.fn(() => "boom");

    const svcTop = new WebViewerFeedbackService();
    const topTrap = { allowNewThread: true };
    Object.defineProperty(topTrap, "threads", { get: getterSpy, enumerable: true });
    svcTop.register(ownerA, makeHandler({ listThreads: async () => topTrap as never }));
    const resTop = await svcTop.listThreads(pageTarget);
    expect(resTop).toMatchObject({ status: "rejected", source: "invalid-result" });
    expect(getterSpy).not.toHaveBeenCalled();

    const svcIdx = new WebViewerFeedbackService();
    const arrTrap: unknown[] = [];
    Object.defineProperty(arrTrap, 0, { get: getterSpy, enumerable: true });
    svcIdx.register(ownerA, makeHandler({ listThreads: async () => ({ threads: arrTrap, allowNewThread: true }) as never }));
    const resIdx = await svcIdx.listThreads(pageTarget);
    expect(resIdx).toMatchObject({ status: "rejected", source: "invalid-result" });
    expect(getterSpy).not.toHaveBeenCalled();

    const svcItem = new WebViewerFeedbackService();
    const itemTrap = { id: "t-1", active: true, busy: false, planMode: false };
    Object.defineProperty(itemTrap, "title", { get: getterSpy, enumerable: true });
    svcItem.register(ownerA, makeHandler({ listThreads: async () => ({ threads: [itemTrap], allowNewThread: true }) as never }));
    const resItem = await svcItem.listThreads(pageTarget);
    expect(resItem).toMatchObject({ status: "rejected", source: "invalid-result" });
    expect(getterSpy).not.toHaveBeenCalled();

    const svcProto = new WebViewerFeedbackService();
    const proto = Object.defineProperty({}, "title", { get: getterSpy, enumerable: true });
    const inheritedItem = Object.assign(Object.create(proto), { id: "t-1", active: true, busy: false, planMode: false });
    svcProto.register(ownerA, makeHandler({ listThreads: async () => ({ threads: [inheritedItem], allowNewThread: true }) as never }));
    const resProto = await svcProto.listThreads(pageTarget);
    expect(resProto).toMatchObject({ status: "rejected", source: "invalid-result" });
    expect(getterSpy).not.toHaveBeenCalled();
  });

  it("strips C0/DEL and Unicode bidi controls, filters __new__/empty/duplicates, caps at 50, and freezes", async () => {
    const svc = new WebViewerFeedbackService();
    const many = Array.from({ length: 60 }, (_, idx) => ({
      id: `t-${idx + 2}`,
      title: `Thread ${idx + 2}`,
      active: false,
      busy: false,
      planMode: false,
    }));
    svc.register(
      ownerA,
      makeHandler({
        listThreads: async () => ({
          allowNewThread: true,
          threads: [
            { id: WEB_VIEWER_NEW_THREAD_ID, title: "Spoof new", active: false, busy: false, planMode: false },
            { id: "\u0000\u202e   ", title: "Empty id", active: false, busy: false, planMode: false },
            { id: "empty-title", title: "\u0007\u2066\u2069", active: false, busy: false, planMode: false },
            {
              id: "t-1\u0000\u200f",
              title: "Fix\u202eheader\u0007\nlayout\u2066!\u2069",
              subtitle: "geode\u061c-app\u007f\u200e",
              active: true,
              busy: true,
              planMode: true,
            },
            { id: "t-1", title: "Duplicate id", active: false, busy: false, planMode: false },
            ...many,
          ],
        }),
      }),
    );

    const outcome = await svc.listThreads(pageTarget);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(Object.isFrozen(outcome.value)).toBe(true);
    expect(Object.isFrozen(outcome.value.threads)).toBe(true);
    expect(outcome.value.threads).toHaveLength(50);
    expect(Object.isFrozen(outcome.value.threads[0])).toBe(true);
    expect(outcome.value.threads[0]).toEqual({
      id: "t-1",
      title: "Fixheader layout!",
      subtitle: "geode-app",
      active: true,
      busy: true,
      planMode: true,
    });
    expect(outcome.value.threads.some((t) => t.id === WEB_VIEWER_NEW_THREAD_ID)).toBe(false);
  });

  it("aborts listThreads after 5_000ms timeout and on registration dispose", async () => {
    vi.useFakeTimers();
    const svc = new WebViewerFeedbackService();
    let timeoutSignal!: AbortSignal;
    const reg = svc.register(
      ownerA,
      makeHandler({
        listThreads: (_target, ctx) => {
          timeoutSignal = ctx.signal;
          return new Promise(() => {});
        },
      }),
    );

    const pendingTimeout = svc.listThreads(pageTarget);
    await vi.advanceTimersByTimeAsync(WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS);
    expect(await pendingTimeout).toMatchObject({ status: "rejected", reason: "failed", source: "timeout" });
    expect(timeoutSignal.aborted).toBe(true);
    reg.dispose();

    let disposeSignal!: AbortSignal;
    const reg2 = svc.register(
      ownerA,
      makeHandler({
        listThreads: (_target, ctx) => {
          disposeSignal = ctx.signal;
          return new Promise(() => {});
        },
      }),
    );
    const pendingDispose = svc.listThreads(pageTarget);
    reg2.dispose();
    expect(await pendingDispose).toMatchObject({ status: "rejected", reason: "unavailable", source: "disposed" });
    expect(disposeSignal.aborted).toBe(true);
  });
});

describe("submit freezing, byte-slice retry safety, outcomes, and fault isolation", () => {
  it("freezes request and slices screenshot bytes per attempt so handler mutation cannot corrupt retries", async () => {
    const svc = new WebViewerFeedbackService();
    const seenBytes: number[][] = [];
    let attempt = 0;

    svc.register(
      ownerA,
      makeHandler({
        submit: async (req) => {
          attempt++;
          expect(Object.isFrozen(req)).toBe(true);
          expect(Object.isFrozen(req.page)).toBe(true);
          expect(Object.isFrozen(req.screenshot)).toBe(true);
          seenBytes.push(Array.from(req.screenshot!.bytes.slice(0, 9)));
          // Mutate the received Uint8Array in place to simulate transfer/zeroing
          req.screenshot!.bytes.fill(0);
          if (attempt === 1) {
            return { status: "rejected", reason: "busy", message: "Busy right now." };
          }
          return { status: "accepted", delivery: "queued", threadId: "thread-9", message: "Queued\u202e!" };
        },
      }),
    );

    const req = makeRequest();
    const originalHeader = Array.from(req.screenshot!.bytes.slice(0, 9));

    const first = await svc.submit(pageTarget, req);
    expect(first).toEqual({
      status: "rejected",
      reason: "busy",
      message: "Busy right now.",
      source: "handler",
    });

    const second = await svc.submit(pageTarget, req);
    expect(second).toEqual({
      status: "accepted",
      delivery: "queued",
      threadId: "thread-9",
      message: "Queued!",
      source: "handler",
    });
    expect(seenBytes).toEqual([originalHeader, originalHeader]);
    expect(Array.from(req.screenshot!.bytes.slice(0, 9))).toEqual(originalHeader);
  });

  it("validates sent/queued accepted results and rejects malformed submit responses", async () => {
    const svc = new WebViewerFeedbackService();
    let resultToReturn: unknown = { status: "accepted", delivery: "sent", threadId: "thread-1" };
    svc.register(ownerA, makeHandler({ submit: async () => resultToReturn as WebViewerFeedbackResult }));

    expect(await svc.submit(pageTarget, makeRequest())).toEqual({
      status: "accepted",
      delivery: "sent",
      threadId: "thread-1",
      source: "handler",
    });

    resultToReturn = { status: "accepted", delivery: "bogus", threadId: "thread-1" };
    expect(await svc.submit(pageTarget, makeRequest())).toMatchObject({
      status: "rejected",
      source: "invalid-result",
    });

    resultToReturn = { status: "accepted", delivery: "sent", threadId: "   " };
    expect(await svc.submit(pageTarget, makeRequest())).toMatchObject({
      status: "rejected",
      source: "invalid-result",
    });
  });

  it("aborts submit after 15_000ms timeout and on plugin unload without triggering plugin quarantine", async () => {
    vi.useFakeTimers();
    const svc = new WebViewerFeedbackService();
    const plugin = makePlugin(svc);
    const errorHandler = vi.fn();
    plugin.setErrorHandler(errorHandler);

    let submitSignal!: AbortSignal;
    const reg = plugin.registerWebViewerFeedbackHandler({
      contractVersion: 1,
      canHandle: () => {
        throw new Error("canHandle throw");
      },
      listThreads: async () => {
        throw new Error("listThreads throw");
      },
      submit: async () => {
        throw new Error("submit throw");
      },
    });
    expect(reg.status).toBe("registered");
    expect(svc.has(pageTarget)).toBe(false);
    reg.dispose();

    plugin.registerWebViewerFeedbackHandler({
      contractVersion: 1,
      listThreads: () => {
        throw new Error("sync listThreads throw");
      },
      submit: (_req, ctx) => {
        submitSignal = ctx.signal;
        return new Promise(() => {});
      },
    });

    const listRes = await svc.listThreads(pageTarget);
    expect(listRes).toMatchObject({ status: "rejected", source: "handler" });

    const submitTimedOut = svc.submit(pageTarget, makeRequest());
    await vi.advanceTimersByTimeAsync(WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS);
    expect(await submitTimedOut).toMatchObject({ status: "rejected", reason: "failed", source: "timeout" });
    expect(submitSignal.aborted).toBe(true);

    const submitUnloaded = svc.submit(pageTarget, makeRequest());
    await plugin.unloadAndWait();
    expect(await submitUnloaded).toMatchObject({ status: "rejected", reason: "unavailable", source: "disposed" });
    expect(errorHandler).not.toHaveBeenCalled();
  });
});

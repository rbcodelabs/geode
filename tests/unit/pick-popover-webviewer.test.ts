import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerElementSelection,
  type WebViewerThreadOption,
} from "../../src/web-viewer/feedback-contract";
import type { PickState } from "../../src/renderer/artifacts/pick-controller";
import type { WebViewerFeedbackOutcome } from "../../src/renderer/web-viewer/feedback-registry";
import type { WebViewerSelectionSnapshot } from "../../src/renderer/views/web-viewer-inspector-bridge";
import {
  PickPopover,
  formatWebViewerThreadOptionLabel,
  type PickPopoverWebViewerOptions,
} from "../../src/renderer/artifacts/pick-popover";

vi.setConfig({ testTimeout: 30_000 });

function makeWebSnapshot(origin = "http://127.0.0.1:5173", selectionId = "sel_" + "1".repeat(32)): WebViewerSelectionSnapshot {
  const selection: WebViewerElementSelection = {
    schemaVersion: 1,
    selectionId,
    viewSessionId: "wv-1",
    viewportPreset: "mobile",
    capturedAt: "2026-11-15T00:00:00.000Z",
    route: "/checkout",
    tag: "button",
    selector: "#pay-now",
    selectorAlternates: [".pay-cta"],
    textAnchor: { tag: "button", text: "Pay now" },
    landmark: "Order summary",
    outerHTML: { html: '<button id="pay-now">Pay now</button>', truncated: false },
    ancestors: [],
    computedStyles: { display: "flex" },
    boundingBox: {
      viewport: { x: 16, y: 120, width: 320, height: 44 },
      document: { x: 16, y: 120, width: 320, height: 44 },
    },
    viewport: { width: 390, height: 844, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
    a11y: { role: "button", name: "Pay now", tabIndex: 0 },
  };
  return {
    page: {
      url: `${origin}/checkout`,
      origin,
      title: "Checkout",
    },
    selection,
    screenshot: {
      mimeType: "image/png",
      bytes: new Uint8Array(1024),
      width: 100,
      height: 50,
      cssRect: { x: 8, y: 112, width: 336, height: 60 },
      devicePixelRatio: 2,
      downscaled: false,
    },
    screenshotOmitted: null,
  };
}

function makeBaseState(
  over: Partial<PickState<WebViewerSelectionSnapshot, WebViewerFeedbackOutcome>> = {},
): PickState<WebViewerSelectionSnapshot, WebViewerFeedbackOutcome> {
  return {
    phase: "popover",
    submit: "idle",
    action: "send",
    pinAvailable: false,
    snapshot: makeWebSnapshot(),
    comment: "Fix mobile button overflow",
    outcome: null,
    stale: false,
    handlerGone: false,
    elementGone: false,
    ...over,
  };
}

function mountWebPopover(wvOptions: PickPopoverWebViewerOptions = {}) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const callbacks = {
    onComment: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onDone: vi.fn(),
    onEscape: vi.fn(),
    onRepick: vi.fn(),
  };
  const onThreadChange = vi.fn(wvOptions.onThreadChange);
  const onRefreshThreads = vi.fn(wvOptions.onRefreshThreads);
  const popover = new PickPopover(doc, callbacks, {
    webViewer: { onThreadChange, onRefreshThreads },
  });
  doc.body.append(popover.el);
  const q = <T extends Element = HTMLElement>(sel: string) => popover.el.querySelector<T>(sel)!;
  return { dom, doc, popover, callbacks, onThreadChange, onRefreshThreads, q };
}

describe("PickPopover Web Viewer origin header and external badge", () => {
  it("shows External origin badge for https://preview.vercel.app and hides it for loopback origins", () => {
    const { popover, q } = mountWebPopover();

    popover.render(makeBaseState({ snapshot: makeWebSnapshot("https://preview.vercel.app", "sel_" + "a".repeat(32)) }), "Agent Threads");
    expect(q('[data-testid="pick-popover-origin"]').textContent).toBe("https://preview.vercel.app");
    expect(q('[data-testid="pick-popover-external-origin"]').hidden).toBe(false);
    expect(q('[data-testid="pick-popover-external-origin"]').textContent).toBe("External origin");

    for (const loopback of ["http://localhost:3000", "http://127.0.0.1:5173", "http://[::1]:8080"]) {
      popover.setOrigin(loopback);
      expect(q('[data-testid="pick-popover-origin"]').textContent).toBe(loopback);
      expect(q('[data-testid="pick-popover-external-origin"]').hidden).toBe(true);
    }
  });

  it("omits Web Viewer origin and thread controls when constructed in default Artifact mode", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const popover = new PickPopover(dom.window.document, {
      onComment: vi.fn(),
      onSend: vi.fn(),
      onCancel: vi.fn(),
      onDone: vi.fn(),
      onEscape: vi.fn(),
      onRepick: vi.fn(),
    });
    expect(popover.el.querySelector('[data-testid="pick-popover-origin-row"]')).toBeNull();
    expect(popover.el.querySelector('[data-testid="pick-popover-thread-select"]')).toBeNull();
    expect(popover.el.querySelector('[data-testid="pick-popover-thread-refresh"]')).toBeNull();
  });
});

describe("PickPopover Web Viewer thread switcher and readiness gates", () => {
  it("formats Active, Busy — will queue, [Plan], subtitle, and + New thread labels cleanly", () => {
    const { popover, q } = mountWebPopover();
    const threads: WebViewerThreadOption[] = [
      {
        id: "t-idle",
        title: "Refactor CSS",
        subtitle: "threads-design",
        active: false,
        busy: false,
        planMode: false,
      },
      {
        id: "t-active-busy-plan",
        title: "Build landing page",
        subtitle: "marketing",
        active: true,
        busy: true,
        planMode: true,
      },
    ];

    expect(formatWebViewerThreadOptionLabel(threads[1]!)).toBe(
      "Build landing page · marketing (Active) (Busy — will queue) [Plan]",
    );

    popover.render(makeBaseState(), "Agent Threads");
    // Before listThreads resolves, Send is disabled and status reports loading
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    expect(q(".pick-popover-status").textContent).toContain("Loading threads");

    popover.setThreadListState({
      status: "ready",
      list: { threads, allowNewThread: true },
    });

    const select = q<HTMLSelectElement>('[data-testid="pick-popover-thread-select"]');
    const optionTexts = Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent }));
    expect(optionTexts).toEqual([
      { value: "t-idle", text: "Refactor CSS · threads-design" },
      { value: "t-active-busy-plan", text: "Build landing page · marketing (Active) (Busy — will queue) [Plan]" },
      { value: WEB_VIEWER_NEW_THREAD_ID, text: "+ New thread" },
    ]);

    // Defaults to active thread ("t-active-busy-plan") and enables Send
    expect(popover.getSelectedThreadId()).toBe("t-active-busy-plan");
    expect(select.value).toBe("t-active-busy-plan");
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(false);
  });

  it("preserves manual selection across refresh, falls back to threads[0] then __new__, and disables Send when empty", () => {
    const { dom, popover, onThreadChange, onRefreshThreads, q } = mountWebPopover();
    popover.render(makeBaseState(), "Agent Threads");

    // Fallback to threads[0] when none is active
    popover.setThreadListState({
      status: "ready",
      list: {
        threads: [
          { id: "t-1", title: "First", active: false, busy: false, planMode: false },
          { id: "t-2", title: "Second", active: false, busy: false, planMode: false },
        ],
        allowNewThread: true,
      },
    });
    expect(popover.getSelectedThreadId()).toBe("t-1");

    // User manually picks "t-2"
    const select = q<HTMLSelectElement>('[data-testid="pick-popover-thread-select"]');
    select.value = "t-2";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(popover.getSelectedThreadId()).toBe("t-2");
    expect(onThreadChange).toHaveBeenLastCalledWith("t-2");

    // Clicking Refresh fires callback; loading without reset keeps current selection & Send enabled
    q<HTMLButtonElement>('[data-testid="pick-popover-thread-refresh"]').click();
    expect(onRefreshThreads).toHaveBeenCalledTimes(1);
    popover.setThreadListState({ status: "loading" });
    expect(popover.getSelectedThreadId()).toBe("t-2");
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(false);

    // Refresh completes with t-1 now active, but manual choice "t-2" is still present -> preserved!
    popover.setThreadListState({
      status: "ready",
      list: {
        threads: [
          { id: "t-1", title: "First", active: true, busy: false, planMode: false },
          { id: "t-2", title: "Second", active: false, busy: false, planMode: false },
        ],
        allowNewThread: true,
      },
    });
    expect(popover.getSelectedThreadId()).toBe("t-2");

    // When threads is empty and allowNewThread is true, defaults to "__new__"
    popover.setThreadListState({
      status: "ready",
      list: { threads: [], allowNewThread: true },
    });
    expect(popover.getSelectedThreadId()).toBe(WEB_VIEWER_NEW_THREAD_ID);
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(false);

    // When neither a thread nor allowNewThread is available, disables Send with plugin-neutral status message
    popover.render(makeBaseState(), "Custom Reviewer");
    popover.setThreadListState({
      status: "ready",
      list: { threads: [], allowNewThread: false },
    });
    expect(popover.getSelectedThreadId()).toBeNull();
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    expect(q(".pick-popover-status").textContent).toBe(
      "No target threads are available. Open or allow a new thread in Custom Reviewer, then refresh.",
    );

    popover.render(makeBaseState(), "");
    expect(q(".pick-popover-status").textContent).toBe(
      "No target threads are available. Open or allow a new thread in the feedback plugin, then refresh.",
    );
  });

  it("renders hostile XSS strings in origin and thread labels literally via textContent and supports queued outcome", () => {
    const { popover, q } = mountWebPopover();
    const xssOrigin = 'https://evil.example"><img src=x onerror=alert(1)>';
    const xssTitle = '<script>window.__pwned = true</script> Fix header';
    const xssSubtitle = '<svg onload="alert(2)">repo</svg>';

    popover.render(makeBaseState(), "Agent Threads");
    popover.setOrigin(xssOrigin);
    popover.setThreadListState({
      status: "ready",
      list: {
        threads: [
          {
            id: "t-xss",
            title: xssTitle,
            subtitle: xssSubtitle,
            active: true,
            busy: true,
            planMode: false,
          },
        ],
        allowNewThread: false,
      },
    });

    expect(popover.el.querySelector("script")).toBeNull();
    expect(popover.el.querySelector("img")).toBeNull();
    expect(q('[data-testid="pick-popover-origin"]').textContent).toBe(xssOrigin);
    const select = q<HTMLSelectElement>('[data-testid="pick-popover-thread-select"]');
    expect(select.options[0]!.textContent).toContain(xssTitle);
    expect(select.options[0]!.textContent).toContain(xssSubtitle);

    // Queued outcome without explicit message renders "Queued for thread."
    popover.render(
      makeBaseState({
        submit: "accepted",
        outcome: {
          status: "accepted",
          delivery: "queued",
          threadId: "t-xss",
          source: "handler",
        },
      }),
      "Agent Threads",
    );
    expect(q(".pick-popover-status").textContent).toBe("Queued for thread.");
  });
});

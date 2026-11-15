import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL } from "../../src/artifacts/inspector-protocol";
import {
  WebViewerFeedbackService,
  createReadOnlyWebViewerFeedbackView,
} from "../../src/renderer/web-viewer/feedback-registry";
import { WebView, parseHttpPageUrl } from "../../src/renderer/views/web-view";
import type { App } from "../../src/renderer/app";
import type { WorkspaceLeaf } from "../../src/renderer/workspace";

describe("parseHttpPageUrl", () => {
  it("accepts committed http: and https: URLs within 2048 units and extracts RFC 6454 origin", () => {
    expect(parseHttpPageUrl("http://127.0.0.1:5173/pricing?plan=pro#cta")).toEqual({
      url: "http://127.0.0.1:5173/pricing?plan=pro#cta",
      origin: "http://127.0.0.1:5173",
    });
    expect(parseHttpPageUrl("https://preview.vercel.app")).toEqual({
      url: "https://preview.vercel.app/",
      origin: "https://preview.vercel.app",
    });
  });

  it("rejects non-HTTP(S) schemes, malformed URLs, empty strings, and >2048-unit URLs", () => {
    expect(parseHttpPageUrl("")).toBeNull();
    expect(parseHttpPageUrl("about:blank")).toBeNull();
    expect(parseHttpPageUrl("file:///Users/demo/index.html")).toBeNull();
    expect(parseHttpPageUrl("data:text/html,<h1>hi</h1>")).toBeNull();
    expect(parseHttpPageUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpPageUrl("blob:http://127.0.0.1:5173/uuid")).toBeNull();
    expect(parseHttpPageUrl("not a url")).toBeNull();
    expect(parseHttpPageUrl("https://example.com/" + "a".repeat(2040))).toBeNull();
  });
});

describe("WebView committedHealthyUrl, subframe guards, reload clear, and split-pane keydown ownership", () => {
  let dom: JSDOM;
  const savedGlobals: Record<string, unknown> = {};

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/",
    });
    for (const key of [
      "window",
      "document",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
      "KeyboardEvent",
      "Event",
    ] as const) {
      savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedGlobals)) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
    dom.window.close();
  });

  function createHarness() {
    const service = new WebViewerFeedbackService({ enabled: true });
    service.register(
      { pluginId: "test-feedback", displayName: "Test Feedback" },
      {
        contractVersion: 1,
        listThreads: async () => ({ threads: [], allowNewThread: true }),
        submit: async () => ({ status: "accepted", delivery: "sent", threadId: "t-1" }),
      },
    );

    let activeLeaf: WorkspaceLeaf | null = null;
    const appStub = {
      webViewerFeedbackService: service,
      webViewerFeedback: createReadOnlyWebViewerFeedbackView(service),
      settings: { webViewer: { searchEngine: "https://duckduckgo.com/?q=" } },
      actions: { execute: vi.fn() },
      showMenu: vi.fn(),
      webPageMenuItems: vi.fn(() => []),
      workspace: {
        get activeLeaf() {
          return activeLeaf;
        },
        trigger: vi.fn(),
        on: vi.fn(() => () => {}),
      },
    } as unknown as App;

    const mountPane = () => {
      const leafStub = {
        setPersistedState: vi.fn(),
        updateHeader: vi.fn(),
        detach: vi.fn(async () => {}),
      } as unknown as WorkspaceLeaf;

      const view = new WebView(appStub, leafStub);
      dom.window.document.body.appendChild(view.containerEl);
      // JSDOM returns empty getClientRects() unless stubbed on visible containers
      view.containerEl.getClientRects = () =>
        [{ left: 0, top: 0, width: 800, height: 600 }] as unknown as DOMRectList;

      const webviewEl = view.containerEl.querySelector("webview") as HTMLElement & {
        liveUrl: string;
        sentMessages: Array<{ channel: string; args: unknown[] }>;
        reloadCalls: number;
        getURL(): string;
        getTitle(): string;
        canGoBack(): boolean;
        canGoForward(): boolean;
        clearHistory(): void;
        loadURL(u: string): Promise<void>;
        reload(): void;
        send(channel: string, ...args: unknown[]): void;
      };
      webviewEl.liveUrl = "about:blank";
      webviewEl.sentMessages = [];
      webviewEl.reloadCalls = 0;
      webviewEl.getURL = () => webviewEl.liveUrl;
      webviewEl.getTitle = () => "Main App";
      webviewEl.canGoBack = () => false;
      webviewEl.canGoForward = () => false;
      webviewEl.clearHistory = () => {};
      webviewEl.loadURL = async (u: string) => {
        webviewEl.liveUrl = u;
      };
      webviewEl.reload = () => {
        webviewEl.reloadCalls += 1;
      };
      webviewEl.send = (channel: string, ...args: unknown[]) => {
        webviewEl.sentMessages.push({ channel, args });
      };

      const dispatchWebviewEvent = (type: string, props: Record<string, unknown>) => {
        const ev = new dom.window.Event(type);
        Object.assign(ev, props);
        webviewEl.dispatchEvent(ev);
      };

      return { view, leafStub, webviewEl, dispatchWebviewEvent };
    };

    return {
      service,
      setActiveLeaf: (leaf: WorkspaceLeaf | null) => {
        activeLeaf = leaf;
      },
      mountPane,
    };
  }

  it("ignores subframe navigation/failure events and synchronously clears committedHealthyUrl on reload()", () => {
    const { mountPane, setActiveLeaf } = createHarness();
    const { view, leafStub, webviewEl, dispatchWebviewEvent } = mountPane();
    setActiveLeaf(leafStub);

    // Initially on about:blank -> unavailable
    expect(view.getHealthyPageTarget()).toBeNull();
    expect(view.canTogglePick()).toBe(false);

    // Commit main-frame HTTP URL
    webviewEl.liveUrl = "http://127.0.0.1:5173/dashboard";
    dispatchWebviewEvent("did-navigate", {
      url: "http://127.0.0.1:5173/dashboard",
      isMainFrame: true,
    });
    expect(view.getHealthyPageTarget()).toEqual({
      url: "http://127.0.0.1:5173/dashboard",
      origin: "http://127.0.0.1:5173",
      title: "Main App",
    });
    expect(view.canTogglePick()).toBe(true);

    // Enter Pick mode
    view.togglePick("pointer");
    const pickBtn = view.containerEl.querySelector<HTMLButtonElement>('[data-testid="web-view-pick-btn"]')!;
    expect(pickBtn.getAttribute("aria-pressed")).toBe("true");

    // Subframe events (isMainFrame: false) must NEVER clear or overwrite committedHealthyUrl or exit Pick mode
    dispatchWebviewEvent("did-start-navigation", {
      url: "https://ads.example/iframe",
      isInPlace: false,
      isMainFrame: false,
    });
    dispatchWebviewEvent("did-navigate", {
      url: "https://ads.example/iframe",
      isMainFrame: false,
    });
    dispatchWebviewEvent("did-navigate-in-page", {
      url: "https://ads.example/iframe#hash",
      isMainFrame: false,
    });
    dispatchWebviewEvent("did-fail-load", {
      errorCode: -105,
      errorDescription: "ERR_NAME_NOT_RESOLVED",
      validatedURL: "https://ads.example/iframe",
      isMainFrame: false,
    });

    expect(view.getHealthyPageTarget()).toEqual({
      url: "http://127.0.0.1:5173/dashboard",
      origin: "http://127.0.0.1:5173",
      title: "Main App",
    });
    expect(pickBtn.getAttribute("aria-pressed")).toBe("true");

    // Synchronous reload() immediately clears committedHealthyUrl and exits Pick mode before webview.reload()
    view.reload();
    expect(webviewEl.reloadCalls).toBe(1);
    expect(view.getHealthyPageTarget()).toBeNull();
    expect(view.canTogglePick()).toBe(false);
    expect(pickBtn.getAttribute("aria-pressed")).toBe("false");

    view.onClose();
  });

  it("routes window Escape and [ / ] keys only to the focused or active split Web Viewer pane", () => {
    const { mountPane, setActiveLeaf } = createHarness();
    const paneA = mountPane();
    const paneB = mountPane();

    for (const [pane, port] of [
      [paneA, 3001],
      [paneB, 3002],
    ] as const) {
      const url = `http://127.0.0.1:${port}/`;
      pane.webviewEl.liveUrl = url;
      pane.dispatchWebviewEvent("did-navigate", { url, isMainFrame: true });
      pane.view.togglePick("pointer");
    }

    const pickBtnA = paneA.view.containerEl.querySelector<HTMLButtonElement>('[data-testid="web-view-pick-btn"]')!;
    const pickBtnB = paneB.view.containerEl.querySelector<HTMLButtonElement>('[data-testid="web-view-pick-btn"]')!;
    expect(pickBtnA.getAttribute("aria-pressed")).toBe("true");
    expect(pickBtnB.getAttribute("aria-pressed")).toBe("true");

    // Make paneB the active leaf (with neutral body focus) -> "[" walks only paneB, Escape exits only paneB
    setActiveLeaf(paneB.leafStub);
    paneA.webviewEl.sentMessages.length = 0;
    paneB.webviewEl.sentMessages.length = 0;

    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "[", bubbles: true }));
    expect(paneA.webviewEl.sentMessages.filter((m) => m.channel === INSPECT_CHANNEL.key)).toHaveLength(0);
    expect(paneB.webviewEl.sentMessages.filter((m) => m.channel === INSPECT_CHANNEL.key)).toEqual([
      { channel: INSPECT_CHANNEL.key, args: [{ key: "parent" }] },
    ]);

    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pickBtnB.getAttribute("aria-pressed")).toBe("false");
    expect(pickBtnA.getAttribute("aria-pressed")).toBe("true");

    // Re-enter pick on paneB, keep activeLeaf = paneB, but focus pickBtnA inside paneA -> paneA owns the key!
    paneB.view.togglePick("pointer");
    pickBtnA.focus();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pickBtnA.getAttribute("aria-pressed")).toBe("false");
    expect(pickBtnB.getAttribute("aria-pressed")).toBe("true");

    paneA.view.onClose();
    paneB.view.onClose();
  });
});

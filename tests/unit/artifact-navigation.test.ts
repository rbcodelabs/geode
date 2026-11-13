import { describe, expect, it, vi } from "vitest";
import { ArtifactNavigation, leavesPage, type NavigationState, type NavigationWebview } from "../../src/renderer/artifacts/artifact-navigation";

/** Back / forward / home for an artifact tab: a pure controller over the guest webview's own navigation history. */

const ENTRY = "geode-artifact://pricing/index.html";
const SUB = "geode-artifact://pricing/variations/A/index.html";

/** A webview double with a real history list, so back / forward / loadURL behave like the guest. */
function fakeWebview(options: { ready?: boolean } = {}) {
  const target = new EventTarget();
  const history = [ENTRY];
  let index = 0;
  let ready = options.ready ?? true;
  const view: NavigationWebview & { go(url: string): void; becomeReady(): void; loadURL: ReturnType<typeof vi.fn> } = {
    canGoBack: () => { if (!ready) throw new Error("dom-ready has not fired"); return index > 0; },
    canGoForward: () => { if (!ready) throw new Error("dom-ready has not fired"); return index < history.length - 1; },
    goBack: vi.fn(() => { if (index > 0) { index--; target.dispatchEvent(new Event("did-navigate")); } }),
    goForward: vi.fn(() => { if (index < history.length - 1) { index++; target.dispatchEvent(new Event("did-navigate")); } }),
    loadURL: vi.fn(async (url: string) => { view.go(url); }),
    getURL: () => { if (!ready) throw new Error("dom-ready has not fired"); return history[index]!; },
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    go(url: string) { history.splice(index + 1); history.push(url); index++; target.dispatchEvent(new Event("did-navigate")); },
    becomeReady() { ready = true; target.dispatchEvent(new Event("dom-ready")); },
  };
  return { view, target };
}

function rig(options: { ready?: boolean; entry?: string } = {}) {
  const { view, target } = fakeWebview(options);
  const states: NavigationState[] = [];
  const nav = new ArtifactNavigation(view, options.entry ?? ENTRY, (state) => states.push(state));
  return { view, target, nav, states };
}

describe("ArtifactNavigation state", () => {
  it("starts on the entry page with nothing to go back or forward to, and home disabled", () => {
    const { nav } = rig();
    expect(nav.state).toEqual({ canGoBack: false, canGoForward: false, canGoHome: false, url: ENTRY });
  });

  it("after clicking into a sub-page: back and home are enabled, forward is not", () => {
    const { nav, view } = rig();
    view.go(SUB);
    expect(nav.state).toEqual({ canGoBack: true, canGoForward: false, canGoHome: true, url: SUB });
  });

  it("after going back: forward is enabled, back and home are disabled again", () => {
    const { nav, view } = rig();
    view.go(SUB);
    nav.back();
    expect(nav.state).toEqual({ canGoBack: false, canGoForward: true, canGoHome: false, url: ENTRY });
  });

  it("forward returns to the sub-page", () => {
    const { nav, view } = rig();
    view.go(SUB);
    nav.back();
    nav.forward();
    expect(nav.state.url).toBe(SUB);
    expect(nav.state.canGoForward).toBe(false);
  });

  it("notifies the owner on every change, and only when the state actually changed", () => {
    const { view, states } = rig();
    view.go(SUB);
    expect(states.at(-1)).toMatchObject({ canGoBack: true, url: SUB });
    const before = states.length;
    view.go(SUB + "?same=1");
    view.go(SUB); // different url, same booleans: still a change (the url is part of the state)
    expect(states.length).toBeGreaterThan(before);
  });

  it("reports everything disabled while the guest has not fired dom-ready (the webview methods throw), then recovers", () => {
    const { nav, view, states } = rig({ ready: false });
    expect(nav.state).toEqual({ canGoBack: false, canGoForward: false, canGoHome: false, url: ENTRY });
    view.becomeReady();
    expect(states).toEqual([]); // dom-ready on an unchanged page is not a change
    view.go(SUB);
    expect(nav.state.canGoBack).toBe(true);
  });

  it("a hash change on the entry page is not 'home' (the entry itself) but home is still offered to drop the hash", () => {
    const { nav, view } = rig();
    view.go(ENTRY + "#pricing");
    expect(nav.state.canGoHome).toBe(true);
  });

  it("matches the entry URL after normalisation (a bare dev-server origin and its trailing-slash form are the same page)", () => {
    const { nav, view } = rig({ entry: "http://localhost:3000" });
    view.go("http://localhost:3000/");
    expect(nav.state.canGoHome).toBe(false);
  });
});

describe("ArtifactNavigation commands", () => {
  it("back and forward do nothing when there is nowhere to go (no guest call, returns false)", () => {
    const { nav, view } = rig();
    expect(nav.back()).toBe(false);
    expect(nav.forward()).toBe(false);
    expect(view.goBack).not.toHaveBeenCalled();
    expect(view.goForward).not.toHaveBeenCalled();
  });

  it("home loads the registered entry URL, never anything else", () => {
    const { nav, view } = rig();
    view.go(SUB);
    expect(nav.home()).toBe(true);
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(view.loadURL).toHaveBeenCalledWith(ENTRY);
    expect(nav.state.canGoHome).toBe(false);
    // home is itself a navigation: back returns to the page the user left
    expect(nav.state.canGoBack).toBe(true);
  });

  it("home is a no-op on the entry page", () => {
    const { nav, view } = rig();
    expect(nav.home()).toBe(false);
    expect(view.loadURL).not.toHaveBeenCalled();
  });

  it("a superseded or failed home load is swallowed (ERR_ABORTED is not an error here)", async () => {
    const { nav, view } = rig();
    view.go(SUB);
    view.loadURL.mockRejectedValueOnce(new Error("ERR_ABORTED (-3)"));
    expect(() => nav.home()).not.toThrow();
    await Promise.resolve();
  });
});

describe("ArtifactNavigation lifecycle", () => {
  it("dispose detaches every listener: later navigation changes nothing and notifies nobody", () => {
    const { nav, view, states } = rig();
    nav.dispose();
    const count = states.length;
    view.go(SUB);
    expect(states.length).toBe(count);
    expect(nav.back()).toBe(false);
    expect(nav.home()).toBe(false);
  });

  it("a fresh controller for a re-previewed artifact starts from a clean history, independent of the old one", () => {
    const first = rig();
    first.view.go(SUB);
    first.nav.dispose();
    const second = rig();
    expect(second.nav.state).toEqual({ canGoBack: false, canGoForward: false, canGoHome: false, url: ENTRY });
  });
});

/**
 * A reload (the live-reload that follows an edit of the artifact's own files) starts a navigation to the page the guest is
 * already on. It is not leaving that page, so what was resolved on it (the pins) must stay drawn rather than be dropped and
 * rebuilt, which would also drop the keyboard focus of a focused badge.
 */
describe("leavesPage", () => {
  it("is false for a reload of the current page", () => {
    expect(leavesPage(SUB, SUB)).toBe(false);
  });
  it("ignores the hash and trailing-slash spelling of the same page", () => {
    expect(leavesPage(`${SUB}#plans`, SUB)).toBe(false);
    expect(leavesPage("http://localhost:3000", "http://localhost:3000/")).toBe(false);
  });
  it("is true for another page, including the board and a different query", () => {
    expect(leavesPage(ENTRY, SUB)).toBe(true);
    expect(leavesPage(SUB, ENTRY)).toBe(true);
    expect(leavesPage(`${SUB}?v=1`, `${SUB}?v=2`)).toBe(true);
  });
  it("is true when either side is unknown, so a doubtful case drops pins as before rather than showing stale ones", () => {
    expect(leavesPage("", SUB)).toBe(true);
    expect(leavesPage(SUB, "")).toBe(true);
  });
});

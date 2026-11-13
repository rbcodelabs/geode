import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { PickState } from "../../src/renderer/artifacts/pick-controller";
import { PickPopover } from "../../src/renderer/artifacts/pick-popover";

vi.setConfig({ testTimeout: 30_000 });

const snapshot = {
  selection: {
    schemaVersion: 1, selectionId: "sel_" + "a".repeat(32), artifactId: "demo", artifactRevision: 1, viewSessionId: "reg", viewportPreset: "fill",
    capturedAt: "2026-11-08T00:00:00.000Z", redacted: false, route: "/index.html", tag: "button", selector: "#buy", selectorAlternates: [],
    textAnchor: { tag: "button", text: "Buy" }, landmark: null, outerHTML: { html: "<button>Buy</button>", truncated: false }, ancestors: [],
    computedStyles: {}, boundingBox: { viewport: { x: 1, y: 2, width: 3, height: 4 }, document: { x: 1, y: 2, width: 3, height: 4 } },
    viewport: { width: 1, height: 1, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, a11y: { role: "button", name: "Buy", tabIndex: 0 },
  },
  screenshot: null, screenshotOmitted: "vault-read",
} as never;
const base: PickState = { phase: "popover", submit: "idle", action: "send", pinAvailable: true, snapshot, comment: "hello", outcome: null, stale: false, handlerGone: false, elementGone: false };

function mount() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const cb = { onComment: vi.fn(), onSend: vi.fn(), onPin: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(), onEscape: vi.fn(), onRepick: vi.fn() };
  const popover = new PickPopover(doc, cb);
  doc.body.append(popover.el);
  const q = <T extends HTMLElement = HTMLButtonElement>(sel: string) => popover.el.querySelector<T>(sel)!;
  const key = (init: KeyboardEventInit) => q<HTMLTextAreaElement>(".pick-popover-comment").dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  return { popover, cb, q, key, doc };
}

describe("popover Pin action (design 3.7)", () => {
  it("shows a Pin button in tab order between Send and Cancel", () => {
    const { popover, q } = mount();
    popover.render(base, "Design");
    const order = [...popover.el.querySelectorAll("button")].map((b) => b.className.split(" ").find((c) => /^pick-popover-(send|pin|cancel)$/.test(c)));
    expect(order.filter(Boolean)).toEqual(["pick-popover-send", "pick-popover-pin", "pick-popover-cancel"]);
    expect(q(".pick-popover-pin").hidden).toBe(false);
    expect(q(".pick-popover-pin").textContent).toBe("Pin");
  });

  it("hides Pin when the routed handler cannot pin (v1) and when accepted", () => {
    const { popover, q } = mount();
    popover.render({ ...base, pinAvailable: false }, "Design");
    expect(q(".pick-popover-pin").hidden).toBe(true);
    popover.render({ ...base, submit: "accepted", action: "pin", outcome: { status: "accepted", message: "Pinned.", source: "handler" } }, "Design");
    expect(q(".pick-popover-pin").hidden).toBe(true);
  });

  it("disables Pin for an empty comment, while pending, when gone", () => {
    const { popover, q } = mount();
    popover.render({ ...base, comment: "  " }, "Design");
    expect(q(".pick-popover-pin").disabled).toBe(true);
    popover.render({ ...base, submit: "pending", action: "pin" }, "Design");
    expect(q(".pick-popover-pin").disabled).toBe(true);
    expect(q(".pick-popover-pin").textContent).toBe("Pinning…");
    popover.render({ ...base, handlerGone: true }, "Design");
    expect(q(".pick-popover-pin").disabled).toBe(true);
  });

  it("labels Retry on the action that failed", () => {
    const { popover, q } = mount();
    const outcome = { status: "rejected", reason: "failed", message: "no", source: "handler" } as const;
    popover.render({ ...base, submit: "rejected", action: "pin", outcome }, "Design");
    expect(q(".pick-popover-pin").textContent).toBe("Retry pin");
    expect(q(".pick-popover-send").textContent).toBe("Send");
    popover.render({ ...base, submit: "rejected", action: "send", outcome }, "Design");
    expect(q(".pick-popover-send").textContent).toBe("Retry");
    expect(q(".pick-popover-pin").textContent).toBe("Pin");
  });

  it("click calls onPin; Cmd/Ctrl+Shift+Enter pins; Cmd/Ctrl+Enter still sends", () => {
    const { popover, cb, q, key } = mount();
    popover.render(base, "Design");
    q(".pick-popover-pin").click();
    expect(cb.onPin).toHaveBeenCalledTimes(1);
    key({ key: "Enter", metaKey: true, shiftKey: true });
    key({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(cb.onPin).toHaveBeenCalledTimes(3);
    expect(cb.onSend).not.toHaveBeenCalled();
    key({ key: "Enter", metaKey: true });
    key({ key: "Enter", ctrlKey: true });
    expect(cb.onSend).toHaveBeenCalledTimes(2);
    expect(cb.onPin).toHaveBeenCalledTimes(3);
  });

  it("the shortcut is a no-op when Pin is hidden or disabled", () => {
    const { popover, cb, key } = mount();
    popover.render({ ...base, pinAvailable: false }, "Design");
    key({ key: "Enter", metaKey: true, shiftKey: true });
    popover.render({ ...base, comment: "" }, "Design");
    key({ key: "Enter", metaKey: true, shiftKey: true });
    expect(cb.onPin).not.toHaveBeenCalled();
  });

  it("owns Mod+Shift+Enter inside the popover: the app's document-level hotkey (toggle focus pane) does not also fire", () => {
    const { popover, cb, key, doc } = mount();
    popover.render(base, "Design");
    const appHotkey = vi.fn();
    doc.addEventListener("keydown", appHotkey, true); // what CommandRegistry.attach does
    key({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(cb.onPin).toHaveBeenCalledTimes(1);
    expect(appHotkey).not.toHaveBeenCalled();
    // outside the popover the combo is the app's, untouched
    doc.body.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(appHotkey).toHaveBeenCalledTimes(1);
    expect(cb.onPin).toHaveBeenCalledTimes(1);
  });

  it("dispose releases the window listener", () => {
    const { popover, cb, key } = mount();
    popover.render(base, "Design");
    popover.dispose();
    key({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(cb.onPin).not.toHaveBeenCalled();
  });

  it("words the status for a pin", () => {
    const { popover, q } = mount();
    popover.render({ ...base, submit: "pending", action: "pin" }, "Design");
    expect(q(".pick-popover-status").textContent).toBe("Pinning to Design…");
    popover.render({ ...base, submit: "accepted", action: "pin", outcome: { status: "accepted", message: "Pinned as comment 3.", source: "handler" } }, "Design");
    expect(q(".pick-popover-status").textContent).toBe("Pinned as comment 3.");
  });
});

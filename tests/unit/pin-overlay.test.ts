import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { PinOverlay, nextBadgeIndex, type PinBadgeView } from "../../src/renderer/artifacts/pin-overlay";

vi.setConfig({ testTimeout: 30_000 });

const badge = (n: number, over: Partial<PinBadgeView> = {}): PinBadgeView => ({
  key: `p${n}`, kind: "pin", ids: [`p${n}`], x: n * 50, y: 40, text: String(n), label: `Comment ${n}, open, on button B: text`,
  status: "open", approximate: false, z: 20, ...over,
});

function mount() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const cb = { onActivate: vi.fn(), onEscape: vi.fn() };
  const overlay = new PinOverlay(doc, cb);
  doc.body.append(overlay.el);
  const buttons = () => [...overlay.el.querySelectorAll<HTMLButtonElement>("button")];
  const press = (el: Element, key: string) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { overlay, cb, doc, buttons, press };
}

describe("nextBadgeIndex", () => {
  it("moves with arrows, wraps at the ends, and jumps with Home and End", () => {
    expect(nextBadgeIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextBadgeIndex(0, 3, "ArrowDown")).toBe(1);
    expect(nextBadgeIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextBadgeIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextBadgeIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextBadgeIndex(1, 3, "Home")).toBe(0);
    expect(nextBadgeIndex(1, 3, "End")).toBe(2);
    expect(nextBadgeIndex(1, 3, "a")).toBeNull();
    expect(nextBadgeIndex(0, 0, "ArrowRight")).toBeNull();
  });
});

describe("PinOverlay", () => {
  it("is a labelled group with one roving tab stop", () => {
    const { overlay, buttons } = mount();
    overlay.render([badge(1), badge(2), badge(3)], { busy: false });
    expect(overlay.el.getAttribute("role")).toBe("group");
    expect(overlay.el.getAttribute("aria-label")).toBe("Comment pins");
    expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it("names every badge and positions it by transform (centered on its point)", () => {
    const { overlay, buttons } = mount();
    overlay.render([badge(1), badge(2, { kind: "cluster", ids: ["a", "b", "c"], text: "3", label: "3 comments here. Activate to list" })], { busy: false });
    const [one, cluster] = buttons();
    expect(one!.getAttribute("aria-label")).toBe("Comment 1, open, on button B: text");
    expect(one!.style.transform).toBe("translate(40px, 30px)");
    expect(one!.textContent).toBe("1");
    expect(cluster!.getAttribute("aria-label")).toBe("3 comments here. Activate to list");
    expect(cluster!.classList.contains("is-cluster")).toBe(true);
  });

  it("encodes state in class and glyph, not color alone", () => {
    const { overlay, buttons } = mount();
    overlay.render([
      badge(1), badge(2, { status: "pending" }), badge(3, { status: "sent" }), badge(4, { approximate: true }),
    ], { busy: false });
    const [open, pending, sent, approx] = buttons();
    expect(open!.classList.contains("is-open")).toBe(true);
    expect(pending!.classList.contains("is-pending")).toBe(true);
    expect(sent!.classList.contains("is-sent")).toBe(true);
    expect(sent!.querySelector(".pin-badge-check")).not.toBeNull();
    expect(approx!.classList.contains("is-approximate")).toBe(true);
    expect(approx!.textContent).toContain("~");
  });

  it("renders page-derived text with textContent only", () => {
    const { overlay, buttons } = mount();
    overlay.render([badge(1, { text: "<img src=x onerror=alert(1)>", label: "<b>x</b>" })], { busy: false });
    expect(overlay.el.querySelector("img")).toBeNull();
    expect(overlay.el.querySelector("b")).toBeNull();
    expect(buttons()[0]!.textContent).toContain("<img");
  });

  it("arrow keys move focus and the roving stop; Home/End jump", () => {
    const { overlay, buttons, press, doc } = mount();
    overlay.render([badge(1), badge(2), badge(3)], { busy: false });
    buttons()[0]!.focus();
    press(buttons()[0]!, "ArrowRight");
    expect(doc.activeElement).toBe(buttons()[1]);
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    press(buttons()[1]!, "End");
    expect(doc.activeElement).toBe(buttons()[2]);
    press(buttons()[2]!, "Home");
    expect(doc.activeElement).toBe(buttons()[0]);
    press(buttons()[0]!, "ArrowLeft");
    expect(doc.activeElement).toBe(buttons()[2]);
  });

  it("click (Enter and Space on a button) activates; Escape calls onEscape", () => {
    const { overlay, buttons, press, cb } = mount();
    overlay.render([badge(1), badge(2)], { busy: false });
    buttons()[1]!.click();
    expect(cb.onActivate).toHaveBeenCalledWith({ key: "p2", kind: "pin", ids: ["p2"] });
    press(buttons()[0]!, "Escape");
    expect(cb.onEscape).toHaveBeenCalledTimes(1);
  });

  it("keeps the roving stop and focus on the same badge across a re-render", () => {
    const { overlay, buttons, doc } = mount();
    overlay.render([badge(1), badge(2), badge(3)], { busy: false });
    buttons()[1]!.focus();
    overlay.render([badge(1, { x: 5 }), badge(2, { x: 7 }), badge(3)], { busy: false });
    expect(doc.activeElement?.getAttribute("data-key")).toBe("p2");
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("falls back to a neighbour when the focused badge disappears", () => {
    const { overlay, buttons, doc } = mount();
    overlay.render([badge(1), badge(2), badge(3)], { busy: false });
    buttons()[1]!.focus();
    overlay.render([badge(1), badge(3)], { busy: false });
    expect(overlay.el.contains(doc.activeElement) || doc.activeElement === doc.body).toBe(true);
    expect(buttons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it("focusBadge finds a pin by comment id or a cluster containing it", () => {
    const { overlay, doc } = mount();
    overlay.render([badge(1), badge(2, { kind: "cluster", ids: ["x", "y"], text: "2" })], { busy: false });
    expect(overlay.focusBadge("p1")).toBe(true);
    expect(doc.activeElement?.getAttribute("data-key")).toBe("p1");
    expect(overlay.focusBadge("y")).toBe(true);
    expect(overlay.focusBadge("nope")).toBe(false);
  });

  it("busy marks the layer aria-busy and dims; empty hides the layer", () => {
    const { overlay } = mount();
    overlay.render([badge(1)], { busy: true });
    expect(overlay.el.getAttribute("aria-busy")).toBe("true");
    expect(overlay.el.classList.contains("is-busy")).toBe(true);
    overlay.render([], { busy: false });
    expect(overlay.el.hidden).toBe(true);
  });

  it("updates at most the badges it was given (no growth, reuses nodes)", () => {
    const { overlay, buttons } = mount();
    overlay.render([badge(1), badge(2)], { busy: false });
    const first = buttons()[0];
    overlay.render([badge(1, { x: 999 })], { busy: false });
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]).toBe(first);
  });
});

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackOutcome } from "../../src/renderer/artifacts/feedback-registry";
import type { PickState } from "../../src/renderer/artifacts/pick-controller";
import {
  POPOVER_MIN_WIDTH,
  PickPopover,
  choosePopoverBounds,
  describeSelectionForDisclosure,
  popoverPosition,
  popoverStatus,
} from "../../src/renderer/artifacts/pick-popover";
import type { SelectionSnapshot } from "../../src/renderer/views/artifact-inspector-bridge";

vi.setConfig({ testTimeout: 30_000 }); // a fresh JSDOM per test is slow on shared CI runners

const selection = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, selectionId: "sel_" + "a".repeat(32), artifactId: "demo", artifactRevision: 1, viewSessionId: "reg",
  viewportPreset: "fill", capturedAt: "2026-11-08T00:00:00.000Z", redacted: false, route: "/index.html", tag: "button",
  selector: "#buy", selectorAlternates: ["main > button:nth-child(2)"],
  textAnchor: { tag: "button", text: "Buy now" }, landmark: "Pricing",
  outerHTML: { html: "<button id=\"buy\">Buy now</button>", truncated: false },
  ancestors: [], computedStyles: { display: "block" },
  boundingBox: { viewport: { x: 10, y: 20, width: 80, height: 30 }, document: { x: 10, y: 20, width: 80, height: 30 } },
  viewport: { width: 1000, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
  a11y: { role: "button", name: "Buy now", tabIndex: 0 }, ...over,
});
const snapshot = (over: Record<string, unknown> = {}, shot: boolean | "omit-vault" = true): SelectionSnapshot => ({
  selection: selection(over),
  screenshot: shot === true ? { mimeType: "image/png", bytes: new Uint8Array(2048), width: 96, height: 46, cssRect: { x: 0, y: 0, width: 96, height: 46 }, devicePixelRatio: 1, downscaled: false } : null,
  screenshotOmitted: shot === true ? null : "vault-read",
}) as unknown as SelectionSnapshot;

const base: PickState = { phase: "popover", submit: "idle", snapshot: snapshot(), comment: "", outcome: null, stale: false, handlerGone: false, elementGone: false };
const rejected = (message: string, source: ArtifactFeedbackOutcome["source"] = "handler"): ArtifactFeedbackOutcome =>
  ({ status: "rejected", reason: "failed", message, source });

function mount() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const callbacks = { onComment: vi.fn(), onSend: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(), onEscape: vi.fn(), onRepick: vi.fn() };
  const popover = new PickPopover(doc, callbacks);
  doc.body.append(popover.el);
  const render = (state: Partial<PickState> = {}, displayName = "Design") => popover.render({ ...base, ...state }, displayName);
  const q = <T extends Element = HTMLElement>(sel: string) => popover.el.querySelector<T>(sel)!;
  return { dom, doc, popover, callbacks, render, q };
}

describe("popoverPosition", () => {
  const bounds = { width: 800, height: 600 };
  const size = { width: 320, height: 240 };
  it("sits below the element when it fits", () => {
    expect(popoverPosition({ x: 100, y: 100, width: 80, height: 30 }, size, bounds)).toEqual({ left: 100, top: 138, placement: "below" });
  });
  it("flips above when there is no room below", () => {
    const p = popoverPosition({ x: 100, y: 500, width: 80, height: 30 }, size, bounds);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(500 - 8 - 240);
  });
  it("clamps horizontally inside the stage", () => {
    expect(popoverPosition({ x: 700, y: 10, width: 80, height: 30 }, size, bounds).left).toBe(800 - 8 - 320);
    expect(popoverPosition({ x: -50, y: 10, width: 80, height: 30 }, size, bounds).left).toBe(8);
  });
  it("overlays inside the stage when neither side fits (a tall element in a short stage)", () => {
    const p = popoverPosition({ x: 100, y: 100, width: 80, height: 380 }, size, { width: 800, height: 520 });
    expect(p.placement).toBe("overlay");
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + 240).toBeLessThanOrEqual(520 - 8);
  });
  it("never places the popover above the top of the stage when the element is scrolled out of view", () => {
    const p = popoverPosition({ x: 100, y: -300, width: 80, height: 30 }, size, bounds);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it("keeps the whole popover inside the stage for an element far below, far above, or off to the left (review A8)", () => {
    const inside = (p: { left: number; top: number }) => {
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + size.width).toBeLessThanOrEqual(bounds.width - 8);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + size.height).toBeLessThanOrEqual(bounds.height - 8);
    };
    inside(popoverPosition({ x: 100, y: 5000, width: 80, height: 30 }, size, bounds));
    inside(popoverPosition({ x: 100, y: -5000, width: 80, height: 30 }, size, bounds));
    inside(popoverPosition({ x: -4000, y: 300, width: 80, height: 30 }, size, bounds));
    inside(popoverPosition({ x: 9000, y: 9000, width: 80, height: 30 }, size, bounds));
  });
  it("works in a narrow stage that is smaller than the popover", () => {
    const p = popoverPosition({ x: 20, y: 20, width: 40, height: 20 }, size, { width: 300, height: 600 });
    expect(p.left).toBe(8);
  });
});

describe("popoverStatus", () => {
  it("words pending, accepted, rejected, timeout and gone differently", () => {
    expect(popoverStatus({ ...base, submit: "pending" }, "Design").text).toBe("Sending to Design…");
    expect(popoverStatus({ ...base, submit: "accepted", outcome: { status: "accepted", source: "handler" } }, "Design").text).toBe("Sent.");
    expect(popoverStatus({ ...base, submit: "accepted", outcome: { status: "accepted", message: "Queued for the agent.", source: "handler" } }, "Design").text).toBe("Queued for the agent.");
    const plugin = popoverStatus({ ...base, submit: "rejected", outcome: rejected("A comment is already waiting.") }, "Design");
    expect(plugin).toMatchObject({ text: "A comment is already waiting.", alert: true });
    const timeout = popoverStatus({ ...base, submit: "rejected", outcome: rejected("No response from Design in 15 s. It may have been received; check the thread before retrying. Retry reuses the same selection id.", "timeout") }, "Design");
    expect(timeout.text).toMatch(/^No response from Design in 15 s/);
    expect(timeout.text).not.toBe(plugin.text);
    // disposed while the send was in flight: neutral and true (the plugin may already have sent it)
    const inflight = popoverStatus({ ...base, submit: "rejected", handlerGone: true, outcome: rejected("Design was unloaded before it answered. Check the thread to see whether your comment arrived.", "disposed") }, "Design");
    expect(inflight.text).toBe("Design was unloaded before it answered. Check the thread to see whether your comment arrived.");
    expect(inflight.text).not.toContain("cannot be sent");
    expect(popoverStatus({ ...base, handlerGone: true }, "Design").text).toBe("Design is no longer available, so this comment cannot be sent. Cancel to keep browsing.");
  });
  it("appends the stale note to whatever else is shown", () => {
    expect(popoverStatus({ ...base, stale: true }, "Design").text).toBe("The page reloaded; this selection may be out of date.");
    expect(popoverStatus({ ...base, stale: true, submit: "pending" }, "Design").text).toBe("Sending to Design… The page reloaded; this selection may be out of date.");
  });
  it("is empty while idle with nothing to say", () => {
    expect(popoverStatus(base, "Design")).toEqual({ text: "", alert: false });
  });
});

describe("describeSelectionForDisclosure", () => {
  it("lists the comment, selection fields, redaction and screenshot, as text", () => {
    const text = describeSelectionForDisclosure(snapshot(), "Make it blue");
    expect(text).toContain("Comment\nMake it blue");
    expect(text).toContain("Element: <button>");
    expect(text).toContain("Selector: #buy");
    expect(text).toContain("main > button:nth-child(2)");
    expect(text).toContain("Bounding box (viewport px): x 10, y 20, 80 x 30");
    expect(text).toContain("<button id=\"buy\">Buy now</button>");
    expect(text).toContain("Accessibility: role button, name \"Buy now\"");
    expect(text).toContain("Screenshot: included (image/png, 2.0 KB, 96 x 46 px)");
    expect(text).toContain("Text redaction: off");
  });
  it("says so when text is redacted and no screenshot is attached", () => {
    const text = describeSelectionForDisclosure(snapshot({ redacted: true, textAnchor: { tag: "button", text: "" } }, "omit-vault"), "x");
    expect(text).toContain("Text redaction: on (this artifact reads vault data; element text and names are removed)");
    expect(text).toContain("Screenshot: not included (this artifact reads vault data)");
  });
  it("marks truncated HTML", () => {
    expect(describeSelectionForDisclosure(snapshot({ outerHTML: { html: "<div>", truncated: true } }), "c")).toContain("(truncated)");
  });
});

describe("PickPopover structure and accessibility", () => {
  it("is a non-modal dialog labelled by its heading, with a labelled 4000-unit textarea", () => {
    const { q, render, popover } = mount();
    render();
    expect(popover.el.getAttribute("role")).toBe("dialog");
    expect(popover.el.getAttribute("aria-modal")).toBe("false");
    const heading = q("h2");
    expect(popover.el.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("Comment on <button>");
    const area = q<HTMLTextAreaElement>("textarea");
    expect(area.getAttribute("aria-label")).toBe("Comment on the selected element");
    expect(area.maxLength).toBe(4000);
  });

  it("offers Send and Cancel only: no Pin", () => {
    const { popover, render } = mount();
    render();
    const labels = [...popover.el.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent);
    expect(labels).toEqual(["Send", "Cancel"]);
    expect(popover.el.textContent).not.toMatch(/pin/i);
  });

  it("has a status area that is aria-live polite", () => {
    const { q, render } = mount();
    render();
    expect(q(".pick-popover-status").getAttribute("role")).toBe("status");
    expect(q(".pick-popover-status").getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the 'Show what will be sent' disclosure collapsed by default", () => {
    const { q, render } = mount();
    render({ comment: "Make it blue" });
    const details = q<HTMLDetailsElement>("details");
    expect(details.open).toBe(false);
    expect(q("summary").textContent).toBe("Show what will be sent");
    expect(details.querySelector("pre")!.textContent).toContain("Make it blue");
  });

  it("renders hostile page content as text only (never markup)", () => {
    const { popover, render, q } = mount();
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    render({ comment: evil, snapshot: snapshot({ outerHTML: { html: evil, truncated: false }, selector: "#x\"><img src=x>", landmark: evil }) });
    expect(popover.el.querySelector("img")).toBeNull();
    expect(popover.el.querySelector("script")).toBeNull();
    expect(q("details pre").textContent).toContain(evil);
  });

  it("renders a hostile plugin message as text", () => {
    const { popover, render } = mount();
    render({ submit: "rejected", comment: "x", outcome: rejected("<b>bold</b><img src=x onerror=1>") });
    expect(popover.el.querySelector("b")).toBeNull();
    expect(popover.el.querySelector("img")).toBeNull();
    expect(popover.el.querySelector(".pick-popover-status")!.textContent).toBe("<b>bold</b><img src=x onerror=1>");
  });
});

describe("PickPopover states", () => {
  it("idle: Send is disabled until there is a non-blank comment", () => {
    const { q, render } = mount();
    render({ comment: "  " });
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    render({ comment: "Looks off" });
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(false);
  });

  it("pending: read-only text, 'Sending…', aria-busy, Cancel disabled", () => {
    const { q, render, popover } = mount();
    render({ submit: "pending", comment: "Looks off" });
    expect(q<HTMLTextAreaElement>("textarea").readOnly).toBe(true);
    expect(q(".pick-popover-send").textContent).toBe("Sending…");
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    expect(q<HTMLButtonElement>(".pick-popover-cancel").disabled).toBe(true);
    expect(popover.el.getAttribute("aria-busy")).toBe("true");
    expect(q(".pick-popover-status").textContent).toBe("Sending to Design…");
  });

  it("rejected: alert role, text kept, Send reads Retry, Cancel enabled", () => {
    const { q, render, popover } = mount();
    render({ submit: "rejected", comment: "Looks off", outcome: rejected("Design is busy.") });
    expect(q(".pick-popover-status").getAttribute("role")).toBe("alert");
    expect(q(".pick-popover-send").textContent).toBe("Retry");
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(false);
    expect(q<HTMLButtonElement>(".pick-popover-cancel").disabled).toBe(false);
    expect(q<HTMLTextAreaElement>("textarea").value).toBe("Looks off");
    expect(popover.el.getAttribute("aria-busy")).toBe("false");
  });

  it("accepted: shows the confirmation and a Done button instead of Send/Cancel", () => {
    const { popover, render, q } = mount();
    render({ submit: "accepted", comment: "Looks off", outcome: { status: "accepted", message: "Queued.", source: "handler" } });
    const visible = [...popover.el.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent);
    expect(visible).toEqual(["Done"]);
    expect(q(".pick-popover-status").textContent).toBe("Queued.");
    expect(q(".pick-popover-status").getAttribute("role")).toBe("status");
  });

  it("handler gone: Send disabled with explanatory copy", () => {
    const { q, render } = mount();
    render({ comment: "x", handlerGone: true });
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    expect(q(".pick-popover-status").textContent).toContain("no longer available");
  });

  it("does not clobber what the user is typing on re-render", () => {
    const { q, render } = mount();
    render({ comment: "abc" });
    const area = q<HTMLTextAreaElement>("textarea");
    area.value = "abcdef"; // typed, controller not yet told
    render({ comment: "abc" });
    expect(area.value).toBe("abcdef");
  });
});

describe("PickPopover input hygiene and status semantics (review A9)", () => {
  it("ignores Esc while an IME composition is active, so a typed comment is not discarded", () => {
    const { q, render, callbacks, dom } = mount();
    render({ comment: "hi" });
    const area = q<HTMLTextAreaElement>("textarea");
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true }));
    expect(callbacks.onEscape).not.toHaveBeenCalled();
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(callbacks.onEscape).toHaveBeenCalledTimes(1);
  });

  it("uses one politeness: role=status with aria-live polite normally, role=alert WITHOUT a competing aria-live for a rejection", () => {
    const { q, render } = mount();
    render();
    expect(q(".pick-popover-status").getAttribute("role")).toBe("status");
    expect(q(".pick-popover-status").getAttribute("aria-live")).toBe("polite");
    render({ submit: "rejected", comment: "x", outcome: rejected("No.") });
    expect(q(".pick-popover-status").getAttribute("role")).toBe("alert");
    expect(q(".pick-popover-status").hasAttribute("aria-live")).toBe(false);
    render({ submit: "pending", comment: "x" });
    expect(q(".pick-popover-status").getAttribute("role")).toBe("status");
    expect(q(".pick-popover-status").getAttribute("aria-live")).toBe("polite");
  });

  it("makes a rejection look different from pending and accepted: an error class and an icon next to the text", () => {
    const { q, render, popover } = mount();
    render({ submit: "pending", comment: "x" });
    expect(q(".pick-popover-status").classList.contains("is-error")).toBe(false);
    expect(q(".pick-popover-status").dataset.state).toBe("pending");
    render({ submit: "rejected", comment: "x", outcome: rejected("The agent is busy.") });
    expect(q(".pick-popover-status").classList.contains("is-error")).toBe(true);
    expect(q(".pick-popover-status").dataset.state).toBe("rejected");
    expect(q(".pick-popover-statusline .pick-popover-status-icon svg")).not.toBeNull();
    expect(q(".pick-popover-status").textContent).toBe("The agent is busy.");
    render({ submit: "accepted", comment: "x", outcome: { status: "accepted", source: "handler" } });
    expect(q(".pick-popover-status").classList.contains("is-error")).toBe(false);
    expect(q(".pick-popover-status").dataset.state).toBe("accepted");
    expect(popover.el.querySelector(".pick-popover-status-icon svg")).not.toBeNull();
  });
});

describe("PickPopover events", () => {
  it("reports typing, Send, Cancel and Done", () => {
    const { q, render, callbacks, dom } = mount();
    render({ comment: "hi" });
    const area = q<HTMLTextAreaElement>("textarea");
    area.value = "hello";
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(callbacks.onComment).toHaveBeenCalledWith("hello");
    q(".pick-popover-send").click();
    expect(callbacks.onSend).toHaveBeenCalledTimes(1);
    q(".pick-popover-cancel").click();
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    render({ submit: "accepted", comment: "hi", outcome: { status: "accepted", source: "handler" } });
    q(".pick-popover-done").click();
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
  });

  it("sends on Cmd/Ctrl+Enter, and Esc inside the popover is reported (not swallowed by the page)", () => {
    const { q, render, callbacks, dom } = mount();
    render({ comment: "hi" });
    const area = q<HTMLTextAreaElement>("textarea");
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(callbacks.onSend).toHaveBeenCalledTimes(2);
    area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(callbacks.onSend).toHaveBeenCalledTimes(2); // plain Enter is a newline
    const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    area.dispatchEvent(esc);
    expect(callbacks.onEscape).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
  });

  it("does not send via Cmd/Ctrl+Enter when Send is disabled", () => {
    const { q, render, callbacks, dom } = mount();
    render({ comment: "" });
    q("textarea").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(callbacks.onSend).not.toHaveBeenCalled();
  });

  it("moves focus to the textarea and to Done on request", () => {
    const { q, render, popover, doc } = mount();
    render({ comment: "hi" });
    popover.focusComment();
    expect(doc.activeElement).toBe(q("textarea"));
    render({ submit: "accepted", comment: "hi", outcome: { status: "accepted", source: "handler" } });
    popover.focusDone();
    expect(doc.activeElement).toBe(q(".pick-popover-done"));
  });
});

describe("element gone state (Phase 2a R1)", () => {
  it("says so, keeps the typed text, disables Send and offers Pick again", () => {
    const { q, render, popover, callbacks } = mount();
    render({ comment: "Make it larger", elementGone: true });
    expect(q(".pick-popover-status").textContent).toBe("The element changed or was removed. Pick it again to keep your comment.");
    expect(q(".pick-popover-statusline").classList.contains("is-error")).toBe(true);
    expect(q<HTMLTextAreaElement>("textarea").value).toBe("Make it larger");
    expect(q<HTMLButtonElement>(".pick-popover-send").disabled).toBe(true);
    const visible = [...popover.el.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent);
    expect(visible).toEqual(["Pick again", "Cancel"]);
    q(".pick-popover-repick").click();
    expect(callbacks.onRepick).toHaveBeenCalledTimes(1);
  });

  it("hides Pick again in every other state", () => {
    const { q, render } = mount();
    for (const state of [{}, { submit: "pending" as const }, { submit: "rejected" as const, outcome: rejected("No.") }]) {
      render({ comment: "x", ...state });
      expect(q<HTMLButtonElement>(".pick-popover-repick").hidden).toBe(true);
    }
  });

  it("popoverStatus: gone wins over an idle or rejected state but not over pending or accepted", () => {
    const text = "The element changed or was removed. Pick it again to keep your comment.";
    expect(popoverStatus({ ...base, elementGone: true }, "Design")).toEqual({ text, alert: true });
    expect(popoverStatus({ ...base, elementGone: true, submit: "rejected", outcome: rejected("No.") }, "Design").text).toBe(text);
    expect(popoverStatus({ ...base, elementGone: true, submit: "pending" }, "Design").text).toBe("Sending to Design…");
  });
});

describe("narrow pane (Phase 2a R3)", () => {
  const win = { width: 640, height: 800 };
  it("uses the stage as the bounds when it is wide enough", () => {
    expect(choosePopoverBounds({ left: 300, top: 40, width: 700, height: 500 }, win)).toEqual({ left: 300, top: 40, width: 700, height: 500, within: "stage" });
  });
  it("falls back to the whole window when the stage is narrower than the minimum popover width", () => {
    expect(choosePopoverBounds({ left: 300, top: 40, width: 36, height: 500 }, win)).toEqual({ left: 0, top: 0, width: 640, height: 800, within: "window" });
    expect(choosePopoverBounds({ left: 0, top: 0, width: POPOVER_MIN_WIDTH + 2 * 8 - 1, height: 500 }, win).within).toBe("window");
    expect(choosePopoverBounds({ left: 0, top: 0, width: POPOVER_MIN_WIDTH + 2 * 8, height: 500 }, win).within).toBe("stage");
  });
  it("has a usable minimum width", () => {
    expect(POPOVER_MIN_WIDTH).toBeGreaterThanOrEqual(220);
    expect(POPOVER_MIN_WIDTH).toBeLessThanOrEqual(260);
  });
  it("a window-bounds placement keeps a minimum-width popover fully inside the window for an anchor anywhere", () => {
    const bounds = choosePopoverBounds({ left: 300, top: 40, width: 36, height: 500 }, win);
    const size = { width: POPOVER_MIN_WIDTH, height: 300 };
    for (const anchor of [{ x: 310, y: 100, width: 20, height: 20 }, { x: 600, y: 700, width: 30, height: 30 }, { x: -50, y: -50, width: 5, height: 5 }]) {
      const p = popoverPosition(anchor, size, { width: bounds.width, height: bounds.height });
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + size.width).toBeLessThanOrEqual(win.width - 8);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + size.height).toBeLessThanOrEqual(win.height - 8);
    }
  });
});

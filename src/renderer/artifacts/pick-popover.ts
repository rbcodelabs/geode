import type { Rect } from "../../artifacts/feedback-contract";
import { setIcon } from "../api/icons";
import { INSPECTOR_SCREENSHOT } from "../../artifacts/inspector-protocol";
import type { PickState } from "./pick-controller";
import type { InspectHoverMessage } from "../../artifacts/inspector-protocol";
import type { SelectionSnapshot } from "../views/artifact-inspector-bridge";

/**
 * The comment popover (ADR 0006 D8): plain embedder DOM, non-modal, rendered from
 * a `PickState`. Everything that came from the page or from a plugin is placed
 * with `textContent` only; there is no `innerHTML` anywhere in this file.
 */

const COMMENT_MAX_UNITS = 4000;
const ELEMENT_GONE = "The element changed or was removed. Pick it again to keep your comment.";
const OFFSCREEN_NOTE = "The element is off screen. Scroll back to see it.";
const STALE_NOTE = "The page reloaded; this selection may be out of date.";
const STATUS_ICONS: Record<string, string | null> = {
  idle: null,
  pending: "loader-circle",
  accepted: "circle-check",
  rejected: "circle-alert",
  gone: "circle-alert",
};
const GAP = 8;
const MARGIN = 8;
let nextId = 0;

/** The narrowest popover that is still usable. Keep in sync with `.pick-popover { min-width }` in styles/app.css. */
export const POPOVER_MIN_WIDTH = 240;

/**
 * Where the popover may sit. Normally inside the stage; when the pane is too narrow for a usable popover (a 640 px
 * window with both side panels open leaves a 36 px pane) the whole window is used instead, so Send and Cancel stay
 * reachable. Coordinates are in window (client) px, which is what a fixed-position popover needs.
 */
export function choosePopoverBounds(
  stage: { left: number; top: number; width: number; height: number },
  win: { width: number; height: number },
): { left: number; top: number; width: number; height: number; within: "stage" | "window" } {
  // Read the fields explicitly: a DOMRect's are prototype getters, so `{ ...stage }` would copy nothing.
  if (stage.width >= POPOVER_MIN_WIDTH + 2 * MARGIN) return { left: stage.left, top: stage.top, width: stage.width, height: stage.height, within: "stage" };
  return { left: 0, top: 0, width: win.width, height: win.height, within: "window" };
}

/** Cap the popover's height to the room it has (it scrolls inside), never below a usable minimum. */
export function popoverMaxHeight(bounds: { height: number }): number {
  return Math.max(120, bounds.height - 2 * MARGIN);
}

/** Final safety net: pull a placement fully inside the window so Send and Cancel are always on screen. */
export function clampIntoWindow(
  pos: { left: number; top: number },
  size: { width: number; height: number },
  win: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, win.width - MARGIN - size.width);
  const maxTop = Math.max(MARGIN, win.height - MARGIN - size.height);
  return { left: Math.min(Math.max(MARGIN, pos.left), maxLeft), top: Math.min(Math.max(MARGIN, pos.top), maxTop) };
}

/**
 * Whether to move the popover for a change. A layout change (resize, preset, pane) always re-positions it, to keep it
 * inside its bounds. Movement of the ELEMENT (scroll, mutation; the page controls it) does not move it while the pointer
 * is over it or focus is inside it, so a page cannot slide Send and Cancel out from under a click (review A4); it settles
 * when the user leaves.
 */
export function shouldMovePopover(change: { reason: "layout" | "rect" | "settle"; pointerInside: boolean; focusInside: boolean }): boolean {
  return change.reason === "layout" || (!change.pointerInside && !change.focusInside);
}

/** True when the element's window rect does not intersect the visible area (the stage) at all. */
export function isElementOffscreen(
  element: { left: number; top: number; right: number; bottom: number },
  visible: { left: number; top: number; right: number; bottom: number },
): boolean {
  return element.right <= visible.left || element.left >= visible.right || element.bottom <= visible.top || element.top >= visible.bottom;
}

/** The tag as the page wrote it (SVG keeps camelCase): from the first tag of outerHTML when it matches the contract tag. */
export function pageCaseTag(selection: { readonly tag: string; readonly outerHTML: { readonly html: string } }): string {
  const match = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(selection.outerHTML.html);
  return match && match[1]!.toLowerCase() === selection.tag ? match[1]! : selection.tag;
}

/** Toolbar chip text for a hover: tag plus size, or tag plus the keyboard label. */
export function hoverChipText(hover: InspectHoverMessage): string {
  return hover.label ? `<${hover.tag}> ${hover.label}` : `<${hover.tag}> ${Math.round(hover.rect.width)} × ${Math.round(hover.rect.height)}`;
}

export interface PopoverCallbacks {
  onComment(text: string): void;
  onSend(): void;
  /** Phase 2b-i: save the comment as a pin (Pin button, Cmd/Ctrl+Shift+Enter). Absent for a host that cannot pin. */
  onPin?(): void;
  onCancel(): void;
  onDone(): void;
  onEscape(): void;
  /** "Pick again" after the selected element vanished (Phase 2a). */
  onRepick(): void;
}

/**
 * Where to put the popover (stage-relative px): below the element, flipped above
 * when it does not fit, otherwise overlaid inside the stage; always clamped.
 */
export function popoverPosition(
  anchor: Rect,
  size: { width: number; height: number },
  bounds: { width: number; height: number },
): { left: number; top: number; placement: "below" | "above" | "overlay" } {
  const maxLeft = bounds.width - MARGIN - size.width;
  const left = Math.max(MARGIN, Math.min(anchor.x, maxLeft));
  const maxTop = Math.max(MARGIN, bounds.height - MARGIN - size.height);
  const below = anchor.y + anchor.height + GAP;
  if (below + size.height <= bounds.height - MARGIN) return { left, top: Math.max(MARGIN, below), placement: "below" };
  const above = anchor.y - GAP - size.height;
  // The flipped position must itself be inside the stage: an element scrolled far below would otherwise put the
  // popover (and its focused textarea) out of the visible area.
  if (above >= MARGIN && above + size.height <= bounds.height - MARGIN) return { left, top: above, placement: "above" };
  return { left, top: maxTop, placement: "overlay" };
}

/** The status line: what is happening, and whether it needs the assertive `alert` role. */
export function popoverStatus(state: PickState, displayName: string, extra?: { offscreen?: boolean }): { text: string; alert: boolean } {
  let text = "";
  let alert = false;
  const pinning = state.action === "pin";
  if (state.submit === "pending") text = pinning ? `Pinning to ${displayName}…` : `Sending to ${displayName}…`;
  else if (state.submit === "accepted") text = state.outcome?.message || (pinning ? "Pinned." : "Sent.");
  else if (state.handlerGone && state.submit === "rejected" && state.outcome?.source === "disposed") {
    // Disposed while the send was in flight: show the registry's neutral message, not "cannot be sent".
    text = state.outcome.message ?? "";
    alert = true;
  } else if (state.elementGone) {
    text = ELEMENT_GONE;
    alert = true;
  } else if (state.handlerGone) text = `${displayName} is no longer available, so this comment cannot be sent. Cancel to keep browsing.`;
  else if (state.submit === "rejected") { text = state.outcome?.message ?? "The comment could not be sent."; alert = true; }
  if (state.stale) text = text ? `${text} ${STALE_NOTE}` : STALE_NOTE;
  if (extra?.offscreen) text = text ? `${text} ${OFFSCREEN_NOTE}` : OFFSCREEN_NOTE;
  return { text, alert };
}

/** What leaves the page and the comment, as text. The final prompt is built by the plugin with a per-message boundary, so it cannot be shown here. */
export function describeSelectionForDisclosure(snapshot: SelectionSnapshot, comment: string): string {
  const s = snapshot.selection;
  const box = s.boundingBox.viewport;
  const a11y = [s.a11y.role ? `role ${s.a11y.role}` : null, s.a11y.name ? `name "${s.a11y.name}"` : null].filter(Boolean).join(", ");
  const screenshot = snapshot.screenshot
    ? `included (${snapshot.screenshot.mimeType}, ${(snapshot.screenshot.bytes.length / 1024).toFixed(1)} KB, ${snapshot.screenshot.width} x ${snapshot.screenshot.height} px)`
    : `not included (${screenshotReason(snapshot.screenshotOmitted)})`;
  const lines = [
    "Comment",
    comment,
    "",
    "Selected element",
    `Element: <${s.tag}>`,
    `Selector: ${s.selector || "(none could be verified)"}`,
    ...s.selectorAlternates.map((alt) => `Alternate selector: ${alt}`),
    `Route: ${s.route}`,
    ...(s.landmark ? [`Near: ${s.landmark}`] : []),
    `Bounding box (viewport px): x ${round(box.x)}, y ${round(box.y)}, ${round(box.width)} x ${round(box.height)}`,
    `Accessibility: ${a11y || "none"}`,
    `HTML${s.outerHTML.truncated ? " (truncated)" : ""}:`,
    s.outerHTML.html,
    "",
    s.redacted
      ? "Text redaction: on (this artifact reads vault data; element text and names are removed)"
      : "Text redaction: off",
    `Screenshot: ${screenshot}`,
  ];
  return lines.join("\n");
}

const round = (n: number): number => Math.round(n * 10) / 10;

function screenshotReason(reason: SelectionSnapshot["screenshotOmitted"]): string {
  switch (reason) {
    case "vault-read": return "this artifact reads vault data";
    case "too-large": return `larger than ${Math.round(INSPECTOR_SCREENSHOT.maxBytes / 1024)} KB`;
    case "empty-rect": return "the element is not visible";
    default: return "the capture failed";
  }
}

export class PickPopover {
  readonly el: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly target: HTMLElement;
  private readonly area: HTMLTextAreaElement;
  private readonly disclosure: HTMLPreElement;
  private readonly status: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly send: HTMLButtonElement;
  private readonly pin: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly repick: HTMLButtonElement;
  private readonly done: HTMLButtonElement;
  private renderedComment = "";

  constructor(private readonly doc: Document, private readonly callbacks: PopoverCallbacks) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    };
    this.el = make("div", "pick-popover");
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "false");
    this.heading = make("h2", "pick-popover-heading");
    this.heading.id = `pick-popover-heading-${++nextId}`;
    this.el.setAttribute("aria-labelledby", this.heading.id);
    this.target = make("p", "pick-popover-target");

    this.area = make("textarea", "pick-popover-comment");
    this.area.setAttribute("aria-label", "Comment on the selected element");
    this.area.maxLength = COMMENT_MAX_UNITS;
    this.area.rows = 3;
    this.area.placeholder = "What should change here?";

    const details = make("details", "pick-popover-details");
    const summary = make("summary");
    summary.textContent = "Show what will be sent";
    this.disclosure = make("pre", "pick-popover-disclosure");
    details.append(summary, this.disclosure);

    this.status = make("div", "pick-popover-status");
    // The icon sits beside the live region, not inside it, so a screen reader announces the text only.
    this.statusLine = make("div", "pick-popover-statusline");
    this.statusIcon = make("span", "pick-popover-status-icon");
    this.statusIcon.setAttribute("aria-hidden", "true");
    this.statusLine.append(this.statusIcon, this.status);

    const actions = make("div", "pick-popover-actions");
    this.cancel = make("button", "pick-popover-cancel");
    this.cancel.type = "button";
    this.cancel.textContent = "Cancel";
    this.send = make("button", "mod-cta pick-popover-send");
    this.send.type = "button";
    this.pin = make("button", "pick-popover-pin");
    this.pin.type = "button";
    this.pin.textContent = "Pin";
    this.pin.hidden = true;
    this.repick = make("button", "mod-cta pick-popover-repick");
    this.repick.type = "button";
    this.repick.textContent = "Pick again";
    this.repick.hidden = true;
    this.done = make("button", "mod-cta pick-popover-done");
    this.done.type = "button";
    this.done.textContent = "Done";
    // DOM order is tab order (primary first); CSS lays the row out reversed.
    actions.append(this.repick, this.send, this.pin, this.cancel, this.done);

    this.el.append(this.heading, this.target, this.area, details, this.statusLine, actions);

    this.area.addEventListener("input", () => {
      this.renderedComment = this.area.value;
      this.callbacks.onComment(this.area.value);
    });
    this.area.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        // Cmd/Ctrl+Shift+Enter pins; Cmd/Ctrl+Enter sends (design 3.7).
        if (event.shiftKey) {
          if (!this.pin.disabled && !this.pin.hidden) this.callbacks.onPin?.();
        } else if (!this.send.disabled && !this.send.hidden) this.callbacks.onSend();
      }
    });
    // Esc anywhere in the popover is the user's, not the page's.
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      // Esc while an IME composition is open dismisses the candidate window, not the comment.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onEscape();
    });
    this.send.addEventListener("click", () => this.callbacks.onSend());
    this.pin.addEventListener("click", () => this.callbacks.onPin?.());
    this.cancel.addEventListener("click", () => this.callbacks.onCancel());
    this.done.addEventListener("click", () => this.callbacks.onDone());
    this.repick.addEventListener("click", () => this.callbacks.onRepick());
  }

  render(state: PickState, displayName: string, extra?: { offscreen?: boolean }): void {
    const snapshot = state.snapshot;
    if (snapshot) {
      this.heading.textContent = `Comment on <${pageCaseTag(snapshot.selection)}>`;
      this.target.textContent = describeTarget(snapshot);
      this.disclosure.textContent = describeSelectionForDisclosure(snapshot, state.comment);
    }
    if (state.comment !== this.renderedComment) {
      this.renderedComment = state.comment;
      this.area.value = state.comment;
    }
    const pending = state.submit === "pending";
    const accepted = state.submit === "accepted";
    this.area.readOnly = pending || accepted;
    this.el.setAttribute("aria-busy", String(pending));

    const status = popoverStatus(state, displayName, extra);
    this.status.textContent = status.text;
    // One politeness: an alert is assertive by role; everything else is a polite status. Never both.
    this.status.setAttribute("role", status.alert ? "alert" : "status");
    if (status.alert) this.status.removeAttribute("aria-live");
    else this.status.setAttribute("aria-live", "polite");
    const kind = status.alert ? "rejected" : state.submit === "pending" ? "pending" : state.submit === "accepted" ? "accepted" : state.handlerGone ? "gone" : "idle";
    this.status.dataset.state = kind;
    this.status.classList.toggle("is-error", status.alert);
    this.statusLine.classList.toggle("is-error", status.alert);
    this.statusLine.dataset.state = kind;
    const icon = STATUS_ICONS[kind];
    if (this.statusIcon.dataset.icon !== (icon ?? "")) {
      this.statusIcon.dataset.icon = icon ?? "";
      if (icon) setIcon(this.statusIcon, icon);
      else this.statusIcon.replaceChildren();
    }

    const gone = state.elementGone && !accepted && !pending;
    // Send is about to disappear: if it (or anything in the popover) had focus, keyboard users land on "Pick again"
    // instead of losing focus to <body> (and Esc with it).
    const focusWasInside = this.el.contains(this.doc.activeElement);
    const wasGone = !this.repick.hidden;
    this.repick.hidden = !gone;
    this.send.hidden = accepted || gone; // in the gone state "Pick again" replaces Send
    this.cancel.hidden = accepted;
    this.done.hidden = !accepted;
    const lastPin = state.action === "pin";
    this.send.textContent = pending && !lastPin ? "Sending…" : state.submit === "rejected" && !lastPin ? "Retry" : "Send";
    const empty = state.comment.trim().length === 0;
    this.send.disabled = pending || state.handlerGone || state.elementGone || empty;
    this.pin.hidden = accepted || gone || state.pinAvailable !== true;
    this.pin.textContent = pending && lastPin ? "Pinning…" : state.submit === "rejected" && lastPin ? "Retry pin" : "Pin";
    this.pin.disabled = pending || state.handlerGone || state.elementGone || empty;
    this.cancel.disabled = pending;
    if (gone && !wasGone && focusWasInside) this.repick.focus();
  }

  focusComment(): void { this.area.focus(); }
  focusDone(): void { this.done.focus(); }
}

/** One line that tells the user which element this is. Page-controlled strings, so the caller uses textContent. */
function describeTarget(snapshot: SelectionSnapshot): string {
  const s = snapshot.selection;
  const label = s.a11y.name || s.textAnchor.text || s.landmark || "";
  return label ? `“${label.slice(0, 60)}” · ${s.selector || s.tag}` : s.selector || s.tag;
}

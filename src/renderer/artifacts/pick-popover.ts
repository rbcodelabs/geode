import type { Rect } from "../../artifacts/feedback-contract";
import { INSPECTOR_SCREENSHOT } from "../../artifacts/inspector-protocol";
import type { PickState } from "./pick-controller";
import type { SelectionSnapshot } from "../views/artifact-inspector-bridge";

/**
 * The comment popover (ADR 0006 D8): plain embedder DOM, non-modal, rendered from
 * a `PickState`. Everything that came from the page or from a plugin is placed
 * with `textContent` only; there is no `innerHTML` anywhere in this file.
 */

const COMMENT_MAX_UNITS = 4000;
const STALE_NOTE = "The page reloaded; this selection may be out of date.";
const GAP = 8;
const MARGIN = 8;
let nextId = 0;

export interface PopoverCallbacks {
  onComment(text: string): void;
  onSend(): void;
  onCancel(): void;
  onDone(): void;
  onEscape(): void;
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
  const below = anchor.y + anchor.height + GAP;
  if (below + size.height <= bounds.height - MARGIN) return { left, top: below, placement: "below" };
  const above = anchor.y - GAP - size.height;
  if (above >= MARGIN) return { left, top: above, placement: "above" };
  return { left, top: Math.max(MARGIN, bounds.height - MARGIN - size.height), placement: "overlay" };
}

/** The status line: what is happening, and whether it needs the assertive `alert` role. */
export function popoverStatus(state: PickState, displayName: string): { text: string; alert: boolean } {
  let text = "";
  let alert = false;
  if (state.submit === "pending") text = `Sending to ${displayName}…`;
  else if (state.submit === "accepted") text = state.outcome?.message || "Sent.";
  else if (state.handlerGone) text = `${displayName} is no longer available, so this comment cannot be sent. Cancel to keep browsing.`;
  else if (state.submit === "rejected") { text = state.outcome?.message ?? "The comment could not be sent."; alert = true; }
  if (state.stale) text = text ? `${text} ${STALE_NOTE}` : STALE_NOTE;
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
  private readonly send: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
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
    this.status.setAttribute("aria-live", "polite");

    const actions = make("div", "pick-popover-actions");
    this.cancel = make("button", "pick-popover-cancel");
    this.cancel.type = "button";
    this.cancel.textContent = "Cancel";
    this.send = make("button", "mod-cta pick-popover-send");
    this.send.type = "button";
    this.done = make("button", "mod-cta pick-popover-done");
    this.done.type = "button";
    this.done.textContent = "Done";
    // DOM order is tab order (primary first); CSS lays the row out reversed.
    actions.append(this.send, this.cancel, this.done);

    this.el.append(this.heading, this.target, this.area, details, this.status, actions);

    this.area.addEventListener("input", () => {
      this.renderedComment = this.area.value;
      this.callbacks.onComment(this.area.value);
    });
    this.area.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!this.send.disabled && !this.send.hidden) this.callbacks.onSend();
      }
    });
    // Esc anywhere in the popover is the user's, not the page's.
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onEscape();
    });
    this.send.addEventListener("click", () => this.callbacks.onSend());
    this.cancel.addEventListener("click", () => this.callbacks.onCancel());
    this.done.addEventListener("click", () => this.callbacks.onDone());
  }

  render(state: PickState, displayName: string): void {
    const snapshot = state.snapshot;
    if (snapshot) {
      this.heading.textContent = `Comment on <${snapshot.selection.tag}>`;
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

    const status = popoverStatus(state, displayName);
    this.status.textContent = status.text;
    this.status.setAttribute("role", status.alert ? "alert" : "status");

    this.send.hidden = accepted;
    this.cancel.hidden = accepted;
    this.done.hidden = !accepted;
    this.send.textContent = pending ? "Sending…" : state.submit === "rejected" ? "Retry" : "Send";
    this.send.disabled = pending || state.handlerGone || state.comment.trim().length === 0;
    this.cancel.disabled = pending;
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

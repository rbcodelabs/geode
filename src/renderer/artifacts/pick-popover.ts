import type { Rect } from "../../artifacts/feedback-contract";
import { setIcon } from "../api/icons";
import { INSPECTOR_SCREENSHOT } from "../../artifacts/inspector-protocol";
import type { PickOutcome, PickState } from "./pick-controller";
import type { InspectHoverMessage } from "../../artifacts/inspector-protocol";
import type { SelectionSnapshot } from "../views/artifact-inspector-bridge";
import type { WebViewerSelectionSnapshot } from "../views/web-viewer-inspector-bridge";
import {
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerThreadList,
  type WebViewerThreadOption,
} from "../../web-viewer/feedback-contract";
import { isLoopbackOrigin } from "../views/viewport-presets";
import { cutByCodePoints } from "./rail-model";

export type PickPopoverSnapshot = SelectionSnapshot | WebViewerSelectionSnapshot;

export type PopoverThreadListState =
  | { readonly status: "loading"; readonly reset?: boolean }
  | { readonly status: "ready"; readonly list: WebViewerThreadList }
  | { readonly status: "error"; readonly message?: string };

export interface PickPopoverWebViewerOptions {
  onThreadChange?(threadId: string | null): void;
  onRefreshThreads?(): void;
}

export interface PickPopoverOptions {
  webViewer?: PickPopoverWebViewerOptions;
}

/** Formats a single `WebViewerThreadOption` for `<option>` textContent. */
export function formatWebViewerThreadOptionLabel(opt: WebViewerThreadOption): string {
  return `${opt.title}${opt.subtitle ? ` · ${opt.subtitle}` : ""}${opt.active ? " (Active)" : ""}${opt.busy ? " (Busy — will queue)" : ""}${opt.planMode ? " [Plan]" : ""}`;
}

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
export function popoverStatus(
  state: PickState<PickPopoverSnapshot, PickOutcome>,
  displayName: string,
  extra?: { offscreen?: boolean; threadStatus?: { text: string; alert: boolean } | null },
): { text: string; alert: boolean } {
  let text = "";
  let alert = false;
  const pinning = state.action === "pin";
  if (state.submit === "pending") text = pinning ? `Pinning to ${displayName}…` : `Sending to ${displayName}…`;
  else if (state.submit === "accepted") {
    const queued = state.outcome && "delivery" in state.outcome && state.outcome.delivery === "queued";
    text = state.outcome?.message || (pinning ? "Pinned." : queued ? "Queued for thread." : "Sent.");
  }
  else if (state.handlerGone && state.submit === "rejected" && state.outcome?.source === "disposed") {
    // Disposed while the send was in flight: show the registry's neutral message, not "cannot be sent".
    text = state.outcome.message ?? "";
    alert = true;
  } else if (state.elementGone) {
    text = ELEMENT_GONE;
    alert = true;
  } else if (state.handlerGone) text = `${displayName} is no longer available, so this comment cannot be sent. Cancel to keep browsing.`;
  else if (state.submit === "rejected") { text = state.outcome?.message ?? "The comment could not be sent."; alert = true; }
  else if (extra?.threadStatus) {
    text = extra.threadStatus.text;
    alert = extra.threadStatus.alert;
  }
  if (state.stale) text = text ? `${text} ${STALE_NOTE}` : STALE_NOTE;
  if (extra?.offscreen) text = text ? `${text} ${OFFSCREEN_NOTE}` : OFFSCREEN_NOTE;
  return { text, alert };
}

/** What leaves the page and the comment, as text. The final prompt is built by the plugin with a per-message boundary, so it cannot be shown here. */
export function describeSelectionForDisclosure(snapshot: PickPopoverSnapshot, comment: string): string {
  const s = snapshot.selection;
  const box = s.boundingBox.viewport;
  const a11y = [s.a11y.role ? `role ${s.a11y.role}` : null, s.a11y.name ? `name "${s.a11y.name}"` : null].filter(Boolean).join(", ");
  const screenshot = snapshot.screenshot
    ? `included (${snapshot.screenshot.mimeType}, ${(snapshot.screenshot.bytes.length / 1024).toFixed(1)} KB, ${snapshot.screenshot.width} x ${snapshot.screenshot.height} px)`
    : `not included (${screenshotReason(snapshot.screenshotOmitted)})`;
  const footer =
    "redacted" in s
      ? [
          s.redacted
            ? "Text redaction: on (this artifact reads vault data; element text and names are removed)"
            : "Text redaction: off",
          `Screenshot: ${screenshot}`,
        ]
      : [
          ...("page" in snapshot ? [`Page: ${snapshot.page.url}`] : []),
          `Viewport preset: ${s.viewportPreset}`,
          `Screenshot: ${screenshot}`,
        ];
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
    ...footer,
  ];
  return lines.join("\n");
}

const round = (n: number): number => Math.round(n * 10) / 10;

function screenshotReason(reason: PickPopoverSnapshot["screenshotOmitted"]): string {
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
  private readonly originRow: HTMLElement | null = null;
  private readonly originText: HTMLElement | null = null;
  private readonly originBadge: HTMLElement | null = null;
  private readonly threadRow: HTMLElement | null = null;
  private readonly threadSelect: HTMLSelectElement | null = null;
  private readonly threadRefreshBtn: HTMLButtonElement | null = null;
  private readonly webViewerOptions: PickPopoverWebViewerOptions | null;
  private threadListState: PopoverThreadListState = { status: "loading" };
  private selectedThreadId: string | null = null;
  private manualThreadId: string | null = null;
  private lastSelectionId: string | null = null;
  private lastRenderArgs: {
    state: PickState<PickPopoverSnapshot, PickOutcome>;
    displayName: string;
    extra?: { offscreen?: boolean };
  } | null = null;
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
  private readonly onWindowKeydown: (event: KeyboardEvent) => void;

  constructor(
    private readonly doc: Document,
    private readonly callbacks: PopoverCallbacks,
    options?: PickPopoverOptions,
  ) {
    this.webViewerOptions = options?.webViewer ?? null;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    };
    const instanceId = ++nextId;
    this.el = make("div", "pick-popover");
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "false");
    this.heading = make("h2", "pick-popover-heading");
    this.heading.id = `pick-popover-heading-${instanceId}`;
    this.el.setAttribute("aria-labelledby", this.heading.id);
    this.target = make("p", "pick-popover-target");

    if (this.webViewerOptions) {
      this.originRow = make("div", "geode-pick-origin-row");
      this.originRow.setAttribute("data-testid", "pick-popover-origin-row");
      this.originText = make("span", "geode-pick-origin");
      this.originText.setAttribute("data-testid", "pick-popover-origin");
      this.originBadge = make("span", "geode-pick-origin-badge");
      this.originBadge.setAttribute("data-testid", "pick-popover-external-origin");
      this.originBadge.textContent = "External origin";
      this.originBadge.hidden = true;
      this.originRow.append(this.originText, this.originBadge);

      this.threadRow = make("div", "geode-pick-thread-row");
      const threadLabel = make("label", "geode-pick-thread-label");
      const selectId = `geode-pick-thread-select-${instanceId}`;
      threadLabel.htmlFor = selectId;
      threadLabel.textContent = "Thread";
      this.threadSelect = make("select", "geode-pick-thread-select");
      this.threadSelect.id = selectId;
      this.threadSelect.setAttribute("aria-label", "Target thread");
      this.threadSelect.setAttribute("data-testid", "pick-popover-thread-select");
      this.threadRefreshBtn = make("button", "clickable-icon geode-pick-thread-refresh");
      this.threadRefreshBtn.type = "button";
      this.threadRefreshBtn.setAttribute("aria-label", "Refresh threads");
      this.threadRefreshBtn.setAttribute("data-testid", "pick-popover-thread-refresh");
      setIcon(this.threadRefreshBtn, "rotate-cw");
      this.threadRow.append(threadLabel, this.threadSelect, this.threadRefreshBtn);

      this.threadSelect.addEventListener("change", () => {
        if (!this.threadSelect) return;
        const chosen = this.threadSelect.value || null;
        this.manualThreadId = chosen;
        this.selectedThreadId = chosen;
        this.webViewerOptions?.onThreadChange?.(this.selectedThreadId);
        this.rerenderIfMounted();
      });
      this.threadRefreshBtn.addEventListener("click", () => {
        if (this.threadRefreshBtn?.disabled) return;
        this.webViewerOptions?.onRefreshThreads?.();
      });
      this.applyThreadListToSelect({ status: "loading", reset: true });
    }

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

    if (this.originRow && this.threadRow) {
      this.el.append(this.heading, this.originRow, this.target, this.threadRow, this.area, details, this.statusLine, actions);
    } else {
      this.el.append(this.heading, this.target, this.area, details, this.statusLine, actions);
    }

    this.area.addEventListener("input", () => {
      this.renderedComment = this.area.value;
      this.callbacks.onComment(this.area.value);
    });
    this.area.addEventListener("keydown", (event) => {
      // Cmd/Ctrl+Enter sends (design 3.7). Cmd/Ctrl+Shift+Enter (Pin) is taken earlier, by the window capture listener below.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        if (!this.send.disabled && !this.send.hidden) this.callbacks.onSend();
      }
    });
    // Mod+Shift+Enter is also the global "Toggle focus on active pane" command, which the app dispatches from a document
    // capture listener. While focus is inside this popover AND Pin can actually fire, the combo is Pin (design 3.7, A4
    // collision check): a window capture listener runs first and keeps the global command from also firing. In every other
    // state (v1 handler, empty comment, pending, accepted) the event is left alone, so the global command still works.
    this.onWindowKeydown = (event) => {
      if (event.key !== "Enter" || !event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.isComposing || !this.el.contains(event.target as Node)) return;
      if (this.pin.disabled || this.pin.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onPin?.();
    };
    doc.defaultView?.addEventListener("keydown", this.onWindowKeydown, true);
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

  /** Updates the host-verified origin header row and external-origin badge (`textContent` only). */
  setOrigin(origin: string): void {
    if (!this.originText || !this.originBadge) return;
    this.originText.textContent = origin;
    this.originBadge.hidden = !origin || isLoopbackOrigin(origin);
  }

  /** Currently selected destination `threadId` (or `WEB_VIEWER_NEW_THREAD_ID`), or `null` when unavailable. */
  getSelectedThreadId(): string | null {
    return this.selectedThreadId;
  }

  /** Updates the async `listThreads` state and refreshes `<select>` options smoothly. */
  setThreadListState(next: PopoverThreadListState): void {
    if (!this.webViewerOptions) return;
    const prevSelected = this.selectedThreadId;
    this.applyThreadListToSelect(next);
    if (this.selectedThreadId !== prevSelected) {
      this.webViewerOptions.onThreadChange?.(this.selectedThreadId);
    }
    this.rerenderIfMounted();
  }

  private applyThreadListToSelect(next: PopoverThreadListState): void {
    this.threadListState = next;
    const select = this.threadSelect;
    if (!select) return;

    if (next.status === "loading") {
      if (next.reset) {
        this.manualThreadId = null;
        this.selectedThreadId = null;
      }
      if (this.selectedThreadId === null) {
        select.replaceChildren(this.makeOption("", "Loading threads…"));
        select.value = "";
      }
      return;
    }

    if (next.status === "error") {
      this.selectedThreadId = null;
      select.replaceChildren(this.makeOption("", "Threads unavailable"));
      select.value = "";
      return;
    }

    const { list } = next;
    const options: HTMLOptionElement[] = [];
    const validIds = new Set<string>();
    for (const opt of list.threads) {
      validIds.add(opt.id);
      options.push(this.makeOption(opt.id, formatWebViewerThreadOptionLabel(opt)));
    }
    if (list.allowNewThread) {
      validIds.add(WEB_VIEWER_NEW_THREAD_ID);
      options.push(this.makeOption(WEB_VIEWER_NEW_THREAD_ID, "+ New thread"));
    }

    if (options.length === 0) {
      this.selectedThreadId = null;
      this.manualThreadId = null;
      select.replaceChildren(this.makeOption("", "No threads available"));
      select.value = "";
      return;
    }

    if (this.manualThreadId !== null && !validIds.has(this.manualThreadId)) {
      this.manualThreadId = null;
    }
    const chosen =
      (this.manualThreadId !== null && validIds.has(this.manualThreadId) ? this.manualThreadId : null) ??
      list.threads.find((t) => t.active)?.id ??
      list.threads[0]?.id ??
      (list.allowNewThread ? WEB_VIEWER_NEW_THREAD_ID : null);

    select.replaceChildren(...options);
    this.selectedThreadId = chosen;
    if (chosen !== null) {
      select.value = chosen;
    }
  }

  private makeOption(value: string, label: string): HTMLOptionElement {
    const opt = this.doc.createElement("option");
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  private computeThreadStatus(): { blocked: boolean; status: { text: string; alert: boolean } | null } {
    if (!this.webViewerOptions) return { blocked: false, status: null };
    if (this.threadListState.status === "loading") {
      if (this.selectedThreadId === null) {
        return { blocked: true, status: { text: "Loading threads…", alert: false } };
      }
      return { blocked: false, status: null };
    }
    if (this.threadListState.status === "error") {
      return {
        blocked: true,
        status: {
          text: this.threadListState.message || "Could not load target threads. Refresh threads to try again.",
          alert: true,
        },
      };
    }
    if (this.selectedThreadId === null) {
      return {
        blocked: true,
        status: {
          text: "No target threads are available. Open or allow a new thread in Agent Threads, then refresh.",
          alert: false,
        },
      };
    }
    return { blocked: false, status: null };
  }

  private rerenderIfMounted(): void {
    if (!this.lastRenderArgs) return;
    const { state, displayName, extra } = this.lastRenderArgs;
    this.render(state, displayName, extra);
  }

  render(
    state: PickState<PickPopoverSnapshot, PickOutcome>,
    displayName: string,
    extra?: { offscreen?: boolean },
  ): void {
    this.lastRenderArgs = { state, displayName, extra };
    const snapshot = state.snapshot;
    if (snapshot) {
      this.heading.textContent = `Comment on <${pageCaseTag(snapshot.selection)}>`;
      this.target.textContent = describeTarget(snapshot);
      this.disclosure.textContent = describeSelectionForDisclosure(snapshot, state.comment);
      if ("page" in snapshot && snapshot.selection.selectionId !== this.lastSelectionId) {
        this.lastSelectionId = snapshot.selection.selectionId;
        this.setOrigin(snapshot.page.origin);
      }
    }
    if (state.comment !== this.renderedComment) {
      this.renderedComment = state.comment;
      this.area.value = state.comment;
    }
    const pending = state.submit === "pending";
    const accepted = state.submit === "accepted";
    this.area.readOnly = pending || accepted;
    this.el.setAttribute("aria-busy", String(pending));

    const threadGate = this.computeThreadStatus();
    if (this.threadSelect && this.threadRefreshBtn) {
      const loadingThreads = this.threadListState.status === "loading";
      const selectEmpty = this.selectedThreadId === null;
      this.threadSelect.disabled = pending || accepted || state.handlerGone || selectEmpty;
      this.threadRefreshBtn.disabled = pending || accepted || state.handlerGone || loadingThreads;
    }

    const status = popoverStatus(state, displayName, {
      offscreen: extra?.offscreen,
      threadStatus: threadGate.status,
    });
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
    this.send.disabled = pending || state.handlerGone || state.elementGone || empty || threadGate.blocked;
    this.pin.hidden = accepted || gone || state.pinAvailable !== true;
    // A hidden Pin button carries no text at all, so a popover for a v1 handler has no Pin anywhere in its content.
    this.pin.textContent = this.pin.hidden ? "" : pending && lastPin ? "Pinning…" : state.submit === "rejected" && lastPin ? "Retry pin" : "Pin";
    this.pin.disabled = pending || state.handlerGone || state.elementGone || empty;
    this.cancel.disabled = pending;
    if (gone && !wasGone && focusWasInside) this.repick.focus();
  }

  /** Removes the window-level listener; the view calls it when the popover is discarded. */
  dispose(): void { this.doc.defaultView?.removeEventListener("keydown", this.onWindowKeydown, true); }

  focusComment(): void { this.area.focus(); }
  focusDone(): void { this.done.focus(); }
}

/** One line that tells the user which element this is. Page-controlled strings, so the caller uses textContent. */
function describeTarget(snapshot: PickPopoverSnapshot): string {
  const s = snapshot.selection;
  const label = s.a11y.name || s.textAnchor.text || s.landmark || "";
  return label ? `“${cutByCodePoints(label, 60)}” · ${s.selector || s.tag}` : s.selector || s.tag;
}

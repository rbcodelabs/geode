import type { ArtifactFeedbackOutcome } from "./feedback-registry";
import type { SelectionSnapshot } from "../views/artifact-inspector-bridge";
import type { WebViewerFeedbackOutcome } from "../web-viewer/feedback-registry";

export type PickOutcome = ArtifactFeedbackOutcome | WebViewerFeedbackOutcome;

/**
 * The element-picker state machine (ADR 0006 D8). Pure and DOM-free: the view
 * renders `state`, forwards user intent, and implements the small `host` surface
 * (guest mode, focus, submit). Nothing here persists; the view builds a fresh
 * controller on every load.
 *
 *   off --enter--> pick --selected--> popover(idle) --send--> popover(pending)
 *                    ^                     |                        |
 *                    +------ cancel -------+      accepted / rejected (Retry reuses the snapshot)
 *
 * Pick mode is single-shot: dismissing an accepted popover leaves pick mode.
 */
export type PickPhase = "off" | "pick" | "popover";
export type PopoverSubmitState = "idle" | "pending" | "accepted" | "rejected";
/** "pins" (Phase 2b-i): after a saved pin, the pin layer's new badge when it is placed, else the toggle; the view decides. */
export type FocusTarget = "toggle" | "guest" | "comment" | "done" | "pins";
/** Which popover action the current submit state belongs to. */
export type PickAction = "send" | "pin";
/** Which element held focus when the user picked; where focus returns when the popover is cancelled. */
export type FocusOrigin = "toggle" | "guest";

export interface PickState<TSnapshot = SelectionSnapshot, TOutcome extends PickOutcome = ArtifactFeedbackOutcome> {
  readonly phase: PickPhase;
  readonly submit: PopoverSubmitState;
  /** The action the submit state describes (Retry applies to this one). */
  readonly action: PickAction;
  /** The routed handler is v2 and its provider answers list: the popover offers Pin (v1 handlers never do). */
  readonly pinAvailable: boolean;
  readonly snapshot: TSnapshot | null;
  readonly comment: string;
  readonly outcome: TOutcome | null;
  /** The page reloaded while the popover was open; the selection may describe a different document. */
  readonly stale: boolean;
  /** No handler can receive this comment any more; Send is disabled. */
  readonly handlerGone: boolean;
  /** The page removed or replaced the selected element (Phase 2a); Send is disabled until the user picks again. */
  readonly elementGone: boolean;
}

export interface PickControllerHost<TSnapshot = SelectionSnapshot, TOutcome extends PickOutcome = ArtifactFeedbackOutcome> {
  setGuestMode(mode: "pick" | "off"): void;
  submit(snapshot: TSnapshot, comment: string): Promise<TOutcome>;
  /** Phase 2b-i: save the comment as a pin instead of sending it. Absent on a host that cannot pin. */
  pin?(snapshot: TSnapshot, comment: string): Promise<TOutcome>;
  /** Optional host readiness gate for Send (e.g. target thread selected in Web Viewer). */
  canSend?(): boolean;
  focus(target: FocusTarget): void;
  changed(state: PickState<TSnapshot, TOutcome>): void;
}

const IDLE: PickState<never, never> = { phase: "off", submit: "idle", action: "send", pinAvailable: false, snapshot: null, comment: "", outcome: null, stale: false, handlerGone: false, elementGone: false };

export class PickController<TSnapshot = SelectionSnapshot, TOutcome extends PickOutcome = ArtifactFeedbackOutcome> {
  private current: PickState<TSnapshot, TOutcome> = IDLE;
  private origin: FocusOrigin = "toggle";
  /** Bumped whenever a submit's result should no longer be applied. */
  private token = 0;
  private disposed = false;
  /** Text carried from a popover whose element vanished into the next selection (never past leaving pick mode). */
  private draft = "";
  /** A gone report that arrived after the select but before the popover exists (the screenshot await); applied on open. */
  private pendingGone = false;

  constructor(private readonly host: PickControllerHost<TSnapshot, TOutcome>) {}

  get state(): PickState<TSnapshot, TOutcome> { return this.current; }

  toggle(via: "pointer" | "keyboard"): void {
    if (this.current.phase === "off") this.enter(via);
    else if (this.current.submit !== "pending") this.exit("toggle");
  }

  enter(via: "pointer" | "keyboard"): void {
    if (this.disposed || this.current.phase !== "off") return;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone, pinAvailable: this.current.pinAvailable });
    this.host.setGuestMode("pick");
    // A keyboard user must land in the page so it receives [ ] Enter Esc natively.
    if (via === "keyboard") this.host.focus("guest");
  }

  /** A validated selection from the guest. The bridge is already in hold. */
  selected(snapshot: TSnapshot, origin: FocusOrigin): void {
    if (this.disposed || this.current.phase !== "pick") return;
    this.origin = origin;
    const draft = this.draft;
    this.draft = "";
    const gone = this.pendingGone;
    this.pendingGone = false;
    this.set({ ...IDLE, phase: "popover", snapshot, comment: draft, elementGone: gone, pinAvailable: this.current.pinAvailable });
    this.host.focus("comment");
  }

  setComment(text: string): void {
    const { phase, submit } = this.current;
    if (phase !== "popover" || (submit !== "idle" && submit !== "rejected")) return;
    this.set({ ...this.current, comment: text });
  }

  canSend(): boolean {
    const { phase, submit, comment, handlerGone } = this.current;
    if (phase !== "popover" || (submit !== "idle" && submit !== "rejected") || handlerGone || this.current.elementGone || comment.trim().length === 0) {
      return false;
    }
    return this.host.canSend ? this.host.canSend() : true;
  }

  canCancel(): boolean {
    return this.current.phase === "popover" && this.current.submit !== "pending";
  }

  /** Send, or Retry after a rejection: the same snapshot, so the same selectionId. */
  send(): void {
    if (this.disposed || !this.canSend()) return;
    const snapshot = this.current.snapshot!;
    this.begin("send", (host) => host.submit(snapshot, this.current.comment));
  }

  canPin(): boolean {
    return this.canSend() && this.current.pinAvailable && typeof this.host.pin === "function";
  }

  /** Pin (Phase 2b-i): save the comment without sending it. Same state machine as Send; a rejection keeps the typed text. */
  pin(): void {
    if (this.disposed || !this.canPin()) return;
    const snapshot = this.current.snapshot!;
    this.begin("pin", (host) => host.pin!(snapshot, this.current.comment));
  }

  private begin(action: PickAction, run: (host: PickControllerHost<TSnapshot, TOutcome>) => Promise<TOutcome>): void {
    const token = ++this.token;
    this.set({ ...this.current, submit: "pending", action, outcome: null });
    // A host that rejects (it should not) must not leave the popover pending for ever.
    let started: Promise<TOutcome>;
    try { started = run(this.host); } catch (error) { started = Promise.reject(error); } // the host call itself stays synchronous
    const settled = started.catch((error): TOutcome => {
      console.warn("[artifact-feedback] a popover action failed", error);
      return { status: "rejected", reason: "failed", message: "That could not be completed.", source: "handler" } as TOutcome;
    });
    void settled.then((outcome) => {
      if (this.disposed || token !== this.token || this.current.submit !== "pending") return;
      if (outcome.status === "accepted") {
        this.set({ ...this.current, submit: "accepted", outcome });
        this.host.focus("done");
        return;
      }
      const gone = outcome.source === "disposed" || outcome.source === "no-handler";
      this.set({ ...this.current, submit: "rejected", outcome, handlerGone: this.current.handlerGone || gone });
    });
  }

  /** Whether some handler can still pin: the routed handler is v2 and its provider answers list. */
  setPinAvailable(available: boolean): void {
    if (this.disposed || this.current.pinAvailable === available) return;
    this.set({ ...this.current, pinAvailable: available });
  }

  /** The guest says the selected element left the document (or was replaced). Keeps the typed comment. */
  elementChanged(): void {
    if (this.disposed) return;
    // The bridge is in hold the moment the guest sends its select, but the popover only exists after the screenshot
    // (up to 2 s). A gone report in that window is remembered, never dropped.
    if (this.current.phase === "pick") { this.pendingGone = true; return; }
    if (this.current.phase !== "popover" || this.current.elementGone) return;
    this.set({ ...this.current, elementGone: true });
  }

  /** The guest reports the SAME node connected again (the page re-attached it): the gone state clears. */
  elementReturned(): void {
    if (this.disposed) return;
    this.pendingGone = false;
    if (this.current.phase === "popover" && this.current.elementGone) this.set({ ...this.current, elementGone: false });
  }

  /** "Pick again" after the element vanished: back to pick mode, with the typed comment carried into the next selection. */
  repick(): boolean {
    if (this.disposed || this.current.phase !== "popover" || !this.current.elementGone || this.current.submit === "pending") return false;
    const draft = this.current.comment;
    const origin = this.origin;
    this.token++;
    this.pendingGone = false;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone, pinAvailable: this.current.pinAvailable });
    this.draft = draft;
    this.host.setGuestMode("pick");
    this.host.focus(origin);
    return true;
  }

  /** The Cancel button. Refused (false) while a submission is pending. */
  cancel(): boolean {
    if (this.current.phase !== "popover" || this.current.submit === "pending") return false;
    if (this.current.submit === "accepted") { this.done(); return true; }
    this.token++;
    this.draft = "";
    this.pendingGone = false;
    const origin = this.origin;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone, pinAvailable: this.current.pinAvailable });
    this.host.setGuestMode("pick");
    this.host.focus(origin);
    return true;
  }

  /** Done after an accepted submission: single-shot, so pick mode ends. */
  done(): void {
    if (this.current.phase !== "popover" || this.current.submit === "pending") return;
    // A saved pin hands focus to the pin layer (its new badge when placed, else the toggle); the view decides which.
    if (this.current.submit === "accepted" && this.current.action === "pin") { this.exit(null); this.host.focus("pins"); return; }
    this.exit(this.origin);
  }

  /**
   * Esc, in the fixed D8 order. Returns whether the key was consumed:
   * pending popover ignores it (consumed), another popover state cancels or
   * closes, pick without a popover exits, off does not handle it.
   */
  escape(): boolean {
    switch (this.current.phase) {
      case "off": return false;
      case "pick": this.exit("toggle"); return true;
      case "popover":
        if (this.current.submit === "pending") return true;
        this.cancel();
        return true;
    }
  }

  /** Esc seen natively by the guest; identical rules. */
  cancelFromGuest(): boolean { return this.escape(); }

  /** The toolbar Capture button: pick mode must be off so the highlight cannot appear in the capture. */
  captureRequested(): void {
    if (this.current.phase === "off" || this.current.submit === "pending") return;
    this.exit(null);
  }

  /** The guest announced a new document. Pick mode re-arms itself (the bridge re-sends the mode); an open popover goes stale. */
  pageReloaded(): void {
    if (this.current.phase !== "popover" || this.current.stale) return;
    this.set({ ...this.current, stale: true });
  }

  /** Whether some handler can still receive feedback for this artifact. */
  setAvailable(available: boolean): void {
    if (this.disposed) return;
    if (!available) {
      if (this.current.phase === "pick") { this.exit(null); return; }
      if (this.current.phase === "popover" && !this.current.handlerGone) this.set({ ...this.current, handlerGone: true });
      return;
    }
    if (this.current.handlerGone) this.set({ ...this.current, handlerGone: false });
  }

  /** Immediately leave pick/popover mode (e.g. when Web Viewer starts a cross-document navigation or fails load). */
  forceExit(): void {
    if (this.disposed || this.current.phase === "off") return;
    this.exit(null);
  }

  /** Refresh host-dependent view state (e.g. when async thread list readiness changes). */
  notifyChanged(): void {
    if (this.disposed) return;
    this.host.changed(this.current);
  }

  dispose(): void {
    this.disposed = true;
    this.token++;
  }

  private exit(focus: FocusOrigin | null): void {
    this.token++;
    this.draft = "";
    this.pendingGone = false;
    this.set({ ...IDLE, handlerGone: this.current.handlerGone, pinAvailable: this.current.pinAvailable });
    this.host.setGuestMode("off");
    if (focus) this.host.focus(focus);
  }

  private set(next: PickState<TSnapshot, TOutcome>): void {
    this.current = next;
    this.host.changed(next);
  }
}

import type { ArtifactFeedbackOutcome } from "./feedback-registry";
import type { SelectionSnapshot } from "../views/artifact-inspector-bridge";

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
export type FocusTarget = "toggle" | "guest" | "comment" | "done";
/** Which element held focus when the user picked; where focus returns when the popover is cancelled. */
export type FocusOrigin = "toggle" | "guest";

export interface PickState {
  readonly phase: PickPhase;
  readonly submit: PopoverSubmitState;
  readonly snapshot: SelectionSnapshot | null;
  readonly comment: string;
  readonly outcome: ArtifactFeedbackOutcome | null;
  /** The page reloaded while the popover was open; the selection may describe a different document. */
  readonly stale: boolean;
  /** No handler can receive this comment any more; Send is disabled. */
  readonly handlerGone: boolean;
  /** The page removed or replaced the selected element (Phase 2a); Send is disabled until the user picks again. */
  readonly elementGone: boolean;
}

export interface PickControllerHost {
  setGuestMode(mode: "pick" | "off"): void;
  submit(snapshot: SelectionSnapshot, comment: string): Promise<ArtifactFeedbackOutcome>;
  focus(target: FocusTarget): void;
  changed(state: PickState): void;
}

const IDLE: PickState = { phase: "off", submit: "idle", snapshot: null, comment: "", outcome: null, stale: false, handlerGone: false, elementGone: false };

export class PickController {
  private current: PickState = IDLE;
  private origin: FocusOrigin = "toggle";
  /** Bumped whenever a submit's result should no longer be applied. */
  private token = 0;
  private disposed = false;
  /** Text carried from a popover whose element vanished into the next selection (never past leaving pick mode). */
  private draft = "";

  constructor(private readonly host: PickControllerHost) {}

  get state(): PickState { return this.current; }

  toggle(via: "pointer" | "keyboard"): void {
    if (this.current.phase === "off") this.enter(via);
    else if (this.current.submit !== "pending") this.exit("toggle");
  }

  enter(via: "pointer" | "keyboard"): void {
    if (this.disposed || this.current.phase !== "off") return;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone });
    this.host.setGuestMode("pick");
    // A keyboard user must land in the page so it receives [ ] Enter Esc natively.
    if (via === "keyboard") this.host.focus("guest");
  }

  /** A validated selection from the guest. The bridge is already in hold. */
  selected(snapshot: SelectionSnapshot, origin: FocusOrigin): void {
    if (this.disposed || this.current.phase !== "pick") return;
    this.origin = origin;
    const draft = this.draft;
    this.draft = "";
    this.set({ ...IDLE, phase: "popover", snapshot, comment: draft });
    this.host.focus("comment");
  }

  setComment(text: string): void {
    const { phase, submit } = this.current;
    if (phase !== "popover" || (submit !== "idle" && submit !== "rejected")) return;
    this.set({ ...this.current, comment: text });
  }

  canSend(): boolean {
    const { phase, submit, comment, handlerGone } = this.current;
    return phase === "popover" && (submit === "idle" || submit === "rejected") && !handlerGone && !this.current.elementGone && comment.trim().length > 0;
  }

  canCancel(): boolean {
    return this.current.phase === "popover" && this.current.submit !== "pending";
  }

  /** Send, or Retry after a rejection: the same snapshot, so the same selectionId. */
  send(): void {
    if (this.disposed || !this.canSend()) return;
    const snapshot = this.current.snapshot!;
    const token = ++this.token;
    this.set({ ...this.current, submit: "pending", outcome: null });
    void this.host.submit(snapshot, this.current.comment).then((outcome) => {
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

  /** The guest says the selected element left the document (or was replaced). Keeps the typed comment. */
  elementChanged(): void {
    if (this.disposed || this.current.phase !== "popover" || this.current.elementGone) return;
    this.set({ ...this.current, elementGone: true });
  }

  /** "Pick again" after the element vanished: back to pick mode, with the typed comment carried into the next selection. */
  repick(): boolean {
    if (this.disposed || this.current.phase !== "popover" || !this.current.elementGone || this.current.submit === "pending") return false;
    const draft = this.current.comment;
    const origin = this.origin;
    this.token++;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone });
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
    const origin = this.origin;
    this.set({ ...IDLE, phase: "pick", handlerGone: this.current.handlerGone });
    this.host.setGuestMode("pick");
    this.host.focus(origin);
    return true;
  }

  /** Done after an accepted submission: single-shot, so pick mode ends. */
  done(): void {
    if (this.current.phase === "popover" && this.current.submit !== "pending") this.exit(this.origin);
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

  dispose(): void {
    this.disposed = true;
    this.token++;
  }

  private exit(focus: FocusOrigin | null): void {
    this.token++;
    this.draft = "";
    this.set({ ...IDLE, handlerGone: this.current.handlerGone });
    this.host.setGuestMode("off");
    if (focus) this.host.focus(focus);
  }

  private set(next: PickState): void {
    this.current = next;
    this.host.changed(next);
  }
}

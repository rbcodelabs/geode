import { describe, expect, it } from "vitest";
import type { ArtifactFeedbackOutcome } from "../../src/renderer/artifacts/feedback-registry";
import {
  PickController,
  type FocusTarget,
  type PickControllerHost,
  type PickState,
} from "../../src/renderer/artifacts/pick-controller";
import type { SelectionSnapshot } from "../../src/renderer/views/artifact-inspector-bridge";

const snapshot = (id = "sel_aaaa"): SelectionSnapshot =>
  ({ selection: { selectionId: id }, screenshot: null, screenshotOmitted: "vault-read" }) as unknown as SelectionSnapshot;

interface Deferred { resolve(outcome: ArtifactFeedbackOutcome): void }

function setup() {
  const modes: string[] = [];
  const focuses: FocusTarget[] = [];
  const submits: Array<{ snapshot: SelectionSnapshot; comment: string; deferred: Deferred }> = [];
  const changes: PickState[] = [];
  const host: PickControllerHost = {
    setGuestMode: (mode) => { modes.push(mode); },
    focus: (target) => { focuses.push(target); },
    changed: (state) => { changes.push(state); },
    submit: (snap, comment) => new Promise<ArtifactFeedbackOutcome>((resolve) => { submits.push({ snapshot: snap, comment, deferred: { resolve } }); }),
  };
  const controller = new PickController(host);
  return { controller, modes, focuses, submits, changes };
}

const accepted = (message?: string): ArtifactFeedbackOutcome => ({ status: "accepted", ...(message ? { message } : {}), source: "handler" });
const rejected = (message: string, source: ArtifactFeedbackOutcome["source"] = "handler"): ArtifactFeedbackOutcome =>
  ({ status: "rejected", reason: "failed", message, source });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** pick mode on, one element selected, comment typed. */
function selected(comment = "Make this bigger") {
  const ctx = setup();
  ctx.controller.enter("pointer");
  ctx.controller.selected(snapshot(), "toggle");
  ctx.controller.setComment(comment);
  return ctx;
}

describe("PickController: entering and leaving pick mode", () => {
  it("starts off and toggles pick on and off, telling the guest each time", () => {
    const { controller, modes } = setup();
    expect(controller.state.phase).toBe("off");
    controller.toggle("pointer");
    expect(controller.state.phase).toBe("pick");
    controller.toggle("pointer");
    expect(controller.state.phase).toBe("off");
    expect(modes).toEqual(["pick", "off"]);
  });

  it("moves focus into the guest when turned on by keyboard so [ ] Enter Esc reach the page", () => {
    const { controller, focuses } = setup();
    controller.enter("keyboard");
    expect(focuses).toEqual(["guest"]);
  });

  it("leaves focus on the toggle when turned on with the pointer", () => {
    const { controller, focuses } = setup();
    controller.enter("pointer");
    expect(focuses).toEqual([]);
  });

  it("turning it off through the toggle returns focus to the toggle", () => {
    const { controller, focuses } = setup();
    controller.enter("pointer");
    controller.toggle("pointer");
    expect(focuses).toEqual(["toggle"]);
  });

  it("Capture turns pick mode off first", () => {
    const { controller, modes } = setup();
    controller.enter("pointer");
    controller.captureRequested();
    expect(controller.state.phase).toBe("off");
    expect(modes).toEqual(["pick", "off"]);
  });

  it("does nothing for Capture while off", () => {
    const { controller, modes } = setup();
    controller.captureRequested();
    expect(modes).toEqual([]);
  });
});

describe("PickController: single-shot selection", () => {
  it("opens the popover in idle on a selection and focuses the comment box", () => {
    const { controller, focuses } = setup();
    controller.enter("pointer");
    controller.selected(snapshot("sel_1"), "toggle");
    expect(controller.state.phase).toBe("popover");
    expect(controller.state.submit).toBe("idle");
    expect(controller.state.snapshot?.selection.selectionId).toBe("sel_1");
    expect(focuses.at(-1)).toBe("comment");
  });

  it("ignores a second selection while the popover is open", () => {
    const { controller } = setup();
    controller.enter("pointer");
    controller.selected(snapshot("sel_1"), "toggle");
    controller.selected(snapshot("sel_2"), "toggle");
    expect(controller.state.snapshot?.selection.selectionId).toBe("sel_1");
  });

  it("ignores a selection that arrives while pick mode is off", () => {
    const { controller } = setup();
    controller.selected(snapshot(), "guest");
    expect(controller.state.phase).toBe("off");
  });

  it("exits pick mode after an accepted submission is dismissed (single shot)", async () => {
    const { controller, modes, submits, focuses } = selected();
    controller.send();
    submits[0]!.deferred.resolve(accepted());
    await flush();
    expect(controller.state.submit).toBe("accepted");
    expect(focuses.at(-1)).toBe("done");
    controller.done();
    expect(controller.state.phase).toBe("off");
    expect(modes.at(-1)).toBe("off");
    expect(focuses.at(-1)).toBe("toggle");
  });
});

describe("PickController: sending", () => {
  it("does not send an empty or whitespace-only comment", () => {
    const { controller, submits } = selected("   ");
    controller.send();
    expect(submits).toHaveLength(0);
    expect(controller.canSend()).toBe(false);
  });

  it("goes pending and calls the host once, even if Send is pressed twice", () => {
    const { controller, submits } = selected("Tighten the spacing");
    controller.send();
    controller.send();
    expect(controller.state.submit).toBe("pending");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.comment).toBe("Tighten the spacing");
  });

  it("cannot be edited or cancelled while pending, and Esc is ignored", () => {
    const { controller, submits } = selected();
    controller.send();
    controller.setComment("changed while pending");
    expect(controller.state.comment).toBe("Make this bigger");
    expect(controller.cancel()).toBe(false);
    expect(controller.escape()).toBe(true); // consumed, but does nothing
    expect(controller.state.phase).toBe("popover");
    expect(controller.state.submit).toBe("pending");
    expect(controller.canCancel()).toBe(false);
    expect(submits).toHaveLength(1);
  });

  it("shows a rejection, keeps the text, enables Cancel, and Retry reuses the same selection", async () => {
    const { controller, submits } = selected("Please fix");
    controller.send();
    submits[0]!.deferred.resolve(rejected("Another comment is still waiting."));
    await flush();
    expect(controller.state.submit).toBe("rejected");
    expect(controller.state.outcome?.message).toBe("Another comment is still waiting.");
    expect(controller.state.comment).toBe("Please fix");
    expect(controller.canCancel()).toBe(true);
    controller.send(); // Retry
    expect(controller.state.submit).toBe("pending");
    expect(submits).toHaveLength(2);
    expect(submits[1]!.snapshot).toBe(submits[0]!.snapshot);
    expect(submits[1]!.snapshot.selection.selectionId).toBe("sel_aaaa");
  });

  it("allows editing the comment after a rejection, then retrying with the new text", async () => {
    const { controller, submits } = selected("Please fix");
    controller.send();
    submits[0]!.deferred.resolve(rejected("No."));
    await flush();
    controller.setComment("Please fix the colour");
    controller.send();
    expect(submits[1]!.comment).toBe("Please fix the colour");
  });

  it("keeps the source on a synthetic timeout so the view can word it differently", async () => {
    const { controller, submits } = selected();
    controller.send();
    submits[0]!.deferred.resolve(rejected("No response from Design in 15 s.", "timeout"));
    await flush();
    expect(controller.state.outcome?.source).toBe("timeout");
    expect(controller.state.submit).toBe("rejected");
  });

  it("disables Send when the handler vanished (disposed outcome) but allows Cancel", async () => {
    const { controller, submits } = selected();
    controller.send();
    submits[0]!.deferred.resolve(rejected("Design is no longer available.", "disposed"));
    await flush();
    expect(controller.state.handlerGone).toBe(true);
    expect(controller.canSend()).toBe(false);
    controller.send();
    expect(submits).toHaveLength(1);
    expect(controller.canCancel()).toBe(true);
  });

  it("ignores a late outcome after the popover was cancelled", async () => {
    const { controller, submits } = selected();
    controller.send();
    submits[0]!.deferred.resolve(rejected("x"));
    await flush();
    controller.cancel();
    expect(controller.state.phase).toBe("pick");
    // a second, stale promise settling now must not touch the state
    controller.selected(snapshot("sel_2"), "toggle");
    expect(controller.state.submit).toBe("idle");
  });

  it("ignores an outcome that settles after dispose", async () => {
    const { controller, submits, changes } = selected();
    controller.send();
    controller.dispose();
    const before = changes.length;
    submits[0]!.deferred.resolve(accepted());
    await flush();
    expect(changes.length).toBe(before);
  });
});

describe("PickController: Escape order", () => {
  it("returns false (not handled) while off", () => {
    const { controller } = setup();
    expect(controller.escape()).toBe(false);
  });

  it("exits pick mode when no popover is open and returns focus to the toggle", () => {
    const { controller, modes, focuses } = setup();
    controller.enter("pointer");
    expect(controller.escape()).toBe(true);
    expect(controller.state.phase).toBe("off");
    expect(modes.at(-1)).toBe("off");
    expect(focuses.at(-1)).toBe("toggle");
  });

  it("cancels an idle popover back to pick mode and re-arms the guest", () => {
    const { controller, modes, focuses } = selected();
    modes.length = 0;
    expect(controller.escape()).toBe(true);
    expect(controller.state.phase).toBe("pick");
    expect(modes).toEqual(["pick"]);
    expect(focuses.at(-1)).toBe("toggle");
    expect(controller.state.snapshot).toBeNull();
    expect(controller.state.comment).toBe("");
  });

  it("restores focus to the guest for a pick that started with focus in the page", () => {
    const { controller, focuses } = setup();
    controller.enter("keyboard");
    controller.selected(snapshot(), "guest");
    controller.escape();
    expect(focuses.at(-1)).toBe("guest");
  });

  it("a second Esc then leaves pick mode", () => {
    const { controller } = selected();
    controller.escape();
    controller.escape();
    expect(controller.state.phase).toBe("off");
  });

  it("cancels a rejected popover", async () => {
    const { controller, submits } = selected();
    controller.send();
    submits[0]!.deferred.resolve(rejected("No."));
    await flush();
    controller.escape();
    expect(controller.state.phase).toBe("pick");
  });

  it("closes an accepted popover and exits pick mode", async () => {
    const { controller, submits, modes } = selected();
    controller.send();
    submits[0]!.deferred.resolve(accepted("Queued."));
    await flush();
    controller.escape();
    expect(controller.state.phase).toBe("off");
    expect(modes.at(-1)).toBe("off");
  });

  it("treats a guest-native Escape exactly like the embedder's", () => {
    const { controller } = selected();
    expect(controller.cancelFromGuest()).toBe(true);
    expect(controller.state.phase).toBe("pick");
    expect(controller.cancelFromGuest()).toBe(true);
    expect(controller.state.phase).toBe("off");
    expect(controller.cancelFromGuest()).toBe(false);
  });
});

describe("PickController: external changes", () => {
  it("marks an open popover stale when the page reloads", () => {
    const { controller } = selected();
    controller.pageReloaded();
    expect(controller.state.stale).toBe(true);
  });

  it("does not mark anything stale while only picking", () => {
    const { controller } = setup();
    controller.enter("pointer");
    controller.pageReloaded();
    expect(controller.state.stale).toBe(false);
    expect(controller.state.phase).toBe("pick");
  });

  it("exits pick mode when the last handler goes away", () => {
    const { controller, modes } = setup();
    controller.enter("pointer");
    controller.setAvailable(false);
    expect(controller.state.phase).toBe("off");
    expect(modes.at(-1)).toBe("off");
  });

  it("keeps an idle popover open but disables Send when the handler goes away", () => {
    const { controller } = selected();
    controller.setAvailable(false);
    expect(controller.state.phase).toBe("popover");
    expect(controller.state.handlerGone).toBe(true);
    expect(controller.canSend()).toBe(false);
    controller.setAvailable(true);
    expect(controller.canSend()).toBe(true);
  });

  it("captureRequested closes an idle popover too, but never a pending one", () => {
    const idle = selected();
    idle.controller.captureRequested();
    expect(idle.controller.state.phase).toBe("off");

    const pending = selected();
    pending.controller.send();
    pending.controller.captureRequested();
    expect(pending.controller.state.phase).toBe("popover");
  });

  it("notifies the host on every state change", () => {
    const { controller, changes } = setup();
    controller.enter("pointer");
    controller.selected(snapshot(), "toggle");
    controller.setComment("hi");
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.at(-1)?.comment).toBe("hi");
  });
});

describe("PickController: focus after a completed pick", () => {
  it("returns focus to the page when the pick began with focus in the page (ADR: restore what held it)", async () => {
    const { controller, submits, focuses } = setup();
    controller.enter("keyboard");
    controller.selected(snapshot(), "guest");
    controller.setComment("Looks off");
    controller.send();
    submits[0]!.deferred.resolve(accepted());
    await flush();
    controller.done();
    expect(focuses.at(-1)).toBe("guest");
  });
});

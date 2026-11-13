import { describe, expect, it } from "vitest";
import type { ArtifactFeedbackOutcome } from "../../src/renderer/artifacts/feedback-registry";
import { PickController, type FocusTarget, type PickControllerHost, type PickState } from "../../src/renderer/artifacts/pick-controller";
import type { SelectionSnapshot } from "../../src/renderer/views/artifact-inspector-bridge";

/** Phase 2b-i G3: the Pin action of the popover (idle -> pending -> accepted; rejected keeps the text; handler gone). */

const snapshot = (id = "sel_aaaa"): SelectionSnapshot =>
  ({ selection: { selectionId: id }, screenshot: null, screenshotOmitted: "vault-read" }) as unknown as SelectionSnapshot;

function setup(options: { pin?: boolean } = {}) {
  const modes: string[] = [];
  const focuses: FocusTarget[] = [];
  const sends: Array<(o: ArtifactFeedbackOutcome) => void> = [];
  const pins: Array<{ snapshot: SelectionSnapshot; comment: string; resolve: (o: ArtifactFeedbackOutcome) => void }> = [];
  const changes: PickState[] = [];
  const host: PickControllerHost = {
    setGuestMode: (m) => { modes.push(m); },
    focus: (t) => { focuses.push(t); },
    changed: (s) => { changes.push(s); },
    submit: () => new Promise((resolve) => { sends.push(resolve); }),
    ...(options.pin === false ? {} : { pin: (snap: SelectionSnapshot, comment: string) => new Promise<ArtifactFeedbackOutcome>((resolve) => { pins.push({ snapshot: snap, comment, resolve }); }) }),
  };
  const controller = new PickController(host);
  return { controller, modes, focuses, sends, pins, changes };
}
const accepted = (message?: string): ArtifactFeedbackOutcome => ({ status: "accepted", ...(message ? { message } : {}), source: "handler" });
const rejected = (message: string, source: ArtifactFeedbackOutcome["source"] = "handler"): ArtifactFeedbackOutcome => ({ status: "rejected", reason: "failed", message, source });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function selected(comment = "Larger please") {
  const ctx = setup();
  ctx.controller.setPinAvailable(true);
  ctx.controller.enter("pointer");
  ctx.controller.selected(snapshot(), "toggle");
  ctx.controller.setComment(comment);
  return ctx;
}

describe("Pin availability", () => {
  it("starts unavailable; canPin needs availability, a comment and a usable popover", () => {
    const ctx = setup();
    ctx.controller.enter("pointer");
    ctx.controller.selected(snapshot(), "toggle");
    ctx.controller.setComment("x");
    expect(ctx.controller.canPin()).toBe(false);
    ctx.controller.setPinAvailable(true);
    expect(ctx.controller.canPin()).toBe(true);
    expect(ctx.controller.state.pinAvailable).toBe(true);
    ctx.controller.setComment("   ");
    expect(ctx.controller.canPin()).toBe(false);
  });

  it("a host without a pin function can never pin", () => {
    const ctx = setup({ pin: false });
    ctx.controller.setPinAvailable(true);
    ctx.controller.enter("pointer");
    ctx.controller.selected(snapshot(), "toggle");
    ctx.controller.setComment("x");
    expect(ctx.controller.canPin()).toBe(false);
    ctx.controller.pin();
    expect(ctx.controller.state.submit).toBe("idle");
  });

  it("losing availability while the popover is open disables Pin but not Send", () => {
    const ctx = selected();
    ctx.controller.setPinAvailable(false);
    expect(ctx.controller.canPin()).toBe(false);
    expect(ctx.controller.canSend()).toBe(true);
  });

  it("availability survives leaving pick mode", () => {
    const ctx = selected();
    ctx.controller.cancel();
    ctx.controller.escape();
    expect(ctx.controller.state.pinAvailable).toBe(true);
  });
});

describe("Pin submit state", () => {
  it("idle -> pending -> accepted, with the same snapshot and the trimmed-by-host comment", async () => {
    const ctx = selected("Larger please");
    ctx.controller.pin();
    expect(ctx.controller.state).toMatchObject({ submit: "pending", action: "pin" });
    expect(ctx.pins).toHaveLength(1);
    expect(ctx.pins[0]!.comment).toBe("Larger please");
    expect(ctx.sends).toHaveLength(0);
    ctx.pins[0]!.resolve(accepted("Pinned as comment 3."));
    await flush();
    expect(ctx.controller.state).toMatchObject({ submit: "accepted", action: "pin" });
    expect(ctx.controller.state.outcome?.message).toBe("Pinned as comment 3.");
    expect(ctx.focuses.at(-1)).toBe("done");
  });

  it("is ignored while pending and while the comment is empty", () => {
    const ctx = selected("ok");
    ctx.controller.pin();
    ctx.controller.pin();
    expect(ctx.pins).toHaveLength(1);
    const empty = setup();
    empty.controller.setPinAvailable(true);
    empty.controller.enter("pointer");
    empty.controller.selected(snapshot(), "toggle");
    empty.controller.pin();
    expect(empty.pins).toHaveLength(0);
  });

  it("a rejection keeps the typed text and allows retry with the same selection id", async () => {
    const ctx = selected("Keep this text");
    ctx.controller.pin();
    ctx.pins[0]!.resolve(rejected("That is too many comments."));
    await flush();
    expect(ctx.controller.state).toMatchObject({ submit: "rejected", action: "pin", comment: "Keep this text" });
    expect(ctx.controller.canPin()).toBe(true);
    ctx.controller.pin();
    expect(ctx.pins).toHaveLength(2);
    expect(ctx.pins[1]!.snapshot).toBe(ctx.pins[0]!.snapshot);
    expect(ctx.pins[1]!.comment).toBe("Keep this text");
  });

  it("editing is allowed after a rejection, locked while pending and after acceptance", async () => {
    const ctx = selected("a");
    ctx.controller.pin();
    ctx.controller.setComment("b");
    expect(ctx.controller.state.comment).toBe("a");
    ctx.pins[0]!.resolve(rejected("no"));
    await flush();
    ctx.controller.setComment("c");
    expect(ctx.controller.state.comment).toBe("c");
  });

  it("a handler that vanished mid-pin disables both Send and Pin", async () => {
    const ctx = selected();
    ctx.controller.pin();
    ctx.pins[0]!.resolve(rejected("Design was unloaded before it answered.", "disposed"));
    await flush();
    expect(ctx.controller.state.handlerGone).toBe(true);
    expect(ctx.controller.canPin()).toBe(false);
    expect(ctx.controller.canSend()).toBe(false);
  });

  it("Cancel is refused while pending and does not apply a late result", async () => {
    const ctx = selected();
    ctx.controller.pin();
    expect(ctx.controller.cancel()).toBe(false);
    expect(ctx.controller.escape()).toBe(true);
    expect(ctx.controller.state.submit).toBe("pending");
  });

  it("a result that arrives after the controller left the popover is ignored", async () => {
    const ctx = selected();
    ctx.controller.pin();
    ctx.controller.dispose();
    ctx.pins[0]!.resolve(accepted());
    await flush();
    expect(ctx.controller.state.submit).toBe("pending");
  });

  it("Done after an accepted pin ends pick mode and asks the view to focus the pin layer", async () => {
    const ctx = selected();
    ctx.controller.pin();
    ctx.pins[0]!.resolve(accepted("Pinned."));
    await flush();
    ctx.controller.done();
    expect(ctx.controller.state.phase).toBe("off");
    expect(ctx.focuses.at(-1)).toBe("pins");
    expect(ctx.modes.at(-1)).toBe("off");
  });

  it("Send still behaves as before and records action send", async () => {
    const ctx = selected();
    ctx.controller.send();
    expect(ctx.controller.state).toMatchObject({ submit: "pending", action: "send" });
    ctx.sends[0]!(accepted());
    await flush();
    ctx.controller.done();
    expect(ctx.focuses.at(-1)).not.toBe("pins");
  });

  it("repick after the element vanished keeps the text (pin disabled while gone)", () => {
    const ctx = selected("Carry me");
    ctx.controller.elementChanged();
    expect(ctx.controller.canPin()).toBe(false);
    expect(ctx.controller.repick()).toBe(true);
    ctx.controller.selected(snapshot("sel_bbbb"), "toggle");
    expect(ctx.controller.state.comment).toBe("Carry me");
    expect(ctx.controller.canPin()).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/renderer/workspace";

describe("Workspace autosave pause transaction", () => {
  it("keeps a sync hold across ordinary reconcile resume", async () => {
    const view = { pauseAutosave: vi.fn(async () => {}), resumeAutosave: vi.fn() };
    const workspace = Object.create(Workspace.prototype);
    workspace.iterateLeaves = (callback: Function) => callback({ view });
    await workspace.holdAutosave("sync");
    await workspace.pauseAutosave(); workspace.resumeAutosave();
    expect(view.resumeAutosave).not.toHaveBeenCalled();
    workspace.releaseAutosaveHold("sync"); expect(view.resumeAutosave).toHaveBeenCalledOnce();
  });

  it("does not strand a writer when a timed-out hold finishes pausing late", async () => {
    let finish!: () => void;
    const view = { pauseAutosave: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), resumeAutosave: vi.fn() };
    const workspace = Object.create(Workspace.prototype);
    workspace.iterateLeaves = (callback: Function) => callback({ view });
    const pending = workspace.holdAutosave("sync");
    workspace.releaseAutosaveHold("sync"); finish();
    expect(await pending).toBe(false); expect(view.resumeAutosave).toHaveBeenCalled();
  });
  it("rolls back every already-paused writer, including the writer whose pause rejects", async () => {
    const first = { pauseAutosave: vi.fn(async () => {}), resumeAutosave: vi.fn() };
    const failing = { pauseAutosave: vi.fn(async () => { throw new Error("pause failed"); }), resumeAutosave: vi.fn() };
    const untouched = { pauseAutosave: vi.fn(async () => {}), resumeAutosave: vi.fn() };
    const workspace = {
      iterateLeaves(callback: (leaf: { view: typeof first | typeof failing | typeof untouched }) => void) {
        for (const view of [first, failing, untouched]) callback({ view });
      },
    };

    await expect(Workspace.prototype.pauseAutosave.call(workspace)).rejects.toThrow("pause failed");
    expect(first.resumeAutosave).toHaveBeenCalledOnce();
    expect(failing.resumeAutosave).toHaveBeenCalledOnce();
    expect(untouched.pauseAutosave).not.toHaveBeenCalled();
  });
});

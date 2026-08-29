import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/renderer/workspace";

describe("Workspace autosave pause transaction", () => {
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

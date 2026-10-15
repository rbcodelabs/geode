import { describe, expect, it, vi } from "vitest";
import { preflightLayoutWriters, settleLayoutWriters } from "../../src/renderer/workspaces/layout-writers";
function writer(path: string, text: string, dirty = true) {
  return { path, text, dirty, error: null as string | null, preflight: vi.fn(() => {}), pause: vi.fn(async () => {}), settle: vi.fn(async function(this: any) { this.dirty = false; }), resume: vi.fn(), getText() { return this.text; }, hasChanges() { return this.dirty; } };
}
describe("named layout writer safety", () => {
  it("rejects all differing same-path buffers before any writer is flushed", () => {
    const first = writer("Note.md", "one"); const second = writer("Note.md", "two");
    expect(() => preflightLayoutWriters([first, second])).toThrow(/different/i);
    expect(first.settle).not.toHaveBeenCalled(); expect(second.settle).not.toHaveBeenCalled();
  });
  it("retains dirty evidence across more than two duplicate buffers", () => {
    const dirty = writer("Note.md", "one"); const clean = writer("Note.md", "one", false); const different = writer("Note.md", "two", false);
    expect(() => preflightLayoutWriters([dirty, clean, different])).toThrow(/different/i);
  });
  it("preflights every writer before pausing and rejects conflict/recovery", () => {
    const first = writer("Note.md", "one"); const second = writer("Canvas.canvas", "{}", false); second.preflight.mockImplementation(() => { throw new Error("recovery"); });
    expect(() => preflightLayoutWriters([first, second])).toThrow("recovery"); expect(first.pause).not.toHaveBeenCalled();
  });
  it("pauses the complete set before settling, proves clean state, and returns a resume handle", async () => {
    const first = writer("Note.md", "one"); const second = writer("Canvas.canvas", "{}"); const order: string[] = [];
    for (const [index, value] of [first, second].entries()) { value.pause.mockImplementation(async () => { order.push(`pause${index}`); }); value.settle.mockImplementation(async () => { order.push(`settle${index}`); value.dirty = false; }); }
    const resume = await settleLayoutWriters([first, second]); expect(order).toEqual(["pause0", "pause1", "settle0", "settle1"]);
    resume(new Set([first])); expect(first.resume).toHaveBeenCalledOnce(); expect(second.resume).not.toHaveBeenCalled();
  });
  it("resumes all paused writers if pause or flush fails, preserving the old layout", async () => {
    const first = writer("Note.md", "one"); const second = writer("Canvas.canvas", "{}"); second.pause.mockRejectedValue(new Error("save failed"));
    await expect(settleLayoutWriters([first, second])).rejects.toThrow("save failed"); expect(first.resume).toHaveBeenCalledOnce(); expect(second.resume).toHaveBeenCalledOnce(); expect(first.settle).not.toHaveBeenCalled();
  });
  it("refuses a still-dirty writer after settling", async () => {
    const value = writer("Note.md", "one"); value.settle.mockImplementation(async () => {});
    await expect(settleLayoutWriters([value])).rejects.toThrow(/unacknowledged/i); expect(value.resume).toHaveBeenCalledOnce();
  });
});

it("rechecks writer identity after asynchronous settling", async () => {
  const value = writer("Note.md", "one"); let changed = false;
  value.preflight.mockImplementation(() => { if (changed) throw new Error("identity changed"); });
  value.settle.mockImplementation(async () => { value.dirty = false; changed = true; });
  await expect(settleLayoutWriters([value])).rejects.toThrow("identity changed"); expect(value.resume).toHaveBeenCalledOnce();
});

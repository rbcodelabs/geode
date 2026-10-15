import { describe, expect, it, vi } from "vitest";
const api = await import("../../src/renderer/pdf/capacity").catch(() => ({})) as typeof import("../../src/renderer/pdf/capacity");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
describe("shared PDF document admission", () => {
  it("denies the fifth before caller work, with no queue, until owned disposal finishes", async () => {
    expect(api.PdfDocumentCapacity).toBeTypeOf("function"); const capacity = new api.PdfDocumentCapacity(), reads = vi.fn(), cleanup = deferred();
    const first = capacity.acquire(() => cleanup.promise)!;
    for (let i = 0; i < 3; i++) expect(capacity.acquire(async () => {})).toBeDefined();
    const admit = () => { const lease = capacity.acquire(async () => {}); if (lease) reads(); return lease; };
    expect(admit()).toBeUndefined(); expect(reads).not.toHaveBeenCalled();
    const closing = first.close(); expect(admit()).toBeUndefined(); cleanup.resolve(); await closing;
    expect(admit()).toBeDefined(); expect(reads).toHaveBeenCalledOnce(); await capacity.closeAll();
  });
  it("serializes concurrent cleanup and retains failed cleanup for explicit retry", async () => {
    expect(api.PdfDocumentCapacity).toBeTypeOf("function"); const capacity = new api.PdfDocumentCapacity(), cleanup = vi.fn().mockRejectedValueOnce(Error("cleanup failed")).mockResolvedValue(undefined);
    const lease = capacity.acquire(cleanup)!; const first = lease.close(); expect(lease.close()).toBe(first);
    await expect(first).rejects.toThrow(/cleanup failed/); expect(capacity.size).toBe(1);
    await lease.close(); expect(capacity.size).toBe(0); expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("keeps all root-owned documents counted and drains each once on root close", async () => {
    expect(api.PdfDocumentCapacity).toBeTypeOf("function"); const owner = {}, other = {};
    const first = api.pdfDocumentCapacity(owner), same = api.pdfDocumentCapacity(owner), isolated = api.pdfDocumentCapacity(other);
    expect(first).toBe(same); expect(first).not.toBe(isolated);
    const callbacks = Array.from({ length: 4 }, () => vi.fn(async () => {})); callbacks.forEach(cleanup => first.acquire(cleanup));
    expect(first.size).toBe(4); await first.closeAll(); expect(first.size).toBe(0); callbacks.forEach(cleanup => expect(cleanup).toHaveBeenCalledOnce());
  });
});

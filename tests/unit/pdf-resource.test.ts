import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const api = await import("../../src/main/pdf-resource").catch(() => ({})) as typeof import("../../src/main/pdf-resource");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "geode-pdf-resource-")); roots.push(root); await fs.writeFile(path.join(root, "Guide.pdf"), Buffer.from("%PDF-1.7\nsynthetic bytes\x00\xff", "latin1")); return root; }
describe("authorized PDF bytes", () => {
  it("reads exact binary bytes without altering the original PDF", async () => {
    expect(api.readAuthorizedPdf).toBeTypeOf("function"); const root = await fixture(), before = await fs.readFile(path.join(root, "Guide.pdf"));
    const bytes = await api.readAuthorizedPdf({ root, expectedRoot: root, path: "Guide.pdf", current: () => true });
    expect(Buffer.from(bytes)).toEqual(before); expect(await fs.readFile(path.join(root, "Guide.pdf"))).toEqual(before);
  });
  it.each(["../Guide.pdf", "/Guide.pdf", "folder/../../Guide.pdf", "C:\\Guide.pdf", "https://example.com/Guide.pdf", "Guide.md"])("refuses unauthorized path %s", async relative => {
    const root = await fixture(); await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: relative, current: () => true })).rejects.toThrow(/PDF|vault|path/i);
  });
  it("refuses symlinks escaping the canonical root", async () => {
    const root = await fixture(), outside = await fixture(); await fs.symlink(outside, path.join(root, "escape"), "dir");
    await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: "escape/Guide.pdf", current: () => true })).rejects.toThrow(/outside|vault/i);
  });
  it("refuses foreign/stale sessions, missing, non-PDF and oversized files", async () => {
    const root = await fixture();
    await expect(api.readAuthorizedPdf({ root, expectedRoot: root + "foreign", path: "Guide.pdf", current: () => true })).rejects.toThrow(/session|vault/i);
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: "Guide.pdf", current })).rejects.toThrow(/session/i);
    await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: "Missing.pdf", current: () => true })).rejects.toThrow();
    await fs.writeFile(path.join(root, "Not.pdf"), "not a PDF"); await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: "Not.pdf", current: () => true })).rejects.toThrow(/PDF/i);
    await expect(api.readAuthorizedPdf({ root, expectedRoot: root, path: "Guide.pdf", current: () => true, limit: 10 })).rejects.toThrow(/large|limit/i);
  });
});

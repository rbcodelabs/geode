import { describe, expect, it } from "vitest";
import {
  buildConflictPath,
  buildVaultManifest,
  coalesceReconcileChanges,
  diffVaultManifests,
  stageReconcileManifest,
  reduceProviderEvents,
} from "../../src/renderer/reconciliation";

const entry = (path: string, mtime: number, size = 1, isFolder = false) => ({
  path, mtime, ctime: 1, size, isFolder,
});

describe("vault reconciliation decisions", () => {
  it("stages a complete scan without advancing the exact-vault manifest", async () => {
    const prior = buildVaultManifest("external://one", [entry("Gone.md", 1), entry("Note.md", 1)]);
    const result = await stageReconcileManifest({
      vaultId: "external://one",
      previous: prior,
      scan: async () => ({ status: "complete", entries: [entry("Note.md", 2), entry("New.md", 1)] }),
    });

    expect(result.status).toBe("complete");
    expect(result.changes).toEqual([
      expect.objectContaining({ event: "delete", path: "Gone.md" }),
      expect.objectContaining({ event: "create", path: "New.md" }),
      expect.objectContaining({ event: "modify", path: "Note.md" }),
    ]);
  });

  it.each(["partial", "cancelled", "unavailable"] as const)(
    "retains the prior durable manifest and emits no false deletes for a %s scan",
    async (status) => {
      const prior = buildVaultManifest("external://one", [entry("Keep.md", 1)]);
      const result = await stageReconcileManifest({
        vaultId: "external://one",
        previous: prior,
        scan: async () => ({ status, entries: [] }),
      });
      expect(result).toMatchObject({ status, changes: [], manifest: prior });
    },
  );

  it("coalesces duplicate provider changes into one final semantic event", () => {
    expect(coalesceReconcileChanges([
      { event: "modify", path: "Note.md", entry: entry("Note.md", 2) },
      { event: "modify", path: "Note.md", entry: entry("Note.md", 2) },
      { event: "delete", path: "Gone.md" },
      { event: "delete", path: "Gone.md" },
    ])).toEqual([
      { event: "delete", path: "Gone.md" },
      { event: "modify", path: "Note.md", entry: entry("Note.md", 2) },
    ]);
  });

  it("preserves distinct provider versions and reduces delete-create to a replacement", () => {
    expect(reduceProviderEvents([
      { event: "modify", path: "Note.md", version: "2" },
      { event: "modify", path: "Note.md", version: "3" },
    ])).toHaveLength(2);
    expect(reduceProviderEvents([
      { event: "delete", path: "Note.md" },
      { event: "create", path: "Note.md", version: "4" },
    ])).toEqual([{ event: "modify", path: "Note.md", version: "4" }]);
  });

  it("collapses an externally deleted folder subtree and represents an unproven rename as delete/create", async () => {
    const prior = buildVaultManifest("external://one", [
      entry("Folder", 1, 0, true),
      entry("Folder/A.md", 1),
    ]);
    const deleted = await stageReconcileManifest({
      vaultId: "external://one",
      previous: prior,
      scan: async () => ({ status: "complete", entries: [] }),
    });
    expect(deleted.changes).toEqual([{ event: "delete-folder", path: "Folder" }]);

    const moved = await stageReconcileManifest({
      vaultId: "external://one",
      previous: prior,
      scan: async () => ({ status: "complete", entries: [entry("Archive/A.md", 2)] }),
    });
    expect(moved.changes).toEqual([
      expect.objectContaining({ event: "create", path: "Archive/A.md" }),
      { event: "delete-folder", path: "Folder" },
    ]);
  });

  it("represents file-folder kind replacements as ordered delete-create decisions", () => {
    const prior = buildVaultManifest("external://one", [
      entry("FileBecomesFolder", 1),
      entry("FolderBecomesFile", 1, 0, true),
      entry("FolderBecomesFile/Child.md", 1),
    ]);
    const next = buildVaultManifest("external://one", [
      entry("FileBecomesFolder", 2, 0, true),
      entry("FileBecomesFolder/Child.md", 2),
      entry("FolderBecomesFile", 2),
    ]);
    expect(diffVaultManifests(prior, next)).toEqual([
      { event: "delete", path: "FileBecomesFolder" },
      expect.objectContaining({ event: "create-folder", path: "FileBecomesFolder" }),
      expect.objectContaining({ event: "create", path: "FileBecomesFolder/Child.md" }),
      { event: "delete-folder", path: "FolderBecomesFile" },
      expect.objectContaining({ event: "create", path: "FolderBecomesFile" }),
    ]);
  });
});

describe("conflict naming", () => {
  it("builds a deterministic sibling name and collision number without changing the extension", () => {
    const occupied = new Set(["Notes/Note (Geode conflict 2026-08-29 143012).md"]);
    expect(buildConflictPath("Notes/Note.md", "2026-08-29 143012", (path) => occupied.has(path)))
      .toBe("Notes/Note (Geode conflict 2026-08-29 143012) 2.md");
    expect(buildConflictPath("README", "2026-08-29 143012", () => false))
      .toBe("README (Geode conflict 2026-08-29 143012)");
  });
});

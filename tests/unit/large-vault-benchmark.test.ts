import { describe, expect, it } from "vitest";
import { formatBenchmarkReport, generatedNote, type MetadataBenchmarkReport } from "../../scripts/large-vault-benchmark-lib.mts";

describe("large-vault metadata benchmark", () => {
  it("generates stable, unique, nested notes", () => {
    expect(generatedNote(42)).toEqual(generatedNote(42));
    expect(generatedNote(42).path).not.toBe(generatedNote(43).path);
    expect(generatedNote(42).path).toMatch(/^Area-\d{2}\//);
    expect(() => generatedNote(-1)).toThrow(RangeError);
  });

  it("keeps generated links inside a non-default small fixture", () => {
    const notes = Array.from({ length: 3 }, (_, index) => generatedNote(index, 3));
    for (const note of notes) {
      const linkedIndexes = [...note.content.matchAll(/\[\[Note-(\d{5})\]\]/g)].map((match) => Number(match[1]));
      expect(linkedIndexes.length).toBeGreaterThan(0);
      expect(linkedIndexes.every((index) => index >= 0 && index < 3)).toBe(true);
    }
    expect(() => generatedNote(3, 3)).toThrow(RangeError);
  });

  it("formats both phases and counters as human-readable Markdown", () => {
    const phase = { discoveryMs: 4, durationMs: 1.25, parsedFiles: 2, reusedFiles: 8, deletedFiles: 0,
      rendererApplyMs: 2, rendererResolveMs: 3, totalInitializeMs: 5, maxEventLoopLagMs: 0.5 };
    const report: MetadataBenchmarkReport = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z",
      noteCount: 10, changedFiles: 1, newFiles: 1, simulatedIoDelayMs: 0, simulatedIoMode: "none", cold: phase, warm: phase };
    const output = formatBenchmarkReport(report);
    expect(output).toContain("| Cold | 4.0 | 1.3 | 2 | 8 |");
    expect(output).toContain("| Warm | 4.0 | 1.3 | 2 | 8 |");
  });
});

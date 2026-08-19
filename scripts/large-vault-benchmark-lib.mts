export interface GeneratedNote {
  path: string;
  content: string;
}

export interface BenchmarkPhase {
  discoveryMs: number;
  durationMs: number;
  parsedFiles: number;
  reusedFiles: number;
  deletedFiles: number;
  rendererApplyMs: number;
  rendererResolveMs: number;
  totalInitializeMs: number;
  maxEventLoopLagMs: number;
}

export interface MetadataBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  noteCount: number;
  changedFiles: number;
  newFiles: number;
  simulatedIoDelayMs: number;
  simulatedIoMode: "none" | "async" | "blocking";
  cold: BenchmarkPhase;
  warm: BenchmarkPhase;
}

/** Pure, deterministic fixture content. A fixed index always produces identical bytes. */
export function generatedNote(index: number, totalNotes = 10_000): GeneratedNote {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("note index must be a non-negative integer");
  if (!Number.isInteger(totalNotes) || totalNotes < 1 || index >= totalNotes) {
    throw new RangeError("total notes must be a positive integer greater than the note index");
  }
  const folder = `Area-${String(index % 100).padStart(2, "0")}`;
  const name = `Note-${String(index).padStart(5, "0")}`;
  const prior = index === 0 ? "Note-00000" : `Note-${String(index - 1).padStart(5, "0")}`;
  return {
    path: `${folder}/${name}.md`,
    content: `---\naliases: [Alias ${index}]\ntags: [generated, area-${index % 100}]\n---\n# ${name}\n\n` +
      `Deterministic benchmark note ${index}. Links to [[${prior}]] and [[Note-${String((index + 97) % totalNotes).padStart(5, "0")}]].\n`,
  };
}

export function formatBenchmarkReport(report: MetadataBenchmarkReport): string {
  const phase = (name: string, value: BenchmarkPhase) =>
    `| ${name} | ${value.discoveryMs.toFixed(1)} | ${value.durationMs.toFixed(1)} | ${value.parsedFiles} | ${value.reusedFiles} | ` +
    `${value.rendererApplyMs.toFixed(1)} | ${value.rendererResolveMs.toFixed(1)} | ` +
    `${value.totalInitializeMs.toFixed(1)} | ${value.maxEventLoopLagMs.toFixed(1)} |`;
  return [
    "# Geode metadata benchmark",
    "",
    `Notes: ${report.noteCount.toLocaleString()}; warm mutations: ${report.changedFiles} changed, ${report.newFiles} new.`,
    `Filesystem simulation: ${report.simulatedIoMode}, ${report.simulatedIoDelayMs.toLocaleString()} ms per stat/read operation.`,
    "",
    "| Run | Discovery/stat ms | Utility read/parse ms | Parsed | Reused | Renderer apply ms | Renderer resolve ms | Total initialize ms | Max event-loop lag ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    phase("Cold", report.cold),
    phase("Warm", report.warm),
    "",
  ].join("\n");
}

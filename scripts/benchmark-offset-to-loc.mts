import { performance } from "node:perf_hooks";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { buildLineStarts, offsetToLoc, parseMetadata } from "../src/renderer/metadata-cache.ts";

/**
 * Benchmarks the offsetToLoc fix directly: the OLD implementation re-sliced
 * `text` from offset 0 and re-scanned it with a regex on every call — O(n)
 * per call, with one call per heading/link/tag/section found while parsing
 * a file, making total parse cost O(n²) in file size. The NEW implementation
 * precomputes a lineStarts index once per file (O(n)) and binary-searches it
 * per call (O(log lines)).
 *
 * This synthesizes a large markdown document with thousands of headings and
 * links (the shape that made the bug O(n²) in practice — one offsetToLoc
 * call per node found), then times:
 *   1. The OLD approach directly (re-implemented here for comparison only —
 *      this is NOT the shipped code path anymore).
 *   2. The NEW approach directly (buildLineStarts once + offsetToLoc per call).
 *   3. End-to-end parseMetadata() on the same document, to show the effect
 *      on the actual call path users experience.
 */

function offsetToLocOld(text: string, start: number, end: number) {
  const before = text.slice(0, start);
  const line = (before.match(/\n/g) ?? []).length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const endBefore = text.slice(0, end);
  const endLine = (endBefore.match(/\n/g) ?? []).length;
  const endLineStart = endBefore.lastIndexOf("\n") + 1;
  return {
    start: { line, ch: start - lineStart, offset: start },
    end: { line: endLine, ch: end - endLineStart, offset: end },
  };
}

interface SyntheticDoc {
  text: string;
  /** [start, end) spans to resolve, one per heading/link found — mirrors parseMetadata's call pattern. */
  spans: [number, number][];
}

/** Builds a document of roughly `targetBytes` size, alternating headings and paragraphs-with-links. */
function buildSyntheticDoc(targetBytes: number): SyntheticDoc {
  const lines: string[] = [];
  const spans: [number, number][] = [];
  let offset = 0;
  let i = 0;
  while (offset < targetBytes) {
    const heading = `## Section ${i}`;
    spans.push([offset, offset + heading.length]);
    lines.push(heading);
    offset += heading.length + 1;

    const para = `Paragraph ${i} with a link to [[Note-${i}]] and another [[Note-${i + 1}|display text]] for good measure. Some filler text follows to bulk out the line length so the file reaches a realistic size per section without needing an enormous number of nodes.`;
    // Approximate offsets of the two wikilinks within `para` for realistic span widths.
    const firstLink = para.indexOf("[[Note-");
    const firstLinkEnd = para.indexOf("]]", firstLink) + 2;
    spans.push([offset + firstLink, offset + firstLinkEnd]);
    const secondLink = para.indexOf("[[Note-", firstLinkEnd);
    const secondLinkEnd = para.indexOf("]]", secondLink) + 2;
    spans.push([offset + secondLink, offset + secondLinkEnd]);
    lines.push(para);
    offset += para.length + 1;
    i++;
  }
  return { text: lines.join("\n"), spans };
}

function timeIt(label: string, fn: () => void): number {
  const started = performance.now();
  fn();
  const durationMs = performance.now() - started;
  console.log(`${label}: ${durationMs.toFixed(1)} ms`);
  return durationMs;
}

async function main() {
  const sizeArg = process.argv.find((arg) => arg.startsWith("--bytes="));
  const targetBytes = sizeArg ? Number(sizeArg.slice("--bytes=".length)) : 3_000_000; // ~3MB default
  const doc = buildSyntheticDoc(targetBytes);
  console.log(`Synthetic document: ${(doc.text.length / 1_000_000).toFixed(2)} MB, ${doc.spans.length.toLocaleString()} spans (headings + links).`);
  console.log();

  // 1. Raw offsetToLoc comparison — OLD (re-scan from zero every call).
  const oldMs = timeIt("OLD offsetToLoc (re-scan from offset 0 per call)", () => {
    for (const [start, end] of doc.spans) offsetToLocOld(doc.text, start, end);
  });

  // 2. Raw offsetToLoc comparison — NEW (lineStarts built once, binary search per call).
  const newMs = timeIt("NEW offsetToLoc (lineStarts built once + binary search per call)", () => {
    const lineStarts = buildLineStarts(doc.text);
    for (const [start, end] of doc.spans) offsetToLoc(lineStarts, start, end);
  });

  console.log();
  console.log(`Speedup (raw offsetToLoc calls): ${(oldMs / newMs).toFixed(1)}x`);
  console.log();

  // 3. End-to-end parseMetadata() on the same document — the real call path.
  const parseMs = timeIt("parseMetadata() end-to-end (current shipped implementation)", () => {
    parseMetadata(doc.text);
  });

  const resultDir = path.resolve(process.cwd(), ".benchmark-results");
  await fsp.mkdir(resultDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    docBytes: doc.text.length,
    spanCount: doc.spans.length,
    oldOffsetToLocMs: oldMs,
    newOffsetToLocMs: newMs,
    speedup: oldMs / newMs,
    parseMetadataMs: parseMs,
  };
  await fsp.writeFile(path.join(resultDir, "offset-to-loc.json"), JSON.stringify(report, null, 2) + "\n");
  console.log();
  console.log(`Report written to ${path.join(resultDir, "offset-to-loc.json")}`);
}

await main();

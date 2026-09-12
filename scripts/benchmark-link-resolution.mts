import { performance } from "node:perf_hooks";
import { resolveFirstLinkpathDest } from "../src/wiki/link-resolution";
import { createWikiSnapshot } from "../src/wiki/snapshot";

const entries = Array.from({ length: 2_000 }, (_, i) => ({ path: `folder${i % 20}/Note${i}.md`, kind: "note" as const, text: `---\naliases: [Alias${i}]\n---\n` }));
const files = new Map(entries.map(entry => [entry.path, entry]));
const byBasename = new Map(entries.map((entry, i) => [`note${i}`, [entry.path]]));
const byAlias = new Map(entries.map((entry, i) => [`alias${i}`, [entry.path]]));
const provider = { getFileByPath: (path: string) => files.get(path) ?? null, byBasename, byAlias };
byAlias.set("shared", entries.map(entry => entry.path));
const snapshot = createWikiSnapshot(entries);
const targets = ["folder1/Note1", "Note1", "Alias1", "absent", "#Heading", "folder5/Note5.md", "Note1999"];
const count = 140_000;
function measure(run: (target: string) => unknown) {
  for (let i = 0; i < count; i++) run(targets[i % targets.length]);
  const samples = [];
  for (let round = 0; round < 9; round++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) run(targets[i % targets.length]);
    samples.push(performance.now() - start);
  }
  return { samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[4], resolutionsPerSample: count };
}
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const desktop = measure(target => resolveFirstLinkpathDest(target, "folder0/Note0.md", provider));
const desktopLargeAliasBucket = measure(() => resolveFirstLinkpathDest("Shared", "folder0/Note0.md", provider));
const strict = measure(target => snapshot.resolve("folder0/Note0.md", target));
global.gc?.();
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, fixtureFiles: entries.length, desktop, desktopLargeAliasBucket, strict, heapBefore, heapAfter: process.memoryUsage().heapUsed }));

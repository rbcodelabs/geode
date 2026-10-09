import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build/audit scripts, shared with the proofs
import { buildCli } from "../../scripts/build-cli.mjs";
// @ts-expect-error see above
import { auditCliImports, SYNC_ENTRY } from "../../scripts/cli-import-audit.mjs";

/**
 * The CLI's import-rule audit must pass on the real bundle AND fail, naming the edge, when the graph is
 * broken on purpose. A passing audit that cannot fail proves nothing, so every rule has a negative here.
 */
type Inputs = Record<string, { imports: Array<{ path: string; original?: string; kind?: string }> }>;
let directory: string;
let real: Inputs;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "geode-cli-audit-"));
  const built = await buildCli({ outfile: join(directory, "geode-wiki.mjs") });
  real = built.metafile.inputs as Inputs;
}, 60_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const clone = (): Inputs => structuredClone(real);
const withEdge = (from: string, to: string): Inputs => {
  const inputs = clone();
  inputs[from] = { imports: [...(inputs[from]?.imports ?? []), { path: to, original: `./${to}`, kind: "import-statement" }] };
  inputs[to] ??= { imports: [] };
  return inputs;
};

describe("the real bundle", () => {
  it("includes the sync files and passes every rule", () => {
    const sources = Object.keys(real).filter(p => p.startsWith("src/"));
    for (const file of ["src/cli/sync.ts", "src/cli/sync-schedule.ts", "src/sync-node/index.ts", "src/sync-node/wiki-sync.ts", "src/sync-core/history-controller.ts"]) expect(sources).toContain(file);
    expect(auditCliImports(real)).toEqual([]);
  });

  it("routes the sync engine only through src/cli/sync.ts -> src/sync-node/index.ts", () => {
    const importers = Object.keys(real).filter(m => real[m].imports.some(e => e.path === SYNC_ENTRY));
    expect(importers).toEqual(["src/cli/sync.ts"]);
  });
});

describe("the audit is not vacuous: each rule fails on a broken graph and names the edge", () => {
  it("rule 1: a CLI module reaching past the entry points", () => {
    const v = auditCliImports(withEdge("src/cli/output.ts", "src/wiki/link-resolution.ts"));
    expect(v.join("\n")).toContain('src/cli/output.ts imports src/wiki/link-resolution.ts (as "./src/wiki/link-resolution.ts")');
  });
  it("rule 2: the schedule module cannot reach the sync engine (it is handed its one fact by sync.ts)", () => {
    const v = auditCliImports(withEdge("src/cli/sync-schedule.ts", SYNC_ENTRY));
    expect(v.join("\n")).toContain("only src/cli/sync.ts may import the sync engine");
    const w = auditCliImports(withEdge("src/cli/sync-schedule.ts", "src/wiki/index.ts"));
    expect(w.join("\n")).toContain("src/cli/sync-schedule.ts imports src/wiki/index.ts");
    expect(w.join("\n")).toContain("may import nothing from src/ outside src/cli/");
  });
  it("rule 1: sync.ts reaching past the sync entry point into the engine internals", () => {
    const v = auditCliImports(withEdge("src/cli/sync.ts", "src/sync-core/history-controller.ts"));
    expect(v.join("\n")).toContain("src/cli/sync.ts imports src/sync-core/history-controller.ts");
  });
  it("rule 1: the CLI importing a renderer or main-process module", () => {
    expect(auditCliImports(withEdge("src/cli/sync.ts", "src/renderer/sync/sync-service.ts")).join("\n")).toContain("src/cli/sync.ts imports src/renderer/sync/sync-service.ts");
    expect(auditCliImports(withEdge("src/cli/geode-wiki.ts", "src/main/main.ts")).join("\n")).toContain("src/cli/geode-wiki.ts imports src/main/main.ts");
  });
  it("rule 2: a non-sync CLI module importing the sync engine (and sync.ts importing the vault SDK)", () => {
    expect(auditCliImports(withEdge("src/cli/geode-wiki.ts", SYNC_ENTRY)).join("\n")).toContain("only src/cli/sync.ts may import the sync engine");
    expect(auditCliImports(withEdge("src/cli/sync.ts", "src/wiki/index.ts")).join("\n")).toContain("src/cli/sync.ts may import only src/sync-node/index.ts");
  });
  it("rule 3: sync-node reaching the renderer, sync-core reaching sync-node", () => {
    expect(auditCliImports(withEdge("src/sync-node/node-host.ts", "src/renderer/sync/sync-service.ts")).join("\n")).toContain("src/sync-node/node-host.ts imports src/renderer/sync/sync-service.ts");
    expect(auditCliImports(withEdge("src/sync-core/ports.ts", "src/sync-node/node-host.ts")).join("\n")).toContain("src/sync-core/ports.ts imports src/sync-node/node-host.ts");
  });
  it("rule 4: forbidden prefixes and un-permitted renderer files appearing in the graph", () => {
    const inputs = clone(); inputs["src/main/main.ts"] = { imports: [] }; inputs["src/renderer/app.ts"] = { imports: [] };
    const text = auditCliImports(inputs).join("\n");
    expect(text).toContain("src/main/main.ts is in the CLI graph");
    expect(text).toContain("src/renderer/app.ts is in the CLI graph");
  });
  it("rule 5: the engine importing its caller", () => {
    expect(auditCliImports(withEdge("src/sync-node/wiki-sync.ts", "src/cli/output.ts")).join("\n")).toContain("the engine must not import its callers");
    expect(auditCliImports(withEdge("src/wiki/index.ts", "src/cli/output.ts")).join("\n")).toContain("src/wiki/index.ts imports src/cli/output.ts");
  });
});

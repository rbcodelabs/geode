# Private authority and characterization migration

Task c694e1fe-546a-4b45-b612-d6f8b9f8649f, Solution a305ef82-0d46-473a-a18f-057ba6a67cb7, ADR0043. Baseline 90822e19a531e4af69276c37566b7b704beec679: actual four-mode Linux --no-sandbox proof accepted by root and independent artifact review. No product App/Markdown/Live Preview/UI/image-read hooks in this package. This plan was accepted by the coordinator and independently reviewed on 2026-10-15 before implementation. It records the bounded migration; fresh native regression and full gates remain required.

## Concrete inventory

Production-directory runtime sync parser is src/renderer/image-inspection/source.ts. Only callers of projectOwnedImages are tests/unit/image-source-projection.test.ts, image-reading-bindings.test.ts, image-source-performance.test.ts and differential image-packed-parser.test.ts. No App/Markdown/LP/product caller exists. reading-bindings.ts imports the old source.ts isImageProjectionCurrent runtime predicate; async-source.ts has the new independent WeakMap predicate. Its other source.ts imports, plus coordinator's imports, are types only. Current host bundle already excludes Lezer/markdown-references/parse-source/worker entries. Current Reading binding does not accept asynchronous projections.

Pinned original SHA256: source.ts cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335; reading-bindings.ts 7a63707fcd6c9f77c864aafabb2c214337ff1615a1d9da5a772dd701800ee324; original performance test 3a8adaecb06c7533b9fb83e3f722804a9e51f3b65a1864d6441547df4f50898d. Historical synchronous nested300k RED 13,588ms remains recorded in accepted ADR0043 and original source/log evidence; no claim that the grammar became faster.

## Options

1. Recommended: make source.ts a parser-free type facade and explicit async private projector/predicate exports; preserve original synchronous implementation only as a test baseline for differential/stock controls. Reading receives exactly the async WeakMap authority. Migrate semantic/Reading tests and all six ceiling fixtures to their appropriate async/unit/native paths. Removes the accidental host-parser entry and leaves one runtime authority.
2. Keep source.ts synchronous in src, change only Reading's import and move slow tests. Smaller diff, but retains a misleading host-parser entry and two production-directory authority predicates. Reject this as the completed migration.

## Implementation package

1. Before changing the old implementation, copy its exact body into tests/unit/helpers/image-source-sync-baseline.ts. Adjust imports only; record baseline original blob/hash and body equivalence. This is an executable semantic reference, not a relocated failing test or hidden runtime fallback. No src module may import it.
2. Retain existing common interfaces/types in source.ts; replace its runtime parser/WeakMap/functions with explicit re-exports of projectPackedOwnedImages (private projectOwnedImages alias requiring AsyncImageSourceContext and an explicit transport) and isImageProjectionCurrent from async-source.ts. No default/synchronous transport. The type-only import cycle erases at runtime; inspect actual bundled graph, not just TypeScript syntax. There is no public SDK export/interface change.
3. reading-bindings.ts continues using that one facade predicate. Its current structural types never grant authority: async host minting is required; plain forged objects and baseline synchronous projections must be rejected. Add meaningful RED: a legitimate async projection currently fails Reading preparation, whereas after migration it binds/materializes/looks up. Preserve unknown/duplicate/replayed marker rejection, markup escaping, source transforms and attribute removal. Add published resolution-epoch/closer-alias invalidation to Reading lookup, including when old target remains indexed. No fallback that tries both authority maps.
4. Update image-source-projection and image-reading-bindings unit tests to await the actual async projection. Unit-only fixture transport calls pure extraction; clearly keep this distinct from native isolation evidence. Supply explicit fixture epoch/getter and stable view tokens where coordinator is used; no production constant/default epoch. Preserve each existing source-span/title/link/reference/error/metadata/ownership oracle. Replace catch-import scaffolds with direct imports.
5. image-packed-parser.test.ts differential oracle imports the frozen test-only synchronous baseline. Its expectations remain unchanged. Keep small stock-parser comparison (10k/20k/40k/80k) in unit tests against that baseline; preserve the existing sizes, status oracle and logs.
6. Relocate the SIX full ceiling cases from image-source-performance.test.ts into the actual canonical Electron harness, not an excluded/quarantined file. Extract the exact original fixture construction into a shared test-only fixture module used by the harness and a lightweight fixture-identity test. Preserve the original test text/body in a reviewed provenance document/git blob and the historical RED evidence. No old timeout increase, skip, shortened snapshot or prefix result.

## Exact ceiling fixture and oracle map

Original size=300000; strings below copied literally:
- unmatchedOpeners: '['.repeat(size).
- nestedDelimiters: '['.repeat(size/2)+']'.repeat(size/2).
- unmatchedImages: '!['.repeat(size/2).
- ordinaryWhitespace: 'alpha '+' '.repeat(size-26)+'omega ![[Photo.png]]'. Preserve its exact computed length rather than normalizing it to a claimed ceiling.
- prose: ('ordinary words and punctuation. '.repeat(10000)).slice(0,size-14)+'![[Photo.png]]'.
- denseImages: '![[Photo.png]] '.repeat(20000).

For EVERY actual native case preserve: projection.status ready; projection.source===entire original source; prepareOwnedImageReading(projection,source); materialize(prepared.source,source); resulting HTML contains no '<span data-geode-image-occurrence='; occurrence count exactly20000 for denseImages, exactly1 for ordinaryWhitespace/prose, zero otherwise. Preserve projected/marker timing and source-unit logs. Hash each source/expected count in the identity test and report, and verify original-vs-extracted fixture fingerprints before deletion of the original unit loop.

Reuse the already-completed latest nested300k projection for that case's Reading/materialization oracles rather than parsing the identical expensive source twice. Other five cases use the actual coordinator/transport and full worker parse, one at a time. All have the existing8s startup/30s admitted-parse budgets. Keep actual nested heartbeat/input/cancellation/obsolete-generation oracles from90822; no baseline from worker startup or probes.

## Keep relocated coverage in the real regression gate

Add one unskipped Electron E2E spec that invokes the independent Node proof wrapper. Import base Playwright test rather than the app fixture, so only the proof's owned Electron app runs. This places the relocated cases in existing npm test/hosted macOS verify and remote full Electron suite; no workflow omission or Linux-only skip to make unit gates green. Give this NEW async proof an explicit reviewed aggregate budget (accepted child330s / Playwright360s), preserving per-parse30s and all existing test timeouts. Set retries0 for this proof to preserve first outcomes. Child timeout/abort must terminate its owned process tree through existing repository process-cleanup patterns; inspect those before writing this spec. Preserve separate mode/resource/terminal verification and run-specific artifacts under test-results.

Current native acceptance is Linux --no-sandbox only; hosted macOS execution will be additional evidence, not an assumed portability claim. If platform behavior fails, preserve and diagnose it; no skip or weakened contract. New E2E artifact path must survive Playwright output-directory initialization (run proof inside the suite rather than before it).

## Review and gates

First send the complete old/new characterization and authority diff for root and independent review, including the fixture fingerprint equality and causal async-to-Reading RED/GREEN. Recheck actual host/Reading bundle input graph excludes @lezer, markdown-references, parse-source, worker and test baseline. Confirm rg finds no synchronous production projector or second runtime authority consumer. Native actual harness must assert all six full-source Reading/count oracles and same300k response/cancel controls. Then freeze/push, run remote full units/types/build/full Electron (now containing the proof), collect all raw artifacts and independently validate report. Original known RED remains historical evidence; no completed PR until actual fresh full gates and review pass. This package still stops before any product wiring or Lightbox image reads.

## Implementation checkpoint

The frozen synchronous baseline has its exact original body after normalizing only relative import specifiers. Its normalized SHA256 remains the original source hash above. Before the facade change, actual asynchronous projections failed both Reading preparation tests with `Stale owned image snapshot.`; three positive/negative controls passed. After routing the facade and Reading through the sole asynchronous authority, all five tests passed. The affected nine-file authority checkpoint passed 55 tests. These are focused unit results, not native isolation or full-suite completion.

The real host graph now includes source facade, Reading bindings, coordinator and transport; its nine inputs exclude the grammar, worker extractor and test-only baseline. The six original source expressions were evaluated before relocation and matched the committed fixture fingerprint manifest exactly (all 300,000 UTF-16 units; dense count20,000). The native loop preserves every full-source/status/Reading/materialization/count oracle, captures marker timing before asynchronous hashing, and reuses only the already-completed identical nested projection. The unskipped Electron regression uses the existing identity-checked POSIX owned-process runner with a terminal-only result, preserving the aggregate330s budget. It verifies current HEAD/run/report digest linkage, all modes, failure-null and observed cleanup. OS polling has its documented descendant-discovery limitation.

Historical synchronous RED remains evidence of the old host-blocking behavior; this migration does not claim a grammar speedup. No product hooks, image reads or UI integration are included.

## Original characterization source

The following is the complete original test at verified baseline `90822e19a531e4af69276c37566b7b704beec679`, SHA256 `3a8adaecb06c7533b9fb83e3f722804a9e51f3b65a1864d6441547df4f50898d`. The synchronous nested 300k case previously failed its existing five-second unit budget after 13,588 ms. That historical RED is preserved; the replacement measures actual asynchronous execution without claiming faster grammar. Root and independent review cleared the exact replacement before this loop was removed.

```typescript
import { describe, expect, it } from "vitest";
import { projectOwnedImages } from "../../src/renderer/image-inspection/source";
import { prepareOwnedImageReading } from "../../src/renderer/image-inspection/reading-bindings";
import { fixture } from "./helpers/image-source-fixture";

describe("bounded complete source characterization", () => {
  const size = 300_000;
  const cases = {
    unmatchedOpeners: "[".repeat(size),
    nestedDelimiters: "[".repeat(size / 2) + "]".repeat(size / 2),
    unmatchedImages: "![".repeat(size / 2),
    ordinaryWhitespace: "alpha " + " ".repeat(size - 26) + "omega ![[Photo.png]]",
    prose: ("ordinary words and punctuation. ".repeat(10_000)).slice(0, size - 14) + "![[Photo.png]]",
    denseImages: "![[Photo.png]] ".repeat(20_000),
  };
  for (const [name, source] of Object.entries(cases)) {
    it(`projects the complete ${name} fixture without a truncated gallery`, () => {
      const start = performance.now();
      const projection = projectOwnedImages(fixture(source).context);
      const parsed = performance.now();
      expect(projection.status).toBe("ready");
      if (projection.status !== "ready") throw new Error(projection.reason);
      expect(projection.source).toBe(source);
      const prepared = prepareOwnedImageReading(projection, source);
      const html = prepared.materialize(prepared.source, source);
      expect(html).not.toContain("<span data-geode-image-occurrence=");
      expect(projection.occurrences.length).toBe(name === "denseImages" ? 20_000 : ["ordinaryWhitespace", "prose"].includes(name) ? 1 : 0);
      console.log(JSON.stringify({ fixture: name, sourceUnits: source.length, projectionMs: parsed - start, markersMs: performance.now() - parsed, occurrences: projection.occurrences.length }));
    });
  }
});

it("compares installed stock grammar against private projection on bounded nested fixtures", async () => {
  const { parser } = await import("@lezer/markdown");
  for (const size of [10_000, 20_000, 40_000, 80_000]) {
    const source = "[".repeat(size / 2) + "]".repeat(size / 2);
    const beforeStock = performance.now();
    parser.parse(source);
    const afterStock = performance.now();
    const projection = projectOwnedImages(fixture(source).context);
    console.log(JSON.stringify({ fixture: "nested-stock-vs-projection", sourceUnits: size, stockMs: afterStock - beforeStock, projectionMs: performance.now() - afterStock }));
    expect(projection.status).toBe("ready");
  }
});
```

## Accepted stock-comparison placement correction

The initial migration retained the historical four-size stock comparison in the existing five-second unit test. Its exact body passed locally and in controlled focused/one-worker full runs (4,757ms), but failed full c4 at5,114ms and hosted PR392 verify run38771409587 at5,946ms. The failures and original source above remain evidence. Hosted338other files passed; mobilepassed, no hostedbuild/Electron ran.

Coordinator and independent architecture review accepted an explicit placement change: remove that old five-second unit execution and execute the exact four-size comparison in a separate owned Node child of the existing unskipped330s aggregate E2E (360s test). This is NOT unchanged five-second coverage or a grammar speedup. No global/default timeout changes, fixture reduction, skip/quarantine, parser-production/resource changes or altered shipping per-request8s/30s budgets.

The entire old/new loop is normalized only for the Node assertion adapter, captured observation variable and additional report-only assertions/hashes; its exact SHA256 is e11fc4debe357a1e3fc3a2bf082df76a347ab973bef5bb1d2acd6b66db96ad40. Lightweight fixture/body pins retain all four sizes, source hashes and frozenbaseline identity without running the slow comparison inside unit scheduling. The comparison remains nonshipping baseline/installedgrammar characterization, separate from actual new-parser host responsiveness/cancellation proof.

The wrapper validates the unchanged fresh canonical native report, then runs actual Node with the existing installed grammar and frozen synchronous baseline. It waits for child exit and a fresh stock report with commit/run/runtime/baseline/four-row/source/bundle identity before writing terminalsuccess. Stocknonzero, missing/partial/stale report fails closed; a hanging real Node descendant remains under the same aggregate owner/deadline with observed identity-group cleanup. No detached child, phase reset or global kill. Both report paths/digests and current source inventories are checked; native19source inventory stays separate from stock direct harness/baseline source inventory (including the fixture helper) and bundle hash; this inventory is not an exhaustive transitive dependency graph.

Validator regression-first controls failed16 assertions with one positive against a permissive scaffold, then passed17; three source/bundle inventory controls separately failed then passed. Actual wrapper CLI tests use clearly synthetic child boundaries and a real hanging Node child under the existing owner; they are not native isolation evidence. Fresh native focused/full/hosted gates remain required on the final corrected source.

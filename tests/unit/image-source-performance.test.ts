import { expect, it } from "vitest";
import { projectOwnedImages } from "./helpers/image-source-sync-baseline";
import { fixture } from "./helpers/image-source-fixture";

// The six complete ceiling cases now run unskipped in image-parser-execution.spec.ts.
// Keep this small stock comparison against the exact frozen synchronous baseline.
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

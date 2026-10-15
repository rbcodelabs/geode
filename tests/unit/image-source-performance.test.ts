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

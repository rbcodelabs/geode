import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { supportedCatalogStateLabel } from "../../src/renderer/community/supported-catalog-view";

describe("supported catalog presentation", () => {
  it("describes stale data neutrally without claiming the device is offline", () => {
    const label = supportedCatalogStateLabel("stale", "2026-09-09T12:00:00.000Z");
    expect(label).toContain("using cached catalog");
    expect(label).not.toContain("offline");
  });

  it("wraps catalog rows and controls in narrow Settings layouts", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../styles/app.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.supported-plugin-item[\s\S]*flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.supported-plugin-controls[\s\S]*align-items:\s*stretch/);
  });
});

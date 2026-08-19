import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve(__dirname, "../../styles/app.css"), "utf8");

describe("Canvas theme CSS contract", () => {
  it("defines and consumes every documented Canvas CSS variable", () => {
    const variables = [
      "--canvas-background",
      "--canvas-card-label-color",
      "--canvas-dot-pattern",
      ...Array.from({ length: 6 }, (_, index) => `--canvas-color-${index + 1}`),
    ];

    for (const variable of variables) {
      const occurrences = css.match(new RegExp(variable, "g")) ?? [];
      expect(occurrences.length, `${variable} must be both defined and consumed`).toBeGreaterThanOrEqual(2);
    }
  });
});

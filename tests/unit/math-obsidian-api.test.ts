import { afterEach, describe, expect, it, vi } from "vitest";
import * as ObsidianApi from "../../src/renderer/api/obsidian";

describe("Obsidian renderMath / finishRenderMath contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exports both from the module behind require('obsidian')", () => {
    expect(ObsidianApi.renderMath).toBeTypeOf("function");
    expect(ObsidianApi.renderMath.length).toBe(2);
    expect(ObsidianApi.finishRenderMath).toBeTypeOf("function");
  });

  it("finishRenderMath resolves immediately (KaTeX renders synchronously)", async () => {
    await expect(ObsidianApi.finishRenderMath()).resolves.toBeUndefined();
  });

  it("renderMath returns the rendered element for inline and display math", () => {
    vi.stubGlobal("document", {
      createElement: () => {
        const holder = {
          firstElementChild: { html: "" },
          set innerHTML(html: string) {
            this.firstElementChild = { html };
          },
        };
        return holder;
      },
    });
    const inline = ObsidianApi.renderMath("x^2", false) as unknown as { html: string };
    const display = ObsidianApi.renderMath("\\frac{a}{b}", true) as unknown as { html: string };
    expect(inline.html).toContain("math-inline");
    expect(inline.html).toContain("katex");
    expect(display.html).toContain("katex-display");
  });
});

import { describe, expect, it } from "vitest";
const api = await import("../../src/renderer/footnotes-pane").catch(() => ({})) as typeof import("../../src/renderer/footnotes-pane");

describe("footnote pane projection", () => {
  it("lists definitions and inline notes once, with repeated-reference counts and missing states", async () => {
    expect(api.projectFootnotes).toBeTypeOf("function");
    const source = "A[^a], again[^a], ^[inline text], missing[^lost].\n\n[^a]: First line\n    continued\n\n[^unused]: Unreferenced";
    const result = await api.projectFootnotes(source);
    expect(result.items.map(item => [item.label, item.text, item.references, item.missing])).toEqual([
      ["1", "First line\ncontinued", 2, false], ["2", "inline text", 1, false], ["unused", "Unreferenced", 0, false], ["lost", "Definition not found.", 1, true],
    ]);
    const definition = result.items[0];
    expect(source.slice(definition.editFrom, definition.editTo)).toBe("First line\n    continued");
    const inline = result.items[1]; expect(source.slice(inline.editFrom, inline.editTo)).toBe("inline text");
  });
  it("keeps CRLF/frontmatter offsets exact and ignores code/frontmatter notes", async () => {
    const source = "---\r\nignored: '[^yaml]: hidden'\r\n---\r\n`[^code]`\r\n~~~\r\n[^fence]: hidden\r\n~~~\r\nReal[^a]\r\n\r\n[^a]: Text\r\n";
    const result = await api.projectFootnotes(source);
    expect(result.items).toHaveLength(1);
    expect(source.slice(result.items[0].editFrom, result.items[0].editTo)).toBe("Text");
    expect(result.items[0].from).toBe(source.indexOf("[^a]:"));
  });
  it("cancels before large work and explicitly limits source coverage and rendered rows", async () => {
    const controller = new AbortController();
    await expect(api.projectFootnotes("x".repeat(100_000), { signal: controller.signal, yieldControl: async () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    const large = await api.projectFootnotes("[^a]: Text\n" + " ".repeat(100_000));
    expect(large.limited).toBe(true); expect(large.scannedCharacters).toBeLessThanOrEqual(8192);
    const dense = await api.projectFootnotes(Array.from({ length: 300 }, (_, i) => `[^${i}]: text`).join("\n"));
    expect(dense.items.length).toBeLessThanOrEqual(200); expect(dense.limited).toBe(true);
  });
  it("does not expose truncated frontmatter or offer editing a partial definition", async () => {
    const yaml = await api.projectFootnotes("---\nvalue: '[^a]: hidden'\npadding: " + " ".repeat(10_000) + "\n---\nBody");
    expect(yaml.items).toEqual([]); expect(yaml.limited).toBe(true);
    const partial = await api.projectFootnotes("[^a]: " + "text ".repeat(2_000));
    expect(partial.items[0].editable).toBe(false); expect(partial.limited).toBe(true);
  });
  it("handles dense references and unmatched syntax within a bounded source", async () => {
    for (const source of ["[^".repeat(50_000), "`".repeat(50_000), "[^a] ".repeat(2_000) + "\n[^a]: text"]) {
      const result = await api.projectFootnotes(source, { yieldControl: async () => {} });
      expect(result.scannedCharacters).toBeLessThanOrEqual(8192);
    }
  });
});

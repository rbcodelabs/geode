import { describe, expect, it } from "vitest";
import { inspectProperties, mutateProperty, parsePropertyNumber } from "../../src/renderer/properties/property-source";

function edited(text: string, operation: Parameters<typeof mutateProperty>[1]): string {
  const result = mutateProperty(text, operation);
  if (!result.ok) throw new Error(result.error);
  return text.slice(0, result.from) + result.insert + text.slice(result.to);
}

describe("safe property source mutations", () => {
  it("changes only frontmatter while preserving CRLF, comments and unsaved body bytes", () => {
    const text = '---\r\n# retained\r\nstatus: old\r\nother: "quoted"\r\n---\r\nUnsaved **body**\r\n';
    const result = edited(text, { kind: "set", key: "status", value: "new", expected: "old" });
    expect(result).toContain('# retained\r\n');
    expect(result).toContain('other: "quoted"\r\n');
    expect(result.slice(result.indexOf('---\r\n', 5) + 5)).toBe('Unsaved **body**\r\n');
    expect(inspectProperties(result)).toMatchObject({ ok: true, values: { status: "new", other: "quoted" } });
  });
  it("refuses malformed, duplicate, nonmap and unterminated YAML without a replacement", () => {
    for (const text of ['---\na: [\n---\nbody', '---\na: 1\na: 2\n---\nbody', '---\n- item\n---\nbody', '---\na: 1\nbody', '\ufeff---\na: 1\n---\nbody']) {
      expect(mutateProperty(text, { kind: "add", key: "new", value: "value" }).ok).toBe(false);
    }
  });
  it("rejects duplicate add/rename, empty names and stale field values", () => {
    const text = '---\na: old\nb: keep\n---\nbody';
    for (const operation of [
      { kind: "add", key: "a", value: "lost" },
      { kind: "rename", key: "a", name: "b", expected: "old" },
      { kind: "rename", key: "a", name: " ", expected: "old" },
      { kind: "set", key: "a", value: "new", expected: "stale" },
    ] as const) expect(mutateProperty(text, operation).ok).toBe(false);
  });
  it("applies an operation to latest properties rather than replacing a captured object", () => {
    const latest = '---\na: old\nb: added while editing\n---\nbody';
    expect(inspectProperties(edited(latest, { kind: "set", key: "a", value: "new", expected: "old" }))).toMatchObject({ values: { a: "new", b: "added while editing" } });
  });
  it("round-trips scalar list items containing commas, booleans, numbers and null", () => {
    const value = ['one, two', false, 3, null];
    const result = edited('---\nitems: []\n---\nbody', { kind: "set", key: "items", value, expected: [] });
    expect(inspectProperties(result)).toMatchObject({ ok: true, values: { items: value } });
  });
  it("preserves authored order and special keys without modifying prototypes", () => {
    const text = '---\nfirst: x\nconstructor: keep\n__proto__: safe\nlast: y\n---\nbody';
    const result = inspectProperties(edited(text, { kind: "rename", key: "first", name: "renamed", expected: "x" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.values)).toEqual(['renamed', 'constructor', '__proto__', 'last']);
    expect(result.values['__proto__']).toBe('safe');
    expect(Object.getPrototypeOf(result.values)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
  });
  it("does not coerce nested values or invalid/empty number inputs", () => {
    expect(mutateProperty('---\nobject: { nested: value }\n---\nbody', { kind: "set", key: "object", value: "lost" }).ok).toBe(false);
    for (const text of ['', ' ', 'Infinity', 'NaN', '1e999', '0x10', '12abc']) expect(parsePropertyNumber(text)).toBeNull();
    for (const [text, number] of [['0', 0], ['-2.5', -2.5], ['1e3', 1000]] as const) expect(parsePropertyNumber(text)).toBe(number);
  });
  it("preserves surviving YAML comments when the final property is removed", () => {
    const result = edited("---\n# retained note\nstatus: old\n---\nBody", { kind: "remove", key: "status", expected: "old" });
    expect(result).toContain("# retained note");
    expect(result.endsWith("Body")).toBe(true);
  });
  it("adds frontmatter to a note and removes its final property without touching the body", () => {
    const text = 'Body\r\nnext\r\n';
    const added = edited(text, { kind: "add", key: "status", value: "new" });
    expect(added).toBe('---\r\nstatus: new\r\n---\r\n' + text);
    expect(edited(added, { kind: "remove", key: "status", expected: "new" })).toBe(text);
  });
});

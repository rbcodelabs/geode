import { describe, expect, it } from "vitest";
import { fixture } from "./helpers/image-source-fixture";
const sourceApi = await import("../../src/renderer/image-inspection/source").catch(() => ({})) as typeof import("../../src/renderer/image-inspection/source");
const api = await import("../../src/renderer/image-inspection/reading-bindings").catch(() => ({})) as typeof import("../../src/renderer/image-inspection/reading-bindings");

class MarkerNode {
  readonly tagName = "IMG";
  readonly attrs = new Map<string, string>();
  constructor(token: string) { this.attrs.set("data-geode-image-occurrence", token); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
}

function setup(source: string) {
  expect(api.prepareOwnedImageReading).toBeTypeOf("function");
  const f = fixture(source);
  const projection = sourceApi.projectOwnedImages(f.context);
  if (projection.status !== "ready") throw new Error("expected ready");
  const prepared = api.prepareOwnedImageReading(projection, source);
  return { ...f, projection, prepared };
}
function tokens(text: string): string[] {
  return [...text.matchAll(/data-geode-image-occurrence="([a-f0-9]+)"/g)].map(match => match[1]);
}

describe("private exact Reading image markers", () => {
  it("substitutes only exact image spans before length transforms, preserving enclosing links and source", () => {
    const source = '[![a](Photo.png)](Next.md) plus ![[Photo.png|b]]';
    const { prepared, projection } = setup(source);
    const ids = tokens(prepared.source);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(prepared.source).toMatch(/^\[<span /);
    expect(prepared.source).toContain('](Next.md)');
    const transformed = '<p>shortened-before ' + prepared.source + '</p>';
    const html = prepared.materialize(transformed, source);
    expect(html).not.toContain('<span ');
    expect(html).toContain('<img ');
    expect(html).toContain('](Next.md)');
    const nodes = ids.map(id => new MarkerNode(id));
    expect(prepared.bind(nodes, source)).toBe(true);
    expect(nodes.map(node => prepared.lookup(node, source))).toEqual(projection.occurrences);
    expect(nodes.every(node => node.attrs.size === 0)).toBe(true);
    expect(projection.source).toBe(source);
  });

  it("escapes authored alt/title instead of interpreting markup or inserting a source URL", () => {
    const source = '![<img onerror=x>](Photo.png "a & b")';
    const { prepared } = setup(source);
    const html = prepared.materialize(prepared.source, source);
    expect(html).toContain('alt="&lt;img onerror=x&gt;"');
    expect(html).toContain('title="a &amp; b"');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('<img onerror=');
  });

  it("rejects duplicate/unknown marker transforms and stale snapshots without guessing by destination", () => {
    const a = setup('![[Photo.png]] ![[Photo.png]]');
    expect(() => a.prepared.materialize(a.prepared.source + a.prepared.source, a.context.source)).toThrow(/marker/i);
    const b = setup('![[Photo.png]]');
    expect(() => b.prepared.materialize('<span data-geode-image-occurrence="' + '0'.repeat(64) + '"></span>', b.context.source)).toThrow(/marker/i);
    const c = setup('![[Photo.png]]');
    c.changeSnapshot();
    expect(() => c.prepared.materialize(c.prepared.source, c.context.source)).toThrow(/stale/i);
  });

  it("removes all attributes and rejects duplicate/forged/replayed DOM bindings", () => {
    for (const mode of ["duplicate", "forged"] as const) {
      const { prepared, context } = setup('![[Photo.png]]');
      prepared.materialize(prepared.source, context.source);
      const token = tokens(prepared.source)[0];
      const nodes = [new MarkerNode(token), new MarkerNode(mode === "duplicate" ? token : '0'.repeat(64))];
      expect(prepared.bind(nodes, context.source)).toBe(false);
      expect(nodes.every(node => node.attrs.size === 0)).toBe(true);
      expect(nodes.every(node => prepared.lookup(node, context.source) === null)).toBe(true);
    }
    const { prepared, context } = setup('![[Photo.png]]');
    prepared.materialize(prepared.source, context.source);
    const node = new MarkerNode(tokens(prepared.source)[0]);
    expect(prepared.bind([node], context.source)).toBe(true);
    const replay = new MarkerNode(tokens(prepared.source)[0]);
    expect(prepared.bind([replay], context.source)).toBe(false);
    expect(replay.attrs.size).toBe(0);
    expect(prepared.lookup(replay, context.source)).toBeNull();
  });

  it("invalidates lookup after source, indexed target, vault, owner or snapshot changes", () => {
    for (const mode of ["source", "target", "rename", "vault", "owner", "snapshot"] as const) {
      const f = setup('![[Photo.png]]');
      f.prepared.materialize(f.prepared.source, f.context.source);
      const node = new MarkerNode(tokens(f.prepared.source)[0]);
      expect(f.prepared.bind([node], f.context.source)).toBe(true);
      if (mode === "target") f.indexed.set(f.image.path, { ...f.image });
      if (mode === "rename") {
        f.indexed.delete(f.image.path);
        f.image.path = "Pictures/Renamed.png";
        f.indexed.set(f.image.path, f.image);
      }
      if (mode === "vault") f.changeVault();
      if (mode === "owner") f.indexed.delete(f.owner.path);
      if (mode === "snapshot") f.changeSnapshot();
      expect(f.prepared.lookup(node, mode === "source" ? 'x' + f.context.source : f.context.source)).toBeNull();
    }
  });
});

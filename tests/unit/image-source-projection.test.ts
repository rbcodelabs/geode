import { describe, expect, it } from "vitest";
import { parseMetadata } from "../../src/wiki/metadata";
const api = await import("../../src/renderer/image-inspection/source");

import { extractPackedImageSource } from "../../src/renderer/image-inspection/parse-source";
const transport = { parse: async (source: string) => extractPackedImageSource(source) };
import { fixture } from "./helpers/image-source-fixture";

export async function ready(source: string) {
  expect(api.projectOwnedImages).toBeTypeOf("function");
  const f = fixture(source);
  const result = await api.projectOwnedImages(f.context, transport);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.reason);
  return { ...f, result };
}

describe("private owned image occurrences", () => {
  it("projects wiki, direct, reference, linked and duplicate spans in original UTF-16 order", async () => {
    const source = '🗺 ![[Photo.png|caption]] ![one](Photo.png "title") [![two][ID]](Next.md) ![two][ID]\n\n[id]: Other.jpg "definition title"';
    const { result, image, other } = await ready(source);
    expect(result.occurrences.map(item => [source.slice(item.from, item.to), item.target, item.file, item.linked])).toEqual([
      ["![[Photo.png|caption]]", "Photo.png", image, false],
      ['![one](Photo.png "title")', "Photo.png", image, false],
      ["![two][ID]", "Other.jpg", other, true],
      ["![two][ID]", "Other.jpg", other, false],
    ]);
    expect(result.occurrences.map(item => item.title)).toEqual(["", "title", "definition title", "definition title"]);
    expect(result.occurrences[0].from).toBe(3);
    expect(new Set(result.occurrences.map(item => item.key)).size).toBe(4);
    const second = await api.projectOwnedImages(fixture(source).context, transport);
    if (second.status !== "ready") throw new Error("expected ready");
    expect(second.occurrences[0].key).not.toBe(result.occurrences[0].key);
  });

  it("shares normalized full/collapsed/shortcut reference definitions with first-definition precedence", async () => {
    const source = '![  A   B ] ![A B][] ![alt][ a\n b ]\n\n[a b]: Photo.png\n[A B]: Other.jpg';
    const { result } = await ready(source);
    expect(result.occurrences.map(item => item.target)).toEqual(["Photo.png", "Photo.png", "Photo.png"]);
  });

  it("excludes frontmatter, fenced/indented/inline code, comments, raw HTML and transcluded notes", async () => {
    const source = '---\nimage: ![[Photo.png]]\n---\n`![[Photo.png]]`\n\n~~~\n![x](Photo.png)\n~~~\n\n    ![[Photo.png]]\n\n%% ![[Photo.png]] %%\n\n<div>\n![x](Photo.png)\n</div>\n\n<span>![x](Photo.png)</span>\n\n![[OtherNote.md]]\n\n![[Photo.png]]';
    const { result } = await ready(source);
    expect(result.occurrences.map(item => source.slice(item.from, item.to))).toEqual(["![[Photo.png]]"]);
    expect(result.occurrences[0].from).toBe(source.lastIndexOf("![[Photo.png]]"));
  });

  it("retains missing local image positions but rejects schemes, absolute paths and external roots", async () => {
    const source = '![[Missing.png]] ![x](https://example.invalid/a.png) ![x](data:image/png,x) ![[/Photo.png]] ![[../Photo.png]] ![[@ext/root/Photo.png]] ![[Art.svg]]';
    const { result } = await ready(source);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({ status: "missing", from: 0, to: 16, target: "Missing.png", file: null });
    expect(result.issues.length).toBeGreaterThanOrEqual(6);
  });

  it("accepts an extensionless indexed image alias but does not infer missing non-image aliases", async () => {
    const f = fixture("![[Portrait]] ![[Absent]]");
    f.context.resolve = target => target === "Portrait" ? f.image : null;
    const result = await api.projectOwnedImages(f.context, transport);
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.occurrences.map(item => item.target)).toEqual(["Portrait"]);
  });

  it("rejects resolved files outside the captured current vault index", async () => {
    const f = fixture("![[Photo.png]]");
    f.context.resolve = () => ({ path: "Pictures/Photo.png", extension: "png" });
    const result = await api.projectOwnedImages(f.context, transport);
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.occurrences).toEqual([]);
  });

  it("checks complete LF snapshot ceiling before resolver/parser work and never returns a prefix gallery", async () => {
    const f = fixture("![[Photo.png]]" + " ".repeat(300_000));
    let calls = 0;
    f.context.resolve = () => { calls++; throw new Error("must not resolve"); };
    expect(await api.projectOwnedImages(f.context, transport)).toMatchObject({ status: "unsupported", reason: "source-limit" });
    expect(calls).toBe(0);
    expect(await api.projectOwnedImages(fixture("![[Photo.png]]\r\n").context, transport)).toMatchObject({ status: "unsupported", reason: "non-lf-source" });
    const { result } = await ready("![[Photo.png]]" + " ".repeat(300_000 - 14));
    expect(result.occurrences).toHaveLength(1);
  });

  it("refuses stale source-owner, vault and root identities", async () => {
    for (const change of ["owner", "vault", "root", "snapshot"] as const) {
      const f = fixture("![[Photo.png]]");
      if (change === "owner") f.indexed.delete(f.owner.path);
      if (change === "vault") f.changeVault();
      if (change === "root") f.changeRoot();
      if (change === "snapshot") f.changeSnapshot();
      expect(await api.projectOwnedImages(f.context, transport)).toMatchObject({ status: "unsupported", reason: "stale-owner" });
    }
  });

  it("leaves metadata outer-link semantics and source bytes unchanged", async () => {
    const source = '[![image](Photo.png)](Next.md) ![x][ref]\n\n[ref]: Photo.png';
    const before = parseMetadata(source);
    const { result } = await ready(source);
    expect(result.occurrences).toHaveLength(2);
    expect(parseMetadata(source)).toEqual(before);
    expect(before.embeds).toHaveLength(1);
    expect(before.links.map(link => link.link)).toEqual(["Next.md"]);
    expect(result.source).toBe(source);
  });
});

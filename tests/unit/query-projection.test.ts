import { describe, expect, it } from "vitest";
import { createWikiSnapshot } from "../../src/wiki/snapshot";
import { projectWikiQueries, serializeWikiQueryProjection } from "../../src/wiki/query-projection";

/**
 * The projection is the written form of the catalog restore equality claim, so
 * these tests are about the claim's *shape*: what it compares, what it
 * deliberately does not, and that it is stable enough for two independent
 * processes to compare byte-for-byte.
 */

const captured = [
  { path: "Index.md", kind: "note" as const, text: "# Index\n\nSee [[Decision]] and ![[assets/diagram.png]].\n" },
  { path: "assets/diagram.png", kind: "attachment" as const },
  {
    path: "notes/Decision.md", kind: "note" as const,
    text: "---\naliases: [Choice]\n---\n\n# Decision\n\nBack to [[Index]]. Mentions plesiosaur.\n",
  },
];

const options = {
  searchQueries: ["plesiosaur", "no-such-term"],
  resolveTargets: [
    { from: "Index.md", target: "Decision" },
    { from: "Index.md", target: "Choice" },
    { from: "Index.md", target: "Nothing Here" },
  ],
};

describe("projectWikiQueries", () => {
  it("is stable across two snapshots built from the same captured files", () => {
    // Two independent snapshot objects, and the capture order deliberately
    // reversed: neither object identity nor input order may reach the output.
    const first = serializeWikiQueryProjection(createWikiSnapshot(captured), options);
    const second = serializeWikiQueryProjection(createWikiSnapshot([...captured].reverse()), options);
    expect(second).toBe(first);
  });

  it("excludes the capture timestamps that cannot survive a restore", () => {
    const text = serializeWikiQueryProjection(createWikiSnapshot(captured), options);
    expect(text).not.toContain("scanStartedAt");
    expect(text).not.toContain("scanEndedAt");
    expect(text).not.toContain("exclusionPolicy");
    expect(text).not.toContain("parserLimitations");
  });

  it("differs when a snapshot is scanned at a different time — only because it does not look", () => {
    // The guard for the exclusion above: two snapshots that differ *only* in
    // capture timing must project identically, or the exclusion would be
    // untested and the equality claim would be unfalsifiable in the other
    // direction.
    const early = createWikiSnapshot(captured, { scanStartedAt: "2020-01-01T00:00:00.000Z", scanEndedAt: "2020-01-01T00:00:01.000Z" });
    const late = createWikiSnapshot(captured, { scanStartedAt: "2026-09-19T12:00:00.000Z", scanEndedAt: "2026-09-19T12:00:30.000Z" });
    expect(early.info.scanStartedAt).not.toBe(late.info.scanStartedAt);
    expect(serializeWikiQueryProjection(late, options)).toBe(serializeWikiQueryProjection(early, options));
  });

  it("still compares the capture-derived facts that change query answers", () => {
    // `discoveryComplete` is a capture fact, but it travels *inside* resolution
    // and search results, so losing it must fail even though `info` is not
    // compared.
    const complete = createWikiSnapshot(captured, { discoveryComplete: true });
    const partial = createWikiSnapshot(captured, { discoveryComplete: false });
    expect(serializeWikiQueryProjection(partial, options)).not.toBe(serializeWikiQueryProjection(complete, options));
  });

  it("fails when a single note byte changes", () => {
    const edited = captured.map((file) =>
      file.path === "notes/Decision.md" ? { ...file, text: (file.text as string).replace("plesiosaur", "ichthyosaur") } : file);
    expect(serializeWikiQueryProjection(createWikiSnapshot(edited), options))
      .not.toBe(serializeWikiQueryProjection(createWikiSnapshot(captured), options));
  });

  it("fails when a link stops resolving", () => {
    const withoutTarget = captured.filter((file) => file.path !== "notes/Decision.md");
    expect(serializeWikiQueryProjection(createWikiSnapshot(withoutTarget), options))
      .not.toBe(serializeWikiQueryProjection(createWikiSnapshot(captured), options));
  });

  it("fails when an attachment disappears even though no note text changed", () => {
    const withoutAsset = captured.filter((file) => file.path !== "assets/diagram.png");
    expect(serializeWikiQueryProjection(createWikiSnapshot(withoutAsset), options))
      .not.toBe(serializeWikiQueryProjection(createWikiSnapshot(captured), options));
  });

  it("covers resolution, search, backlinks and note content", () => {
    const projected = projectWikiQueries(createWikiSnapshot(captured), options) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(["backlinks", "files", "notes", "outgoing", "resolved", "search"]);
    expect(projected.files).toEqual([
      ["Index.md", "note"],
      ["assets/diagram.png", "attachment"],
      ["notes/Decision.md", "note"],
    ]);

    // The alias resolves, the absent target does not, and both answers are in
    // the comparison — a restore that lost aliases and a restore that invented
    // a resolution are equally caught.
    const resolved = projected.resolved as { target: string; resolution: { status: string; path?: string } }[];
    expect(resolved.find((entry) => entry.target === "Choice")?.resolution)
      .toMatchObject({ status: "resolved", path: "notes/Decision.md" });
    expect(resolved.find((entry) => entry.target === "Nothing Here")?.resolution.status).toBe("missing");

    const search = projected.search as { query: string; result: { hits: { path: string }[] } }[];
    expect(search[0].result.hits.map((hit) => hit.path)).toEqual(["notes/Decision.md"]);
    expect(search[1].result.hits).toEqual([]);

    const backlinks = projected.backlinks as Record<string, { references: { sourcePath: string }[] }>;
    expect(backlinks["Index.md"].references.map((reference) => reference.sourcePath)).toEqual(["notes/Decision.md"]);
  });

  it("sorts object keys so construction order cannot leak into the comparison", () => {
    const text = serializeWikiQueryProjection(createWikiSnapshot(captured), options);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    const notes = parsed.notes as Record<string, Record<string, unknown>>;
    expect(Object.keys(notes["Index.md"])).toEqual([...Object.keys(notes["Index.md"])].sort());
  });
});

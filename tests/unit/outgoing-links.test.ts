import { describe, expect, it } from "vitest";

// A missing implementation yields a behavioral assertion, not an import crash.
const api = await import("../../src/renderer/outgoing-links").catch(() => ({})) as typeof import("../../src/renderer/outgoing-links");
const source = "Source.md";
const targets = [{ path: "a/Atlas.md", basename: "Atlas", aliases: ["World map"] }, { path: "b/Atlas.md", basename: "Atlas", aliases: [] }];

const findMentions = async (...args: Parameters<typeof api.findOutgoingMentions>) => (await api.findOutgoingMentions(...args)).mentions;

describe("outgoing mention matching", () => {
  it("offers duplicate basenames as separate targets and preserves exact alias spelling/offsets", async () => {
    expect(api.findOutgoingMentions).toBeTypeOf("function");
    const text = "Atlas and WORLD MAP";
    const matches = await findMentions(text, source, targets);
    expect(matches.map(m => [m.targetPath, m.from, m.to, m.text])).toEqual([
      ["a/Atlas.md", 0, 5, "Atlas"], ["b/Atlas.md", 0, 5, "Atlas"], ["a/Atlas.md", 10, 19, "WORLD MAP"],
    ]);
  });
  it("uses Unicode boundaries and original UTF-16 offsets", async () => {
    const text = "🗺 atlas! preAtlas Atlasé 世界Atlas Atlas";
    expect((await findMentions(text, source, targets)).map(m => m.from)).toEqual([3, 3, text.lastIndexOf("Atlas"), text.lastIndexOf("Atlas")]);
  });
  it("avoids frontmatter, linked spans, escaped link syntax, self and overlapping nested aliases", async () => {
    const text = "---\nalias: Atlas\n---\n[[Atlas|Atlas]] [Atlas](Atlas.md) ![[Atlas]] `Atlas`\nWorld map";
    const matches = await findMentions(text, source, [...targets, { path: source, basename: "map", aliases: ["World"] }]);
    expect(matches.map(m => m.text)).toEqual(["Atlas", "Atlas", "World map"]);
    expect(matches.every(m => m.targetPath !== source)).toBe(true);
  });
  it("allows mentions inside fences but parsed Links excludes code", async () => {
    const text = "```\nAtlas [[Hidden]]\n```\n[[Atlas]] ![[image.png]] [[Atlas]]";
    expect(await findMentions(text, source, targets)).toHaveLength(2);
    expect(api.outgoingReferences(text).map(r => [r.link, r.count])).toEqual([["Atlas", 2], ["image.png", 1]]);
  });
  it("cancels scans and yields large candidate sets", async () => {
    const controller = new AbortController();
    let yields = 0;
    await expect(findMentions("Atlas", source, Array.from({length: 600}, (_, i) => ({ path: `${i}.md`, basename: "Atlas", aliases: [] })), {
      signal: controller.signal, yieldControl: async () => { yields++; controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(1);
  });
  it("accepts conversion only for the exact source snapshot/range", () => {
    const mention = { targetPath: "a/Atlas.md", from: 2, to: 7, text: "Atlas", snippet: "Atlas" };
    expect(api.mentionStillCurrent("x Atlas", "x Atlas", mention)).toBe(true);
    expect(api.mentionStillCurrent("x Atlas", "y Atlas", mention)).toBe(false);
    expect(api.mentionStillCurrent("x Atlas", "x Atlas", {...mention, from: 1})).toBe(false);
  });
});

it("keeps URL schemes out of internal target activation", () => {
  expect(api.outgoingReferences("[[https://example.com]] [[mailto:person@example.com]] [[Atlas]]").map(reference => reference.link)).toEqual(["Atlas"]);
});

it("yields and cancels while masking one large unmatched-opener source", async () => {
  const controller = new AbortController();
  let yields = 0;
  await expect(api.findOutgoingMentions("[".repeat(100_000), source, targets.slice(0, 1), {
    signal: controller.signal, yieldControl: async () => { yields++; controller.abort(); },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(yields).toBe(1);
});

it("yields within a single dense target and bounds visible suggestions explicitly", async () => {
  const controller = new AbortController();
  await expect(api.findOutgoingMentions("Atlas ".repeat(1_000), source, targets.slice(0, 1), {
    signal: controller.signal, yieldControl: async () => { controller.abort(); },
  })).rejects.toMatchObject({ name: "AbortError" });
  const result = await api.findOutgoingMentions("Atlas ".repeat(2_000), source, targets.slice(0, 1));
  expect(result.mentions.length).toBeLessThanOrEqual(500);
  expect(result.limited).toBe(true);
});

it("reports source coverage limits without changing conversion offsets", async () => {
  const result = await api.findOutgoingMentions("Atlas " + " ".repeat(300_000), source, targets.slice(0, 1));
  expect(result.limited).toBe(true);
  expect(result.mentions[0]).toMatchObject({ from: 0, to: 5, text: "Atlas" });
});

it("completes unmatched openers and long newline-free whitespace with bounded output", async () => {
  for (const text of ["[".repeat(100_000), "[a](".repeat(25_000), "Atlas " + " ".repeat(120_000)]) {
    const result = await api.findOutgoingMentions(text, source, targets.slice(0, 1), { yieldControl: async () => {} });
    expect(result.mentions.length).toBeLessThanOrEqual(500);
  }
});

it("masks nested Markdown labels, parenthesized URLs, references and HTML without nested suggestions", async () => {
  const result = await api.findOutgoingMentions("[outer [Atlas]](note(1).md) [Atlas][id]\n[id]: Atlas.md\n<a title='Atlas'> Atlas", source, targets.slice(0, 1));
  expect(result.mentions.map(mention => mention.text)).toEqual(["Atlas"]);
});

it("does not match artificial spaces from masking or a partial word at the source limit", async () => {
  const aliases = [{ path: "Target.md", basename: "Target", aliases: [" ", "Atlas "] }];
  const masked = await api.findOutgoingMentions("Atlas[[Linked]]", source, aliases);
  expect(masked.mentions).toEqual([]);
  const text = " ".repeat(128 * 1024 - 5) + "AtlasLonger";
  const limited = await api.findOutgoingMentions(text, source, targets.slice(0, 1));
  expect(limited.mentions).toEqual([]);
  expect(limited.limited).toBe(true);
});

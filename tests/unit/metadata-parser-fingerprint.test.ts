import { describe, expect, it } from "vitest";
import { METADATA_PARSER_VERSION, extractMentionIndexKeys, parseMetadata } from "../../src/renderer/metadata-cache";

/**
 * Guards the persisted-cache parser stamp. If this fails you changed what the
 * parser produces for existing notes: bump METADATA_PARSER_VERSION so every
 * installed device re-parses instead of trusting stale rows, then update the
 * expected pair below.
 */
const SAMPLE = [
  "---", "title: T", "tags: [a, '#b']", "aliases: [Al]", "---",
  "# H1", "## H2 ^blk", "Link [[Note#Head|alias]] ![[img.png]] [md](other.md) #inline", "- [ ] task",
  "```", "[[in-code]]", "```", "Paragraph with mention words. ^para",
].join("\n");

const EXPECTED = { version: 1, fingerprint: "6aa9c027" };

function fingerprint(): string {
  const text = JSON.stringify([parseMetadata(SAMPLE), extractMentionIndexKeys(SAMPLE)]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

describe("metadata parser fingerprint", () => {
  it("changes only together with METADATA_PARSER_VERSION", () => {
    expect({ version: METADATA_PARSER_VERSION, fingerprint: fingerprint() }).toEqual(EXPECTED);
  });
});

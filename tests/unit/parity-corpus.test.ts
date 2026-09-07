import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  formatMissingCorpusError,
  preflightCorpora,
  type CorpusSpec,
} from "../../scripts/parity-corpus.mts";

const HELP: CorpusSpec = {
  label: "Obsidian help",
  path: "/private/tmp/geode-audit-obsidian-help",
  flag: "--help-root",
  repo: "https://github.com/obsidianmd/obsidian-help",
};
const DEV: CorpusSpec = {
  label: "Obsidian developer docs",
  path: "/private/tmp/geode-audit-obsidian-developer-docs",
  flag: "--developer-root",
  repo: "https://github.com/obsidianmd/obsidian-developer-docs",
};

const created: string[] = [];
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parity-corpus-"));
  created.push(dir);
  return dir;
}

describe("formatMissingCorpusError", () => {
  it("names every missing corpus and its expected path", () => {
    const message = formatMissingCorpusError([HELP, DEV]);
    expect(message).toContain("Obsidian help");
    expect(message).toContain("/private/tmp/geode-audit-obsidian-help");
    expect(message).toContain("Obsidian developer docs");
    expect(message).toContain("(2 of 3)");
  });

  it("gives a runnable clone command for each missing corpus", () => {
    const message = formatMissingCorpusError([HELP]);
    expect(message).toContain(
      "git clone https://github.com/obsidianmd/obsidian-help /private/tmp/geode-audit-obsidian-help",
    );
  });

  it("points at the documented refresh procedure", () => {
    expect(formatMissingCorpusError([HELP])).toContain("docs/spec/05-parity-ledger.md");
  });

  it("offers the override flag so an existing clone elsewhere can be used", () => {
    expect(formatMissingCorpusError([HELP])).toContain("--help-root <path>");
  });

  it("explains that this is expected recurring environment rot, not a broken ledger", () => {
    const message = formatMissingCorpusError([HELP]);
    expect(message).toContain("cleared by macOS");
    expect(message).toMatch(/does NOT\s*\n?mean the ledger or your changes are broken/);
  });

  it("uses singular phrasing for exactly one missing corpus", () => {
    expect(formatMissingCorpusError([HELP])).toContain("corpus is missing");
    expect(formatMissingCorpusError([HELP, DEV])).toContain("corpora are missing");
  });
});

describe("preflightCorpora", () => {
  it("resolves when every corpus directory exists", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await expect(
      preflightCorpora([
        { ...HELP, path: a },
        { ...DEV, path: b },
      ]),
    ).resolves.toBeUndefined();
  });

  it("throws an actionable error instead of a raw ENOENT when one is missing", async () => {
    const present = await tempDir();
    const absent = join(present, "definitely-not-here");
    await expect(
      preflightCorpora([
        { ...HELP, path: present },
        { ...DEV, path: absent },
      ]),
    ).rejects.toThrow(/Obsidian developer docs/);
    // The failure must not surface as a bare filesystem error.
    await expect(
      preflightCorpora([{ ...DEV, path: absent }]),
    ).rejects.not.toThrow(/ENOENT|scandir/);
  });

  it("reports every missing corpus at once, not just the first", async () => {
    const root = await tempDir();
    const error = await preflightCorpora([
      { ...HELP, path: join(root, "nope-1") },
      { ...DEV, path: join(root, "nope-2") },
    ]).catch((err: Error) => err);
    expect((error as Error).message).toContain("(2 of 3)");
    expect((error as Error).message).toContain("nope-1");
    expect((error as Error).message).toContain("nope-2");
  });

  it("treats a file at the corpus path as missing rather than usable", async () => {
    const root = await tempDir();
    const asFile = join(root, "not-a-dir");
    await writeFile(asFile, "");
    await expect(preflightCorpora([{ ...HELP, path: asFile }])).rejects.toThrow(
      /Obsidian help/,
    );
  });

  it("accepts a nested existing directory (real clone shape)", async () => {
    const root = await tempDir();
    const help = join(root, "geode-audit-obsidian-help");
    await mkdir(join(help, "en"), { recursive: true });
    await expect(
      preflightCorpora([{ ...HELP, path: help }]),
    ).resolves.toBeUndefined();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import {
  EXIT, coverageWarnings, emit, envelope, exitNameFor, parserWarnings, refusalLine,
} from "../../src/cli/output";

/**
 * The CLI's own contract: argv in, an exit code and two streams out.
 *
 * These tests deliberately do not re-test the engine — `tests/unit/wiki-sdk.test.ts`
 * already pins what `resolve` and `createNote` answer. What is pinned here is
 * the layer the CLI actually owns, and the one place it could quietly destroy
 * value: the mapping from a named status onto an exit code, and the promise
 * that the name survives into the payload rather than being rendered as prose.
 *
 * `scripts/run-wiki-cli-proof.mjs` makes the same claims against a real
 * subprocess. Both exist because they fail differently: this one localises a
 * regression to a function, that one proves the binary a caller actually
 * invokes behaves the same way.
 */

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    streams: { out: (text: string) => { stdout.push(text); }, err: (text: string) => { stderr.push(text); } },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

const EMPTY_COVERAGE = {
  discoveryComplete: true, noteContentComplete: true, aliasCoverageComplete: true, diagnostics: [],
};

describe("exit codes", () => {
  it("has exactly four, and they are the documented numbers", () => {
    expect(EXIT).toEqual({ ok: 0, refused: 1, usage: 2, unavailable: 3 });
  });

  it("treats `resolved` as affirmative alongside `ok`", () => {
    // The whole vocabulary has two affirmative statuses, and only one of them
    // is spelled "ok". Keying on that literal alone exited 1 on every
    // successful `resolve`.
    expect(exitNameFor("ok")).toBe("ok");
    expect(exitNameFor("resolved")).toBe("ok");
  });

  it("separates `could not look` from `looked and did not find`", () => {
    // `missing` and `unavailable` are the pair a caller most needs to tell
    // apart, and they must be separable without reading stdout at all.
    expect(exitNameFor("missing")).toBe("refused");
    expect(exitNameFor("unavailable")).toBe("unavailable");
    expect(exitNameFor("vault-unavailable")).toBe("unavailable");
    expect(exitNameFor("store-failed")).toBe("unavailable");
  });

  it("routes every other named status to `refused`, including the catalog's", () => {
    for (const status of [
      "absent", "ambiguous", "already-exists", "portability-collision", "not-a-note",
      "invalid-path", "capture-incomplete", "conflict", "mutation-id-reused", "oversize",
      "byte-length-mismatch", "duplicate-with-mismatched-bytes", "invalid-content-address",
    ]) {
      expect(exitNameFor(status)).toBe("refused");
    }
  });
});

describe("the --json envelope", () => {
  it("carries the engine status verbatim and never flattens it", () => {
    const shape = envelope({
      command: "create", status: "portability-collision",
      result: { path: "TARGET.md", status: "portability-collision" },
    });
    expect(shape).toEqual({
      tool: "geode-wiki", schemaVersion: 1, command: "create",
      status: "portability-collision", exit: { code: 1, name: "refused" },
      result: { path: "TARGET.md", status: "portability-collision" },
    });
  });

  it("preserves refusal detail rather than reducing it to a message", () => {
    // The catalog's `RefusalDetail` — which limit, observed vs. allowed — is
    // the difference between an agent that can retry correctly and one that
    // cannot.
    const shape = envelope({
      command: "catalog-publish", status: "oversize",
      result: { status: "oversize", path: "Big.md", limit: "note-bytes", observed: 3145728, allowed: 2097152 },
    });
    expect(shape.result).toEqual({
      status: "oversize", path: "Big.md", limit: "note-bytes", observed: 3145728, allowed: 2097152,
    });
    expect(shape.exit).toEqual({ code: 1, name: "refused" });
  });

  it("gives a usage failure its own status and never claims the engine ran", () => {
    const shape = envelope({ command: null, status: "usage", result: { message: "no command given" } });
    expect(shape.exit).toEqual({ code: 2, name: "usage" });
    expect(shape.command).toBeNull();
  });

  it("omits coverage entirely when no vault was captured", () => {
    expect(envelope({ command: "catalog-restore", status: "absent", result: {} })).not.toHaveProperty("coverage");
  });
});

describe("emit", () => {
  it("writes exactly one JSON line and nothing else to stdout", () => {
    const sink = capture();
    const code = emit({ command: "list", status: "ok", result: { files: [] }, lines: ["ignored"] }, true, sink.streams);
    expect(code).toBe(0);
    expect(sink.out().trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(sink.out())).toMatchObject({ command: "list", status: "ok" });
  });

  it("writes `raw` verbatim, so a redirected read round-trips the note", () => {
    const sink = capture();
    // No trailing newline: `read` must not invent one, and must not lose one.
    emit({ command: "read", status: "ok", result: {}, raw: "# Note\n\nno trailing newline" }, false, sink.streams);
    expect(sink.out()).toBe("# Note\n\nno trailing newline");
  });

  it("sends warnings to stderr in both modes", () => {
    for (const json of [true, false]) {
      const sink = capture();
      emit({ command: "search", status: "ok", result: {}, warnings: ["warning: truncated"] }, json, sink.streams);
      expect(sink.err()).toBe("warning: truncated\n");
      expect(sink.out()).not.toContain("warning:");
    }
  });
});

describe("honest diagnostics", () => {
  it("says out loud that absence is not provable after a truncated walk", () => {
    const lines = coverageWarnings({ ...EMPTY_COVERAGE, discoveryComplete: false });
    expect(lines.join(" ")).toContain("absence is not provable");
  });

  it("reports each capture diagnostic with the path it is about", () => {
    expect(coverageWarnings({ ...EMPTY_COVERAGE, diagnostics: [{ code: "entry-limit", path: "Late.md" }] }))
      .toEqual(["diagnostic: entry-limit (Late.md)"]);
  });

  it("says nothing when the capture was complete", () => {
    expect(coverageWarnings(EMPTY_COVERAGE)).toEqual([]);
  });

  it("reports per-note parser gaps separately from the walk's coverage", () => {
    const certain = {
      referencesCertain: true, headingsCertain: true, blocksCertain: true,
      frontmatterCertain: true, bodyScanned: true,
    };
    expect(parserWarnings("A.md", certain)).toEqual([]);
    expect(parserWarnings("A.md", { ...certain, bodyScanned: false, referencesCertain: false })[0])
      .toBe("warning: A.md: the body was not scanned in full; references are not certain");
  });
});

describe("refusalLine", () => {
  it("leads with the status, so the name survives the human rendering too", () => {
    expect(refusalLine("oversize", { path: "Big.md", limit: "note-bytes" }))
      .toBe("oversize  path=Big.md limit=note-bytes");
  });

  it("drops absent detail rather than printing `undefined`", () => {
    expect(refusalLine("ambiguous", { path: undefined, reason: undefined })).toBe("ambiguous");
  });
});

describe("run", () => {
  let root: string;
  const context = (sink: ReturnType<typeof capture>) => ({
    streams: sink.streams, env: {} as NodeJS.ProcessEnv, stdin: Readable.from([]),
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "geode-cli-unit-"));
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    await writeFile(join(root, "Target.md"), "# Target\n\nmentions plesiosaur.\n", "utf8");
    await writeFile(join(root, "a/Dup.md"), "# Dup A\n", "utf8");
    await writeFile(join(root, "b/Dup.md"), "# Dup B\n", "utf8");
    await writeFile(join(root, "Index.md"), "# Index\n\n[[Target]] and [[Dup]].\n", "utf8");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("exits 2 on every argv it cannot turn into an operation", async () => {
    const cases: string[][] = [
      [],
      ["frobnicate"],
      ["list"],                                    // no --root
      ["read", "--root", "/x"],                    // missing positional
      ["list", "--root", "/x", "surplus"],         // extra positional
      ["list", "--root", "/x", "--colour"],        // unknown flag
      ["search", "--root", "/x", "q", "--limit", "many"],
    ];
    for (const argv of cases) {
      const sink = capture();
      expect(await run(argv, context(sink)), argv.join(" ")).toBe(2);
    }
  });

  it("never reaches the engine on a usage failure", async () => {
    // `--root /definitely-not-here` would be exit 3 if the engine had been
    // asked. It exits 2, which is how we know it was not.
    const sink = capture();
    expect(await run(["read", "--root", "/definitely-not-here"], context(sink))).toBe(2);
    expect(sink.err()).toBe("");
  });

  it("prints the surface on --help and exits 0", async () => {
    const sink = capture();
    expect(await run(["--help"], context(sink))).toBe(0);
    expect(sink.out()).toContain("catalog-publish");
    expect(sink.out()).toContain("There is no \"refresh\" command");
  });

  it("answers a resolvable link with 0 and an ambiguous one with 1", async () => {
    const resolved = capture();
    expect(await run(["resolve", "--root", root, "Index.md", "Target", "--json"], context(resolved))).toBe(0);
    expect(JSON.parse(resolved.out())).toMatchObject({ status: "resolved", result: { path: "Target.md" } });

    const ambiguous = capture();
    expect(await run(["resolve", "--root", root, "Index.md", "Dup", "--json"], context(ambiguous))).toBe(1);
    expect(JSON.parse(ambiguous.out()).result.candidates).toEqual(["a/Dup.md", "b/Dup.md"]);
  });

  it("exits 3 when the folder itself cannot be reached", async () => {
    const sink = capture();
    expect(await run(["list", "--root", join(root, "nope"), "--json"], context(sink))).toBe(3);
    expect(JSON.parse(sink.out())).toMatchObject({
      status: "vault-unavailable", exit: { code: 3, name: "unavailable" },
    });
  });

  it("admits an incomplete walk instead of reporting a clean miss", async () => {
    const sink = capture();
    const code = await run(
      ["search", "--root", root, "plesiosaur", "--max-entries", "1", "--json"], context(sink),
    );
    // Still a successful call — an incomplete search is an answer, not an
    // error. What must never happen is that it looks like a complete one.
    // Deliberately no assertion about which notes survived the cap: the claim
    // is about the admission, not about the walk order.
    expect(code).toBe(0);
    const payload = JSON.parse(sink.out());
    expect(payload.result.complete).toBe(false);
    expect(payload.coverage.discoveryComplete).toBe(false);
    expect(payload.coverage.diagnostics.map((d: { code: string }) => d.code)).toContain("entry-limit");
    expect(sink.err()).toContain("absence is not provable");
  });

  it("requires a schema for catalog commands rather than inventing a config file", async () => {
    const sink = capture();
    expect(await run(
      ["catalog-restore", "--into", join(root, "out"), "--vault-id", "v"], context(sink),
    )).toBe(2);
    expect(sink.out()).toContain("GEODE_CATALOG_SCHEMA");
  });

  it("takes the schema from the environment when the flag is absent", async () => {
    const sink = capture();
    // `public` is a schema the adapter refuses to own, so this proves the
    // environment value was read without needing a database to be reachable.
    const code = await run(["catalog-restore", "--into", join(root, "out"), "--vault-id", "v", "--json"], {
      streams: sink.streams, env: { GEODE_CATALOG_SCHEMA: "public" }, stdin: Readable.from([]),
    });
    expect(code).toBe(1);
    expect(JSON.parse(sink.out())).toMatchObject({ status: "invalid-schema", result: { schema: "public" } });
  });
});

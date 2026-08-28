import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasAppArtifacts,
  isE2ETempDir,
  isStaleDir,
  parsePsOutput,
  reapE2EArtifacts,
  shouldReapProcess,
} from "../../scripts/e2e-reap.mts";

/**
 * These predicates decide what an automated killer terminates and deletes. The
 * cost of a false positive is killing the developer's real editor or wiping a
 * directory they cared about, so the negative cases below matter more than the
 * positive ones.
 */

const TMP = "/tmp";

describe("isE2ETempDir", () => {
  it("matches the mkdtemp dirs the suite creates", () => {
    for (const name of [
      "geode-e2e-Ab12Cd",
      "geode-deferred-vault-XyZ789",
      "geode-window-chrome-ud-qqqq11",
    ]) {
      expect(isE2ETempDir(name, TMP), name).toBe(true);
      expect(isE2ETempDir(path.join(TMP, name), TMP), name).toBe(true);
    }
  });

  it("cannot distinguish a human-named geode dir by name alone", () => {
    // Documenting the limit that motivates the hasAppArtifacts gate: shape
    // matching alone would happily match this, which is why it is not the only
    // gate before deletion.
    expect(isE2ETempDir("geode-scratch", TMP)).toBe(true);
    expect(isE2ETempDir("geode-", TMP)).toBe(false);
  });

  it("ignores unrelated temp dirs", () => {
    expect(isE2ETempDir("playwright-artifacts-abc123", TMP)).toBe(false);
    expect(isE2ETempDir("not-geode-Ab12Cd", TMP)).toBe(false);
  });

  it("refuses paths outside the temp root, including traversal", () => {
    expect(isE2ETempDir("/Users/someone/geode-Ab12Cd", TMP)).toBe(false);
    // Nested one level down is not a dir the suite mints, and allowing it would
    // widen recursive deletion to arbitrary subtrees.
    expect(isE2ETempDir(path.join(TMP, "nested", "geode-Ab12Cd"), TMP)).toBe(false);
    expect(isE2ETempDir(path.join(TMP, "..", "geode-Ab12Cd"), TMP)).toBe(false);
  });
});

describe("hasAppArtifacts", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-probe-"));
    created.push(dir);
    return dir;
  };

  it("recognises a seeded user-data dir", () => {
    const dir = make();
    fs.writeFileSync(path.join(dir, "geode.json"), "{}");
    expect(hasAppArtifacts(dir)).toBe(true);
  });

  it("recognises a seeded vault by its .geode dir", () => {
    const dir = make();
    fs.mkdirSync(path.join(dir, ".geode"));
    expect(hasAppArtifacts(dir)).toBe(true);
  });

  it("rejects a directory holding only a developer's own files", () => {
    const dir = make();
    fs.writeFileSync(path.join(dir, "notes.md"), "# mine");
    fs.mkdirSync(path.join(dir, "src"));
    expect(hasAppArtifacts(dir)).toBe(false);
  });

  it("rejects an empty directory", () => {
    expect(hasAppArtifacts(make())).toBe(false);
  });
});

describe("shouldReapProcess", () => {
  it("matches an Electron launched against an e2e user-data dir", () => {
    const command =
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron " +
      `/repo --user-data-dir=${TMP}/geode-e2e-Ab12Cd`;
    expect(shouldReapProcess(command, TMP)).toBe(true);
  });

  it("matches helper processes carrying the same flag", () => {
    const command =
      "Electron Helper (Renderer) --type=renderer " +
      `--user-data-dir=${TMP}/geode-e2e-Ab12Cd --enable-features=SharedArrayBuffer`;
    expect(shouldReapProcess(command, TMP)).toBe(true);
  });

  it("never matches a real Geode install", () => {
    // The installed app uses Electron's default userData path, never a temp dir.
    const real =
      "/Applications/Geode.app/Contents/MacOS/Geode --user-data-dir=" +
      "/Users/someone/Library/Application Support/Geode";
    expect(shouldReapProcess(real, TMP)).toBe(false);
    expect(shouldReapProcess("/Applications/Geode.app/Contents/MacOS/Geode", TMP)).toBe(false);
  });

  it("never matches unrelated apps, including other Electron apps", () => {
    expect(shouldReapProcess("/Applications/Slack.app/Contents/MacOS/Slack", TMP)).toBe(false);
    expect(shouldReapProcess("node /repo/scripts/e2e-clean.mts", TMP)).toBe(false);
    // Mentions geode but has no e2e user-data dir: still out of scope.
    expect(shouldReapProcess("vim /repo/geode-e2e-notes.md", TMP)).toBe(false);
  });
});

describe("shouldReapProcess — worktree scoping", () => {
  // Regression guard. Without repoRoot this reaper killed a *live* test run
  // belonging to a sibling git worktree, because temp dir names carry no hint
  // of which checkout created them.
  const mine = "/tmp/wt/alpha";
  const theirs = "/tmp/wt/beta";
  const command = (root: string) =>
    `${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ` +
    `${root} --user-data-dir=${TMP}/geode-e2e-Ab12Cd`;

  it("matches a launch from the reaping checkout", () => {
    expect(shouldReapProcess(command(mine), TMP, mine)).toBe(true);
  });

  it("does not match an identical launch from a sibling worktree", () => {
    expect(shouldReapProcess(command(theirs), TMP, mine)).toBe(false);
  });

  it("matches both when no repoRoot is given (explicit --force)", () => {
    expect(shouldReapProcess(command(mine), TMP)).toBe(true);
    expect(shouldReapProcess(command(theirs), TMP)).toBe(true);
  });
});

describe("isStaleDir", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-probe-"));
    created.push(dir);
    return dir;
  };

  it("treats a just-written directory as live", () => {
    const dir = make();
    fs.writeFileSync(path.join(dir, "geode.json"), "{}");
    expect(isStaleDir(dir, 30 * 60 * 1000, Date.now())).toBe(false);
  });

  it("treats an untouched directory as stale once past the threshold", () => {
    const dir = make();
    fs.writeFileSync(path.join(dir, "geode.json"), "{}");
    // Look at it from an hour in the future rather than faking timestamps.
    expect(isStaleDir(dir, 30 * 60 * 1000, Date.now() + 60 * 60 * 1000)).toBe(true);
  });

  it("notices writes to files inside, not just to the directory entry", () => {
    const dir = make();
    const old = Date.now() - 60 * 60 * 1000;
    const file = path.join(dir, "geode.json");
    fs.writeFileSync(file, "{}");
    // Age the directory entry but leave the file freshly written: a live run
    // appending to an existing file must not read as stale.
    fs.utimesSync(dir, new Date(old), new Date(old));
    expect(isStaleDir(dir, 30 * 60 * 1000, Date.now())).toBe(false);
  });

  it("is a no-op gate when the threshold is zero", () => {
    expect(isStaleDir(make(), 0, Date.now())).toBe(true);
  });

  it("refuses to claim a directory it cannot read", () => {
    expect(isStaleDir("/nonexistent/nope", 1000, Date.now())).toBe(false);
  });
});

describe("parsePsOutput", () => {
  it("splits pid from command and drops blank lines", () => {
    const rows = parsePsOutput(["  501 /bin/foo --flag", "", "1234 bar baz", "garbage"].join("\n"));
    expect(rows).toEqual([
      { pid: 501, command: "/bin/foo --flag" },
      { pid: 1234, command: "bar baz" },
    ]);
  });
});

describe("reapE2EArtifacts", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-root-"));
    created.push(root);
    return root;
  }

  it("removes matching dirs and leaves everything else untouched", async () => {
    const root = makeRoot();
    const target = fs.mkdtempSync(path.join(root, "geode-e2e-"));
    fs.writeFileSync(path.join(target, "geode.json"), "{}");
    // Name matches the suite's prefix but holds only the developer's own work:
    // survives on the strength of the artifact gate, not the name.
    const bystander = path.join(root, "geode-scratch");
    fs.mkdirSync(bystander);
    fs.writeFileSync(path.join(bystander, "notes.md"), "# mine");
    const unrelated = fs.mkdtempSync(path.join(root, "playwright-"));

    const result = await reapE2EArtifacts({ tmpRoot: root });

    expect(result.removedDirs).toEqual([target]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(bystander)).toBe(true);
    expect(fs.readFileSync(path.join(bystander, "notes.md"), "utf8")).toBe("# mine");
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("dry run reports without deleting", async () => {
    const root = makeRoot();
    const target = fs.mkdtempSync(path.join(root, "geode-e2e-"));
    fs.writeFileSync(path.join(target, "geode.json"), "{}");
    const lines: string[] = [];

    const result = await reapE2EArtifacts({ tmpRoot: root, dryRun: true, log: (m) => lines.push(m) });

    expect(result.removedDirs).toEqual([target]);
    expect(fs.existsSync(target)).toBe(true);
    expect(lines.some((line) => line.includes(target))).toBe(true);
  });

  it("is a no-op on an empty root", async () => {
    const result = await reapE2EArtifacts({ tmpRoot: makeRoot() });
    expect(result).toEqual({ killedPids: [], removedDirs: [], failed: [] });
  });

  it("minAgeMs spares a directory a concurrent run is still using", async () => {
    const root = makeRoot();
    const live = fs.mkdtempSync(path.join(root, "geode-e2e-"));
    fs.writeFileSync(path.join(live, "geode.json"), "{}");

    const result = await reapE2EArtifacts({ tmpRoot: root, minAgeMs: 30 * 60 * 1000 });

    expect(result.removedDirs).toEqual([]);
    expect(fs.existsSync(live)).toBe(true);
  });

  it("--all skips the artifact gate but still respects the name gate", async () => {
    const root = makeRoot();
    // No app marker: only `all` can claim this one.
    const fixture = fs.mkdtempSync(path.join(root, "geode-parity-ledger-"));
    fs.mkdirSync(path.join(fixture, "obsidian-api"));
    const unrelated = fs.mkdtempSync(path.join(root, "playwright-"));

    expect((await reapE2EArtifacts({ tmpRoot: root })).removedDirs).toEqual([]);

    const result = await reapE2EArtifacts({ tmpRoot: root, all: true });

    expect(result.removedDirs).toEqual([fixture]);
    expect(fs.existsSync(fixture)).toBe(false);
    // The name gate is not bypassed: non-geode dirs are still off limits.
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

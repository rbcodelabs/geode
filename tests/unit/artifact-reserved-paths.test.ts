import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactPathError, resolveArtifactEntry, resolveArtifactFile } from "../../src/main/artifact-paths";
import { isReservedArtifactPath } from "../../src/artifacts/reserved-paths";
import { isReservedOnDisk } from "../../src/main/artifact-reserved-dir";

describe("isReservedArtifactPath (layer 1, lexical)", () => {
  const denied: [string, string][] = [
    ["exact", ".threads-design"],
    ["trailing slash", ".threads-design/"],
    ["nested file", ".threads-design/selections/sel_1.json"],
    ["leading slashes", "//.threads-design/x"],
    ["upper case", ".THREADS-DESIGN/x"],
    ["mixed case", ".Threads-Design/x"],
    ["percent-encoded dot", "%2ethreads-design/x"],
    ["percent-encoded dot upper", "%2Ethreads-design/x"],
    ["double encoded dot", "%252ethreads-design/x"],
    ["triple encoded dot", "%25252ethreads-design/x"],
    ["encoded slash after name", ".threads-design%2fx"],
    ["dot segment", "./.threads-design/x"],
    ["traversal back into it", "sub/../.threads-design/x"],
    ["encoded traversal back into it", "sub/%2e%2e/.threads-design/x"],
    ["backslash separator", ".threads-design\\selections\\x.json"],
    ["leading backslash", "\\.threads-design\\x"],
    ["long s folding (U+017F)", ".threadſ-design/x"],
    ["fullwidth full stop", "．threads-design/x"],
    ["trailing dot", ".threads-design./x"],
    ["trailing space", ".threads-design /x"],
    ["encoded trailing space", ".threads-design%20/x"],
    ["trailing dots and spaces", ".threads-design. . /x"],
    ["zero width space", ".threads​-design/x"],
    ["soft hyphen", ".threads-design­/x"],
    ["word joiner", ".threads-⁠design/x"],
    ["BOM", "﻿.threads-design/x"],
  ];
  for (const [name, input] of denied) {
    it(`denies: ${name}`, () => expect(isReservedArtifactPath(input)).toBe(true));
  }

  const allowed: [string, string][] = [
    ["index", "index.html"],
    ["captures", "captures/capture-1.png"],
    ["similar prefix", ".threads-design-notes/a.txt"],
    ["without dot", "threads-design/a.txt"],
    ["suffix", ".threads-designs/a.txt"],
    ["nested copy is an ordinary directory", "sub/.threads-design/a.txt"],
    ["empty", ""],
    ["malformed percent escape", "100%/a.txt"],
  ];
  for (const [name, input] of allowed) {
    it(`allows: ${name}`, () => expect(isReservedArtifactPath(input)).toBe(false));
  }
});

describe("artifact reserved directory on disk (layers 2 and 3)", () => {
  let root: string;
  let realRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "geode-reserved-"));
    realRoot = await realpath(root);
    await mkdir(path.join(root, ".threads-design", "selections"), { recursive: true });
    await writeFile(path.join(root, ".threads-design", "secret.txt"), "secret");
    await writeFile(path.join(root, ".threads-design", "selections", "sel.json"), "{}");
    await writeFile(path.join(root, "index.html"), "<main>ok</main>");
    await mkdir(path.join(root, ".threads-design-notes"));
    await writeFile(path.join(root, ".threads-design-notes", "a.txt"), "ok");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("denies the directory, its files, and nothing else", async () => {
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, ".threads-design"))).toBe(true);
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, ".threads-design", "secret.txt"))).toBe(true);
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, ".threads-design", "selections", "sel.json"))).toBe(true);
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, "index.html"))).toBe(false);
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, ".threads-design-notes", "a.txt"))).toBe(false);
  });

  it("denies a symlink alias of the directory (realpath layer)", async () => {
    await symlink(path.join(root, ".threads-design"), path.join(root, "public"));
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, "public", "secret.txt"))).toBe(true);
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, "public"))).toBe(true);
  });

  it("denies a symlink alias of a file inside the directory", async () => {
    await symlink(path.join(root, ".threads-design", "secret.txt"), path.join(root, "innocent.txt"));
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, "innocent.txt"))).toBe(true);
  });

  it("denies a chained alias (alias of an alias)", async () => {
    await symlink(path.join(root, ".threads-design"), path.join(root, "a"));
    await symlink(path.join(root, "a"), path.join(root, "b"));
    expect(await isReservedOnDisk(realRoot, path.join(realRoot, "b", "secret.txt"))).toBe(true);
  });

  it("is false when the reserved directory does not exist", async () => {
    const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "geode-reserved-empty-")));
    await writeFile(path.join(empty, "index.html"), "x");
    expect(await isReservedOnDisk(empty, path.join(empty, "index.html"))).toBe(false);
    await rm(empty, { recursive: true, force: true });
  });

  it("resolveArtifactFile throws reserved_path for every layer", async () => {
    await symlink(path.join(root, ".threads-design"), path.join(root, "public"));
    for (const rel of [".threads-design/secret.txt", ".Threads-Design/secret.txt", "sub/../.threads-design/secret.txt", "public/secret.txt"]) {
      await expect(resolveArtifactFile(root, rel), rel).rejects.toMatchObject<Partial<ArtifactPathError>>({ code: "reserved_path" });
    }
  });

  it("resolveArtifactEntry rejects an entry inside the directory", async () => {
    await writeFile(path.join(root, ".threads-design", "page.html"), "x");
    await expect(resolveArtifactEntry(root, ".threads-design/page.html")).rejects.toMatchObject<Partial<ArtifactPathError>>({
      code: "reserved_path",
    });
  });

  it("still resolves legitimate files", async () => {
    for (const rel of ["index.html", ".threads-design-notes/a.txt"]) {
      await expect(resolveArtifactFile(root, rel)).resolves.toMatchObject({ file: path.join(realRoot, rel) });
    }
  });
});

// Case/normalization aliasing only exists on case-insensitive volumes (macOS APFS default, Windows).
// Detected with the real filesystem at collection time; on Linux ext4/tmpfs these are skipped
// because the alias cannot exist there (the lexical layer covers the same inputs on every platform).
function detectCaseInsensitiveFs(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "geode-case-probe-"));
  try {
    mkdirSync(path.join(dir, ".threads-design"));
    return existsSync(path.join(dir, ".THREADS-DESIGN"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const caseInsensitiveFs = detectCaseInsensitiveFs();

describe.skipIf(!caseInsensitiveFs)("case-insensitive filesystem aliases (inode layer alone)", () => {
  it("denies a case variant that resolves to the reserved directory without the lexical layer", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "geode-reserved-ci-")));
    await mkdir(path.join(root, ".threads-design"));
    await writeFile(path.join(root, ".threads-design", "secret.txt"), "secret");
    // The JS realpath keeps the typed case on macOS, so only the (dev, ino) walk can catch this.
    expect(await isReservedOnDisk(root, path.join(root, ".THREADS-DESIGN", "secret.txt"))).toBe(true);
    await expect(resolveArtifactFile(root, ".THREADS-DESIGN/secret.txt")).rejects.toMatchObject({ code: "reserved_path" });
    await rm(root, { recursive: true, force: true });
  });
});

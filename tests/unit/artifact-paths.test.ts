import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactPathError, isPathInside, resolveArtifactEntry } from "../../src/main/artifact-paths";

describe("artifact path containment", () => {
  it("recognizes path boundaries rather than string prefixes", () => {
    expect(isPathInside("/tmp/artifact", "/tmp/artifact/index.html")).toBe(true);
    expect(isPathInside("/tmp/artifact", "/tmp/artifact-evil/index.html")).toBe(false);
  });

  it("resolves an existing entry beneath the real artifact root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "geode-artifact-"));
    await mkdir(path.join(root, "screens"));
    await writeFile(path.join(root, "screens/index.html"), "<main>Safe</main>");
    const resolved = await resolveArtifactEntry(root, "screens/index.html");
    expect(resolved.root).toBe(await (await import("node:fs/promises")).realpath(root));
    expect(resolved.entry).toBe(path.join(resolved.root, "screens/index.html"));
  });

  it("rejects lexical traversal even when the target exists", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "geode-artifact-parent-"));
    const root = path.join(parent, "artifact");
    await mkdir(root);
    await writeFile(path.join(parent, "outside.html"), "outside");
    await expect(resolveArtifactEntry(root, "../outside.html")).rejects.toMatchObject<Partial<ArtifactPathError>>({ code: "outside_root" });
  });

  it("rejects a symlink that escapes the artifact root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "geode-artifact-parent-"));
    const root = path.join(parent, "artifact");
    await mkdir(root);
    await writeFile(path.join(parent, "outside.html"), "outside");
    await symlink(path.join(parent, "outside.html"), path.join(root, "index.html"));
    await expect(resolveArtifactEntry(root, "index.html")).rejects.toMatchObject<Partial<ArtifactPathError>>({ code: "outside_root" });
  });
});

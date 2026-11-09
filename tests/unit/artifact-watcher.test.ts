import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactWatcher, type ArtifactWatcher } from "../../src/main/artifact-watcher";

let root: string;
let watcher: ArtifactWatcher | undefined;
let changes: string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for watcher event");
    await sleep(25);
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "geode-watch-")));
  await mkdir(path.join(root, ".threads-design", "selections"), { recursive: true });
  await mkdir(path.join(root, "captures"));
  await writeFile(path.join(root, "index.html"), "v1");
  await symlink(path.join(root, ".threads-design"), path.join(root, "alias"));
  changes = [];
  watcher = createArtifactWatcher(root, (eventPath) => changes.push(path.relative(root, eventPath)));
  await watcher.ready;
});
afterEach(async () => {
  await watcher?.close();
  await rm(root, { recursive: true, force: true });
});

describe("artifact watcher", () => {
  it("reports a write to index.html", async () => {
    await writeFile(path.join(root, "index.html"), "v2");
    await until(() => changes.includes("index.html"));
  });

  it("does not report writes under .threads-design/, via the real path or a symlink alias", async () => {
    await writeFile(path.join(root, ".threads-design", "selections", "sel_a.json"), "{}");
    await writeFile(path.join(root, ".threads-design", "top.json"), "{}");
    await writeFile(path.join(root, "alias", "via-alias.json"), "{}");
    await writeFile(path.join(root, "captures", "shot.png"), "x"); // pre-existing ignore, unchanged
    // Sentinel: events arrive in order, so once it is seen any earlier event would have been recorded too.
    await sleep(300);
    await writeFile(path.join(root, "index.html"), "v3");
    await until(() => changes.includes("index.html"));
    await sleep(300);
    expect(changes.filter((c) => c !== "index.html")).toEqual([]);
  });

  it("still reports a similarly named directory", async () => {
    await mkdir(path.join(root, ".threads-design-notes"));
    await sleep(100);
    await writeFile(path.join(root, ".threads-design-notes", "a.txt"), "x");
    await until(() => changes.some((c) => c.startsWith(".threads-design-notes")));
  });
});

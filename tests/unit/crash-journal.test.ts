import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CrashJournal } from "../../src/main/crash-journal";

describe("CrashJournal", () => {
  it("persists renderer and plugin diagnostics and keeps only the configured bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geode-crash-journal-"));
    const journalPath = path.join(dir, "crashes.json");
    const journal = new CrashJournal(journalPath, 2);

    await journal.append({ type: "plugin-error", at: 1, pluginId: "alpha", boundary: "command:run", message: "first" });
    await journal.append({ type: "plugin-error", at: 2, pluginId: "beta", boundary: "view:onOpen", message: "second" });
    await journal.append({ type: "renderer-gone", at: 3, reason: "crashed", exitCode: 139, activePlugins: ["beta"] });

    expect(journal.read()).toEqual([
      { type: "plugin-error", at: 2, pluginId: "beta", boundary: "view:onOpen", message: "second" },
      { type: "renderer-gone", at: 3, reason: "crashed", exitCode: 139, activePlugins: ["beta"] },
    ]);
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toHaveLength(2);
  });

  it("recovers from a corrupt journal without losing the new diagnostic", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geode-crash-journal-"));
    const journalPath = path.join(dir, "crashes.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(journalPath, "not-json");

    const journal = new CrashJournal(journalPath);
    await journal.append({ type: "renderer-hang", at: 4, activePlugins: [] });

    expect(journal.read()).toEqual([{ type: "renderer-hang", at: 4, activePlugins: [] }]);
  });
});

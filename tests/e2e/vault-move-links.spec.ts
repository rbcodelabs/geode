import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const FENCE = "```";
const FILES: Record<string, string> = {
  "Projects/Alpha/Note.md": "# Note\n[[Other]] [rel](Other.md) [up](../Beta/Beta.md) [[Leaf]]\n",
  "Projects/Alpha/Other.md": "# Other\nback to [[Projects/Alpha/Note]] and [md](Note.md)\n",
  "Projects/Alpha/Deep/Leaf.md": "# Leaf\n[[Note]] [n](../Note.md)\n",
  "Projects/Alpha/pic.png": "not-really-a-png",
  "Projects/Beta/Beta.md": "# Beta\n",
  "Outside/Links.md": [
    "# Links",
    "basename [[Note]]",
    "path [[Projects/Alpha/Note]]",
    "alias [[Projects/Alpha/Note|The Alias]]",
    "embed ![[Projects/Alpha/Note]]",
    "image ![[Projects/Alpha/pic.png]]",
    "heading [[Projects/Alpha/Note#Sec]]",
    "md [x](Projects/Alpha/Note.md)",
    "mdh [y](Projects/Alpha/Note.md#Sec)",
    FENCE,
    "[[Projects/Alpha/Note]] [z](Projects/Alpha/Note.md)",
    FENCE,
    "",
  ].join("\n"),
  "Outside/Plain.md": "# Plain\n[[Note]] [[Beta]]\n",
  "Unrelated.md": "# Unrelated\n[[Beta]] [[Plain]] nothing here\n",
};

const EXPECTED_AFTER: Record<string, string> = {
  "Archive/Alpha/Note.md": "# Note\n[[Other]] [rel](Other.md) [up](../../Projects/Beta/Beta.md) [[Leaf]]\n",
  "Archive/Alpha/Other.md": "# Other\nback to [[Archive/Alpha/Note]] and [md](Note.md)\n",
  "Archive/Alpha/Deep/Leaf.md": FILES["Projects/Alpha/Deep/Leaf.md"],
  "Archive/Alpha/pic.png": FILES["Projects/Alpha/pic.png"],
  "Projects/Beta/Beta.md": FILES["Projects/Beta/Beta.md"],
  "Outside/Links.md": [
    "# Links",
    "basename [[Note]]",
    "path [[Archive/Alpha/Note]]",
    "alias [[Archive/Alpha/Note|The Alias]]",
    "embed ![[Archive/Alpha/Note]]",
    "image ![[Archive/Alpha/pic.png]]",
    "heading [[Archive/Alpha/Note#Sec]]",
    "md [x](Archive/Alpha/Note.md)",
    "mdh [y](Archive/Alpha/Note.md#Sec)",
    FENCE,
    "[[Projects/Alpha/Note]] [z](Projects/Alpha/Note.md)",
    FENCE,
    "",
  ].join("\n"),
  "Outside/Plain.md": FILES["Outside/Plain.md"],
  "Unrelated.md": FILES["Unrelated.md"],
};

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Every non-hidden file under `root` -> sha256. Hidden entries (.obsidian, app state) are app-owned. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join("/")] = sha(fs.readFileSync(full));
    }
  };
  walk(root);
  return out;
}

test("moving a folder through the plugin-facing API rewrites links and nothing else", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-move-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-move-ud-"));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, rel), content);
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1" },
  });
  try {
    const window = await app.firstWindow();
    await window.locator(".nav-file-title").first().waitFor({ state: "visible" });
    await window.waitForFunction(() => !!(window as any).app);
    // The link index builds in the background: wait until it knows about every inbound link.
    await window.waitForFunction(() => {
      const geode = (window as any).app;
      const note = geode.vault.getFileByPath("Projects/Alpha/Note.md");
      return !!note && geode.metadataCache.getBacklinksForFile(note).keys().length >= 4;
    }, undefined, { timeout: 30_000 });

    const before = snapshot(vaultDir);
    expect(Object.keys(before).sort()).toEqual(Object.keys(FILES).sort());

    // Backlinks, Obsidian shape, before the move.
    const sourcesBefore = await window.evaluate(() => {
      const geode = (window as any).app;
      const result = geode.metadataCache.getBacklinksForFile(geode.vault.getFileByPath("Projects/Alpha/Note.md"));
      const seen: Record<string, string[]> = {};
      result.data.forEach((refs: Array<{ original: string }>, source: string) => { seen[source] = refs.map((r) => r.original); });
      return { isMap: result.data instanceof Map, seen };
    });
    expect(sourcesBefore.isMap).toBe(true);
    expect(Object.keys(sourcesBefore.seen).sort()).toEqual([
      "Outside/Links.md", "Outside/Plain.md", "Projects/Alpha/Deep/Leaf.md", "Projects/Alpha/Other.md",
    ]);
    expect(sourcesBefore.seen["Outside/Links.md"]).toEqual(expect.arrayContaining([
      "[[Note]]", "[[Projects/Alpha/Note]]", "[[Projects/Alpha/Note|The Alias]]", "![[Projects/Alpha/Note]]",
      "[[Projects/Alpha/Note#Sec]]", "[x](Projects/Alpha/Note.md)", "[y](Projects/Alpha/Note.md#Sec)",
    ]));

    // Refusals leave everything untouched.
    const refusals = await window.evaluate(async () => {
      const geode = (window as any).app;
      const attempt = async (from: string, to: string) => {
        try { await geode.fileManager.moveWithLinkUpdate(from, to); return "no error"; }
        catch (error) { return String((error as Error).message); }
      };
      return {
        overwriteFile: await attempt("Outside/Plain.md", "Unrelated.md"),
        overwriteFolder: await attempt("Projects/Alpha", "Projects/Beta"),
        traversal: await attempt("Projects/Alpha", "../escaped"),
        absolute: await attempt("Projects/Alpha", "/tmp/escaped"),
        intoSelf: await attempt("Projects/Alpha", "Projects/Alpha/Deep/Inner"),
        missing: await attempt("Nope.md", "Archive/Nope.md"),
      };
    });
    expect(refusals.overwriteFile).toMatch(/already exists/);
    expect(refusals.overwriteFolder).toMatch(/already exists/);
    expect(refusals.traversal).toMatch(/\.\./);
    expect(refusals.absolute).toMatch(/vault-relative/);
    expect(refusals.intoSelf).toMatch(/into itself/);
    expect(refusals.missing).toMatch(/does not exist/);
    expect(snapshot(vaultDir)).toEqual(before);

    // The move.
    const result = await window.evaluate(() => (window as any).app.fileManager.moveWithLinkUpdate("Projects/Alpha", "Archive/Alpha"));
    expect(result).toEqual({
      moved: [{ from: "Projects/Alpha", to: "Archive/Alpha" }],
      updatedNotes: ["Archive/Alpha/Note.md", "Archive/Alpha/Other.md", "Outside/Links.md"],
    });

    const after = snapshot(vaultDir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(EXPECTED_AFTER).sort());
    for (const [rel, expected] of Object.entries(EXPECTED_AFTER)) {
      expect(fs.readFileSync(path.join(vaultDir, rel), "utf8"), rel).toBe(expected);
    }
    // Everything not expected to change is byte-identical to before (hash compare).
    expect(after["Unrelated.md"]).toBe(before["Unrelated.md"]);
    expect(after["Outside/Plain.md"]).toBe(before["Outside/Plain.md"]);
    expect(after["Projects/Beta/Beta.md"]).toBe(before["Projects/Beta/Beta.md"]);
    expect(after["Archive/Alpha/Deep/Leaf.md"]).toBe(before["Projects/Alpha/Deep/Leaf.md"]);
    expect(after["Archive/Alpha/pic.png"]).toBe(before["Projects/Alpha/pic.png"]);
    expect(fs.existsSync(path.join(vaultDir, "Projects/Alpha"))).toBe(false);

    // The index follows: backlinks of the moved note now come from the new locations.
    await window.waitForFunction(() => {
      const geode = (window as any).app;
      const note = geode.vault.getFileByPath("Archive/Alpha/Note.md");
      return !!note && geode.metadataCache.getBacklinksForFile(note).keys().length >= 4;
    }, undefined, { timeout: 30_000 });
    const sourcesAfter = await window.evaluate(() => {
      const geode = (window as any).app;
      return geode.metadataCache.getBacklinksForFile(geode.vault.getFileByPath("Archive/Alpha/Note.md")).keys();
    });
    expect([...sourcesAfter].sort()).toEqual([
      "Archive/Alpha/Deep/Leaf.md", "Archive/Alpha/Other.md", "Outside/Links.md", "Outside/Plain.md",
    ]);

    // Case-only rename of the same file must not be treated as an overwrite.
    const caseOnly = await window.evaluate(() => (window as any).app.fileManager.moveWithLinkUpdate("Outside/Plain.md", "Outside/plain.md"));
    expect(caseOnly).toEqual({ moved: [{ from: "Outside/Plain.md", to: "Outside/plain.md" }], updatedNotes: [] });
    expect(fs.readdirSync(path.join(vaultDir, "Outside")).sort()).toEqual(["Links.md", "plain.md"]);
    expect(fs.readFileSync(path.join(vaultDir, "Outside/plain.md"), "utf8")).toBe(FILES["Outside/Plain.md"]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

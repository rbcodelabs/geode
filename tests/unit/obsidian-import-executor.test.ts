/**
 * Adversarial tests for the Obsidian-import I/O executor
 * (`importFromObsidianVault`), against REAL temp directories — no fs mocks.
 *
 * The planner had unit coverage; the executor had none, and that is exactly
 * where the data-destroying bugs lived: the "never overwrite an already-present
 * item" guarantee was decided with exact-string `Set.has()`, but enforced with
 * `fsp.rm(destDir, {recursive: true, force: true})`. macOS folds case and
 * unicode; `Set.has()` does not. Every test below fails against that version by
 * losing user data.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importFromObsidianVault } from "../../src/main/obsidian-import";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geode-import-exec-"));
  roots.push(root);
  return root;
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A minimally-valid plugin folder (manifest.json + main.js, plus extras). */
function seedPlugin(dir: string, id: string, extra: Record<string, string> = {}): void {
  write(path.join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0" }));
  write(path.join(dir, "main.js"), `module.exports = ${JSON.stringify(id)};\n`);
  for (const [name, contents] of Object.entries(extra)) write(path.join(dir, name), contents);
}

function names(items: { name: string }[]): string[] {
  return items.map((i) => i.name);
}

describe("importFromObsidianVault — collision safety (B1)", () => {
  it("does not touch an installed plugin whose name differs only by case", async () => {
    const root = makeVault();
    // Geode installed it under the manifest-id casing (how the GitHub
    // installer names it); Obsidian uses the lowercase id.
    const installed = path.join(root, ".geode", "plugins", "MyPlugin");
    seedPlugin(installed, "MyPlugin", { "data.json": '{"apiKey":"user-secret","runs":42}' });
    seedPlugin(path.join(root, ".obsidian", "plugins", "myplugin"), "myplugin", {
      "data.json": '{"apiKey":"","runs":0}',
    });

    const result = await importFromObsidianVault(root);

    // The installed plugin and its settings survive, byte for byte.
    expect(fs.existsSync(path.join(installed, "main.js"))).toBe(true);
    expect(fs.readFileSync(path.join(installed, "data.json"), "utf8")).toBe(
      '{"apiKey":"user-secret","runs":42}'
    );
    expect(fs.readFileSync(path.join(installed, "main.js"), "utf8")).toContain("MyPlugin");

    // …and it is reported as skipped, naming what it collided with.
    expect(result.plugins).toEqual([]);
    const skip = result.skipped.find((s) => s.kind === "plugin" && s.name === "myplugin");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("MyPlugin");
    expect(skip?.reason).toContain("already present");
  });

  it("does not touch an installed plugin whose name differs only by unicode normalization", async () => {
    const root = makeVault();
    const nfc = "Café-plugin"; // é as a single code point
    const nfd = "Café-plugin"; // e + combining acute
    expect(nfc).not.toBe(nfd);
    expect(nfd.normalize("NFC")).toBe(nfc);

    const installed = path.join(root, ".geode", "plugins", nfc);
    seedPlugin(installed, nfc, { "data.json": '{"keep":"me"}' });
    seedPlugin(path.join(root, ".obsidian", "plugins", nfd), nfd, {
      "data.json": '{"keep":"NOT me"}',
    });

    const result = await importFromObsidianVault(root);

    expect(fs.readFileSync(path.join(installed, "data.json"), "utf8")).toBe('{"keep":"me"}');
    expect(result.plugins).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes(nfc))).toBe(true);
  });

  it("refuses to clobber a destination the guard could not see (fail-safe, not rm)", async () => {
    const root = makeVault();
    // A *file* named like a plugin dir: the guard enumerates directories only,
    // so the planner thinks the name is free. The old code's rm() deleted it;
    // the fail-safe leaves it alone and reports the item as skipped.
    write(path.join(root, ".geode", "plugins", "ghost"), "do not delete me");
    seedPlugin(path.join(root, ".obsidian", "plugins", "ghost"), "ghost");

    const result = await importFromObsidianVault(root);

    expect(fs.readFileSync(path.join(root, ".geode", "plugins", "ghost"), "utf8")).toBe(
      "do not delete me"
    );
    expect(result.plugins).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ kind: "plugin", name: "ghost" })
    );
    // No staging directory left behind.
    const leftovers = fs
      .readdirSync(path.join(root, ".geode", "plugins"))
      .filter((n) => n.startsWith(".import-"));
    expect(leftovers).toEqual([]);
  });

  it("still imports a genuinely new plugin alongside a colliding one", async () => {
    const root = makeVault();
    seedPlugin(path.join(root, ".geode", "plugins", "MyPlugin"), "MyPlugin");
    seedPlugin(path.join(root, ".obsidian", "plugins", "myplugin"), "myplugin");
    seedPlugin(path.join(root, ".obsidian", "plugins", "brand-new"), "brand-new");

    const result = await importFromObsidianVault(root);

    expect(result.plugins).toEqual(["brand-new"]);
    expect(fs.existsSync(path.join(root, ".geode", "plugins", "brand-new", "main.js"))).toBe(true);
  });
});

describe("importFromObsidianVault — theme overwrite guard (B2)", () => {
  it("protects a theme directory that has no theme.css", async () => {
    const root = makeVault();
    // An interrupted install / hand-edited theme: manifest + assets, no CSS yet.
    const installed = path.join(root, ".geode", "themes", "Minimal");
    write(path.join(installed, "manifest.json"), '{"name":"Minimal","version":"9.9.9"}');
    write(path.join(installed, "assets", "logo.svg"), "<svg/>");
    write(path.join(installed, "theme.css.bak"), "/* work in progress */");

    write(path.join(root, ".obsidian", "themes", "Minimal", "theme.css"), ":root{--x:1}");

    const result = await importFromObsidianVault(root);

    // Everything under the existing directory survives.
    expect(fs.readFileSync(path.join(installed, "manifest.json"), "utf8")).toContain("9.9.9");
    expect(fs.existsSync(path.join(installed, "assets", "logo.svg"))).toBe(true);
    expect(fs.readFileSync(path.join(installed, "theme.css.bak"), "utf8")).toContain(
      "work in progress"
    );
    expect(fs.existsSync(path.join(installed, "theme.css"))).toBe(false);

    expect(result.themes).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ kind: "theme", name: "Minimal" })
    );
  });

  it("protects a theme directory whose name differs only by case", async () => {
    const root = makeVault();
    const installed = path.join(root, ".geode", "themes", "Things");
    write(path.join(installed, "theme.css"), "/* mine */");
    write(path.join(root, ".obsidian", "themes", "things", "theme.css"), "/* theirs */");

    const result = await importFromObsidianVault(root);

    expect(fs.readFileSync(path.join(installed, "theme.css"), "utf8")).toBe("/* mine */");
    expect(result.themes).toEqual([]);
    expect(result.skipped.some((s) => s.kind === "theme" && s.reason.includes("Things"))).toBe(true);
  });

  it("treats a bare <name>.css in .geode/themes/ as occupying that name", async () => {
    const root = makeVault();
    write(path.join(root, ".geode", "themes", "Legacy.css"), "/* legacy theme */");
    write(path.join(root, ".obsidian", "themes", "Legacy", "theme.css"), "/* incoming */");

    const result = await importFromObsidianVault(root);

    expect(fs.readFileSync(path.join(root, ".geode", "themes", "Legacy.css"), "utf8")).toBe(
      "/* legacy theme */"
    );
    expect(result.themes).toEqual([]);
  });

  it("still copies a new theme when nothing occupies its name", async () => {
    const root = makeVault();
    write(path.join(root, ".obsidian", "themes", "Fresh", "theme.css"), "/* fresh */");
    write(path.join(root, ".obsidian", "themes", "Fresh", "manifest.json"), '{"name":"Fresh"}');
    write(path.join(root, ".obsidian", "appearance.json"), '{"cssTheme":"Fresh"}');

    const result = await importFromObsidianVault(root);

    expect(result.themes).toEqual(["Fresh"]);
    expect(result.activeTheme).toBe("Fresh");
    expect(
      fs.readFileSync(path.join(root, ".geode", "themes", "Fresh", "theme.css"), "utf8")
    ).toBe("/* fresh */");
    expect(fs.existsSync(path.join(root, ".geode", "themes", "Fresh", "manifest.json"))).toBe(true);
  });
});

describe("importFromObsidianVault — enable only what was copied (B3a)", () => {
  it("does not re-enable a plugin the user disabled in Geode", async () => {
    const root = makeVault();
    // Installed in Geode, then deliberately switched off (absent from plugins.json).
    seedPlugin(path.join(root, ".geode", "plugins", "buggy"), "buggy");
    write(path.join(root, ".geode", "plugins.json"), JSON.stringify(["other"]));
    seedPlugin(path.join(root, ".geode", "plugins", "other"), "other");
    // Their old Obsidian config still lists it as enabled.
    seedPlugin(path.join(root, ".obsidian", "plugins", "buggy"), "buggy");
    write(path.join(root, ".obsidian", "community-plugins.json"), JSON.stringify(["buggy"]));

    const result = await importFromObsidianVault(root);

    expect(result.plugins).toEqual([]);
    expect(result.pluginsToEnable).toEqual([]);
    // The informational merged view may still mention it; the actionable set may not.
    expect(result.pluginsToEnable).not.toContain("buggy");
  });

  it("enables a freshly copied plugin that Obsidian had enabled", async () => {
    const root = makeVault();
    seedPlugin(path.join(root, ".obsidian", "plugins", "wanted"), "wanted");
    seedPlugin(path.join(root, ".obsidian", "plugins", "unwanted"), "unwanted");
    write(path.join(root, ".obsidian", "community-plugins.json"), JSON.stringify(["wanted"]));

    const result = await importFromObsidianVault(root);

    expect(result.plugins.sort()).toEqual(["unwanted", "wanted"]);
    // Copied but not enabled in Obsidian ⇒ copied, left off.
    expect(result.pluginsToEnable).toEqual(["wanted"]);
  });

  it("does not enable a case-variant of an already-installed, disabled plugin", async () => {
    const root = makeVault();
    seedPlugin(path.join(root, ".geode", "plugins", "Buggy"), "Buggy");
    write(path.join(root, ".geode", "plugins.json"), "[]");
    seedPlugin(path.join(root, ".obsidian", "plugins", "buggy"), "buggy");
    write(path.join(root, ".obsidian", "community-plugins.json"), JSON.stringify(["buggy"]));

    const result = await importFromObsidianVault(root);

    expect(result.pluginsToEnable).toEqual([]);
  });
});

describe("importFromObsidianVault — source hardening", () => {
  it("ignores a symlinked data.json instead of copying the file it points at", async () => {
    const root = makeVault();
    const secretDir = makeVault();
    const secret = path.join(secretDir, "id_rsa");
    fs.writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\n");

    const src = path.join(root, ".obsidian", "plugins", "sneaky");
    seedPlugin(src, "sneaky");
    fs.symlinkSync(secret, path.join(src, "data.json"));

    const result = await importFromObsidianVault(root);

    expect(result.plugins).toEqual(["sneaky"]);
    const dest = path.join(root, ".geode", "plugins", "sneaky");
    expect(fs.existsSync(path.join(dest, "main.js"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "data.json"))).toBe(false);
  });

  it("returns an empty result when there is no .obsidian folder", async () => {
    const root = makeVault();
    await fsp.mkdir(path.join(root, ".geode"), { recursive: true });

    const result = await importFromObsidianVault(root);

    expect(result).toEqual({
      plugins: [],
      themes: [],
      enabledPluginIds: [],
      pluginsToEnable: [],
      activeTheme: null,
      skipped: [],
    });
  });

  it("skips a malformed plugin (no main.js) without creating anything", async () => {
    const root = makeVault();
    const src = path.join(root, ".obsidian", "plugins", "half");
    write(path.join(src, "manifest.json"), '{"id":"half"}');

    const result = await importFromObsidianVault(root);

    expect(result.plugins).toEqual([]);
    expect(names(result.skipped)).toEqual(["half"]);
    expect(fs.existsSync(path.join(root, ".geode", "plugins", "half"))).toBe(false);
  });
});

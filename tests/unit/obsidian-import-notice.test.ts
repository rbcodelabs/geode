/**
 * The import notice must describe everything that happened. It previously read
 * only the copied-plugin/copied-theme counts, so a run that copied nothing but
 * enabled three plugins and applied a theme told the user "Nothing to import"
 * — after having executed three plugins' `onload()`.
 */

import { describe, expect, it } from "vitest";
import {
  formatObsidianImportNotice,
  type ObsidianImportNoticeInput,
} from "../../src/renderer/community/import-notice";

function summary(overrides: Partial<ObsidianImportNoticeInput> = {}): ObsidianImportNoticeInput {
  return { plugins: [], themes: [], enabled: [], activeTheme: null, skipped: [], ...overrides };
}

describe("formatObsidianImportNotice", () => {
  it("says nothing to import only when genuinely nothing happened", () => {
    expect(formatObsidianImportNotice(summary())).toBe(
      "Nothing to import — no new Obsidian plugins or themes found"
    );
  });

  it("does NOT say nothing-to-import when plugins were enabled but nothing was copied", () => {
    const notice = formatObsidianImportNotice(
      summary({ enabled: ["a", "b", "c"], activeTheme: "Minimal" })
    );
    expect(notice).not.toContain("Nothing");
    expect(notice).toContain("enabled 3 plugins");
    expect(notice).toContain('applied theme "Minimal"');
  });

  it("does NOT say nothing-to-import when only a theme was applied", () => {
    const notice = formatObsidianImportNotice(summary({ activeTheme: "Things" }));
    expect(notice).not.toContain("Nothing");
    expect(notice).toContain('applied theme "Things"');
  });

  it("reports copies, enables and the applied theme together", () => {
    const notice = formatObsidianImportNotice(
      summary({
        plugins: ["dataview"],
        themes: ["Minimal", "Things"],
        enabled: ["dataview"],
        activeTheme: "Minimal",
      })
    );
    expect(notice).toBe(
      'Obsidian import: imported 1 plugin and 2 themes, enabled 1 plugin, applied theme "Minimal"'
    );
  });

  it("surfaces the skipped count alongside what did happen", () => {
    const notice = formatObsidianImportNotice(
      summary({
        plugins: ["new-one"],
        skipped: [
          { kind: "plugin", name: "myplugin", reason: 'already present as "MyPlugin"' },
          { kind: "theme", name: "Minimal", reason: "already present" },
        ],
      })
    );
    expect(notice).toContain("imported 1 plugin");
    expect(notice).toContain("2 items skipped");
  });

  it("reports skipped items rather than a bare 'nothing found' when everything collided", () => {
    const notice = formatObsidianImportNotice(
      summary({
        skipped: [{ kind: "plugin", name: "myplugin", reason: 'already present as "MyPlugin"' }],
      })
    );
    expect(notice).toContain("1 item skipped");
    expect(notice).toContain("already present or unusable");
    expect(notice).not.toBe("Nothing to import — no new Obsidian plugins or themes found");
  });
});

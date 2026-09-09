import { describe, expect, it } from "vitest";
import { shouldIgnoreBaseReload } from "../../src/renderer/views/base-view";

/**
 * Regression coverage for a data-loss race found by
 * `tests/e2e/bases-kanban-interaction.spec.ts`, which flaked roughly 1 run in
 * 14 until this guard existed.
 *
 * A plugin-provided Bases view persists its own settings into the `.base` file
 * — the Kanban board writes column and card order on every drag — and each
 * write raises a `modify` event whose reload re-reads the file. Writing
 * truncates before it refills, so that reload can read zero bytes.
 *
 * Parsing `""` produces a definition with no views. `applyText` used to
 * "repair" that by synthesizing a default table view and switching to it,
 * which hid the plugin's board behind a table; and because the definition is
 * what the next persist writes back, the synthesized default would then
 * overwrite the user's real view configuration and every passthrough key.
 */
describe("shouldIgnoreBaseReload", () => {
  it("ignores an empty read when a definition with views is already loaded", () => {
    // The race: a read that observed a write in flight.
    expect(shouldIgnoreBaseReload("", 1)).toBe(true);
    expect(shouldIgnoreBaseReload("   \n\t\n ", 1)).toBe(true);
    expect(shouldIgnoreBaseReload("", 3)).toBe(true);
  });

  it("accepts an empty read on first load, where there is no definition to lose", () => {
    // A brand-new `.base` legitimately starts out empty and gets the default
    // table view. Only a read that would *replace* something is suspect.
    expect(shouldIgnoreBaseReload("", 0)).toBe(false);
    expect(shouldIgnoreBaseReload("   ", 0)).toBe(false);
  });

  it("never ignores a read with content, however malformed", () => {
    // Non-empty text is real information: a parse error surfaces as an error
    // message, which is recoverable, rather than being silently swallowed.
    expect(shouldIgnoreBaseReload("views:\n  - type: kanban-view\n    name: Kanban\n", 1)).toBe(false);
    expect(shouldIgnoreBaseReload("views:", 1)).toBe(false);
    expect(shouldIgnoreBaseReload("{{ not yaml", 1)).toBe(false);
    // A partial write that already has some bytes is still content, and the
    // next `modify` event corrects it.
    expect(shouldIgnoreBaseReload("filters: file.folder ==", 2)).toBe(false);
  });
});

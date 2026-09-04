/**
 * Pure notice text for the "import from an existing .obsidian/ vault" command.
 *
 * Kept separate from `app.ts` (and free of DOM/Electron imports) so the exact
 * wording is unit-testable — the notice previously read only the copied-file
 * counts, so a run that copied nothing but ENABLED three plugins and applied a
 * theme reported "Nothing to import", after having executed three plugins'
 * `onload()`. A notice must describe everything that happened, and may only
 * say "nothing" when nothing happened.
 */

/** The subset of an import summary the notice is built from. */
export interface ObsidianImportNoticeInput {
  /** Plugin ids newly copied into `.geode/plugins/`. */
  plugins: string[];
  /** Theme names newly copied into `.geode/themes/`. */
  themes: string[];
  /** Plugin ids this import actually switched on. */
  enabled: string[];
  /** Theme applied, or null if the current theme was left alone. */
  activeTheme: string | null;
  /** Items deliberately not imported (already present, malformed, …). */
  skipped: { kind: string; name: string; reason: string }[];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Build the user-facing notice. Returns a "nothing happened" line only when
 * nothing was copied, nothing was enabled, and no theme was applied — and even
 * then it says how many items were skipped, because a silent skip is exactly
 * how an import that quietly did the wrong thing stayed invisible.
 */
export function formatObsidianImportNotice(sum: ObsidianImportNoticeInput): string {
  const copied: string[] = [];
  if (sum.plugins.length) copied.push(plural(sum.plugins.length, "plugin"));
  if (sum.themes.length) copied.push(plural(sum.themes.length, "theme"));

  const actions: string[] = [];
  if (copied.length) actions.push(`imported ${copied.join(" and ")}`);
  if (sum.enabled.length) actions.push(`enabled ${plural(sum.enabled.length, "plugin")}`);
  if (sum.activeTheme) actions.push(`applied theme "${sum.activeTheme}"`);

  if (!actions.length) {
    return sum.skipped.length
      ? `Nothing imported from Obsidian — ${plural(sum.skipped.length, "item")} skipped (already present or unusable); see the console for details`
      : "Nothing to import — no new Obsidian plugins or themes found";
  }

  const skippedNote = sum.skipped.length ? ` (${plural(sum.skipped.length, "item")} skipped)` : "";
  return `Obsidian import: ${actions.join(", ")}${skippedNote}`;
}

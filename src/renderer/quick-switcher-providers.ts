/**
 * Plugin-contributed rows for the global quick switcher (Cmd/Ctrl+O).
 * Geode-specific: Obsidian has no equivalent, so plugins that also run on
 * Obsidian must feature-detect `typeof plugin.registerQuickSwitcherProvider === "function"`.
 */

/** One extra row a plugin adds to the quick switcher for the typed query. */
export interface QuickSwitcherPluginItem {
  title: string;
  subtitle?: string;
  /** Icon id understood by `setIcon` (Lucide names). */
  icon?: string;
  onChoose(evt: KeyboardEvent | MouseEvent): void;
}

/** A source of quick switcher rows. Called with the current (non-empty) query on every keystroke. */
export interface QuickSwitcherProvider {
  /** Optional label for diagnostics. */
  id?: string;
  /** Synchronous: return the rows to show for `query`. Throwing is safe (the provider is skipped). */
  getItems(query: string): QuickSwitcherPluginItem[];
}

/**
 * Gathers rows from every provider for a non-empty query. Providers that
 * throw, or return something other than an array, contribute nothing; rows
 * without a string title or an `onChoose` function are dropped.
 */
export function collectQuickSwitcherItems(
  providers: Iterable<QuickSwitcherProvider>,
  query: string,
): QuickSwitcherPluginItem[] {
  if (query.length === 0) return [];
  const out: QuickSwitcherPluginItem[] = [];
  for (const provider of providers) {
    let rows: unknown;
    try {
      rows = provider.getItems(query);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && typeof row.title === "string" && typeof row.onChoose === "function") out.push(row);
    }
  }
  return out;
}

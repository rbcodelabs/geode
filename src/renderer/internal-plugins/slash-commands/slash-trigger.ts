// Pure helpers for the Slash commands core plugin: trigger detection and
// ranking. Kept free of App/DOM imports so they can be unit tested in node.

export interface SlashTrigger {
  /** Offset of the `/` within the text passed to `findSlashTrigger`. */
  offset: number;
  /** Text typed after the `/`, never containing whitespace. */
  query: string;
}

/**
 * Detect an open slash menu at the end of `lineBefore` (the current line's
 * text up to the cursor). Per the spec the `/` must sit at the start of the
 * line or after whitespace, and whitespace after it cancels the menu.
 */
export function findSlashTrigger(lineBefore: string): SlashTrigger | null {
  const match = /(^|\s)\/(\S*)$/.exec(lineBefore);
  if (!match) return null;
  return { offset: match.index + match[1].length, query: match[2] };
}

export interface RankableCommand {
  name: string;
}

/**
 * Filter and order commands for `query` with the same fuzzy scorer as the
 * Command palette ("scf" matches "Save current file"). An empty query keeps
 * every command, alphabetically.
 */
export function rankSlashCommands<T extends RankableCommand>(
  commands: readonly T[],
  query: string,
  score: (query: string, text: string) => number | null
): T[] {
  const scored: Array<{ command: T; score: number }> = [];
  for (const command of commands) {
    const s = score(query, command.name);
    if (s !== null) scored.push({ command, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.map((entry) => entry.command);
}

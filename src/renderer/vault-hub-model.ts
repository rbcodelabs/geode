/**
 * Pure, DOM-free helpers for the Vault Hub (vault-hub.ts): naming, the
 * deterministic avatar, card ordering and keyboard navigation. Kept separate so
 * they can be unit tested in the node vitest environment.
 */

/** Muted mid-tones that keep white initials legible on both the light and dark picker surfaces. */
export const VAULT_AVATAR_COLORS: readonly string[] = [
  "#4d7a3a", // moss
  "#3a6a7a", // teal
  "#7a5a3a", // clay
  "#6a3a7a", // plum
  "#7a3a4d", // berry
  "#3a4d7a", // indigo
  "#6b6a2f", // olive
  "#2f6b5c", // jade
];

/** The folder name of a vault path (or the id itself for non-path ids such as `managed://default`). */
export function vaultNameFromPath(vaultPath: string): string {
  return vaultPath.split(/[\\/]/).filter(Boolean).pop() ?? vaultPath;
}

/** First letter or digit of the name, uppercased; `?` when there is none. Iterates code points so emoji/CJK are not split. */
export function vaultInitial(name: string): string {
  for (const char of Array.from(name.trim())) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toUpperCase();
  }
  return "?";
}

/** Same name, same color, on every run and every machine (FNV-1a over the lowercased name). */
export function vaultAvatarColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return VAULT_AVATAR_COLORS[hash % VAULT_AVATAR_COLORS.length];
}

/** The vault open in this window first, then the registry's recency order, without duplicates. */
export function orderVaultPaths(currentPath: string | null, recents: readonly string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...(currentPath ? [currentPath] : []), ...recents]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}

export type HubNavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

/**
 * Where arrow-key focus moves in a grid of `count` cards laid out `columns` wide
 * (row-major). Left/Right wrap nowhere: they stop at the ends, like a text field.
 * Up/Down keep the column and stop at the first/last row; a short last row is
 * handled by clamping to the final card.
 */
export function nextHubCardIndex(count: number, from: number, key: HubNavKey, columns: number): number {
  if (count <= 0) return -1;
  const cols = Math.max(1, columns);
  const last = count - 1;
  const current = Math.min(Math.max(from, 0), last);
  switch (key) {
    case "ArrowLeft": return Math.max(0, current - 1);
    case "ArrowRight": return Math.min(last, current + 1);
    case "ArrowUp": return current - cols >= 0 ? current - cols : current;
    case "ArrowDown": {
      if (current + cols <= last) return current + cols;
      // On a short last row, ArrowDown from a card in the row above lands on the final card.
      return Math.floor(current / cols) < Math.floor(last / cols) ? last : current;
    }
    case "Home": return 0;
    case "End": return last;
  }
}

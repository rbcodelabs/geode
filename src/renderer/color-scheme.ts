/**
 * Base color scheme: the user's setting ("dark" | "light" | "auto") versus the
 * resolved scheme the rest of the app sees (`body.theme-dark` / `theme-light`).
 * Only pure resolution and the small OS-appearance/fade helpers live here so
 * they stay unit-testable and shared between the vault picker and open vaults.
 */

export type ThemeSetting = "dark" | "light" | "auto";
export type ResolvedTheme = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Coerce a persisted `theme` value. Obsidian's own "system" is normalized to
 * the canonical "auto"; anything unrecognized falls back to `fallback`.
 */
export function normalizeThemeSetting(value: unknown, fallback: ThemeSetting): ThemeSetting {
  if (value === "dark" || value === "light" || value === "auto") return value;
  if (value === "system") return "auto";
  return fallback;
}

/** Resolve a setting to the concrete scheme; auto follows the OS. */
export function resolveTheme(setting: ThemeSetting | string, osPrefersDark: boolean): ResolvedTheme {
  if (setting === "auto" || setting === "system") return osPrefersDark ? "dark" : "light";
  return setting === "light" ? "light" : "dark";
}

/** Current OS preference; dark when matchMedia is unavailable (the app's historical default). */
export function osPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_QUERY).matches;
}

/** Run `apply`, cross-fading via a view transition unless the user prefers reduced motion. */
export function applyThemeWithFade(apply: () => void): void {
  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduceMotion) doc.startViewTransition(apply);
  else apply();
}

/**
 * Subscribe to OS light/dark changes. Returns a disposer; calling it more than
 * once is safe. Returns a no-op when matchMedia is unavailable.
 */
export function watchOsAppearance(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

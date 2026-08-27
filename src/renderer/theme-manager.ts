import type { App } from "./app";

const THEME_STYLE_ID = "geode-community-theme";

function themePath(name: string): string {
  return `.geode/themes/${name}/theme.css`;
}

/**
 * Loads Obsidian community themes. A theme is a `theme.css` (plus
 * `manifest.json`) under `<vault>/.geode/themes/<name>/`, exactly as
 * Obsidian stores them. Applying a theme injects its CSS after Geode's own
 * stylesheet so it overrides the default via the shared CSS-variable
 * contract (see styles/app.css). Selecting "" (default) removes it.
 *
 * Themes drive the look entirely through CSS custom properties + Geode's
 * Obsidian-compatible DOM classes; there is no theme JS (matching Obsidian).
 */
export class ThemeManager {
  private current = "";

  constructor(private app: App) {}

  /** Names of installed themes (subdirs of `.geode/themes/` with a theme.css). */
  async list(): Promise<string[]> {
    try {
      return await window.geode.listThemes();
    } catch {
      return [];
    }
  }

  get activeTheme(): string {
    return this.current;
  }

  /**
   * Apply a theme by name, or the built-in default when `name` is falsy.
   * Missing/unreadable themes fall back to the default rather than throwing.
   */
  async apply(name: string): Promise<void> {
    this.remove();
    this.current = "";
    if (!name) {
      this.app.syncWindowBackgroundColor();
      return;
    }
    let css: string;
    try {
      css = await window.geode.read(themePath(name));
    } catch (err) {
      console.error(`Failed to load theme "${name}"`, err);
      this.app.syncWindowBackgroundColor();
      return;
    }
    const styleEl = document.createElement("style");
    styleEl.id = THEME_STYLE_ID;
    styleEl.dataset.theme = name;
    styleEl.textContent = css;
    document.head.appendChild(styleEl); // after app.css → theme wins the cascade
    this.current = name;
    this.app.syncWindowBackgroundColor();
  }

  private remove(): void {
    document.getElementById(THEME_STYLE_ID)?.remove();
  }
}

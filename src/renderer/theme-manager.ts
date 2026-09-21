import type { App } from "./app";

const ACTIVE_THEME_STYLE_ID = "geode-active-theme";

/**
 * Loads app-owned built-in themes and Obsidian-compatible vault themes.
 * A vault theme with the same name overrides the built-in. Applying either
 * kind injects its CSS after Geode's own stylesheet so it overrides the
 * default via the shared CSS-variable
 * contract (see styles/app.css). Selecting "" (default) removes it.
 *
 * Themes drive the look entirely through CSS custom properties + Geode's
 * Obsidian-compatible DOM classes; there is no theme JS (matching Obsidian).
 */
export class ThemeManager {
  private current = "";

  constructor(private app: App) {}

  /** Names of built-in and installed vault themes. */
  async list(): Promise<string[]> {
    try {
      return await this.app.host.plugins.listThemes();
    } catch {
      return [];
    }
  }

  get activeTheme(): string {
    return this.current;
  }

  /**
   * Apply a theme by name, or the default Geode palette when `name` is falsy.
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
      css = await this.app.host.plugins.readThemeCss(name);
    } catch (err) {
      console.error(`Failed to load theme "${name}"`, err);
      this.app.syncWindowBackgroundColor();
      return;
    }
    const styleEl = document.createElement("style");
    styleEl.id = ACTIVE_THEME_STYLE_ID;
    styleEl.dataset.theme = name;
    styleEl.textContent = css;
    document.head.appendChild(styleEl); // after app.css → theme wins the cascade
    this.current = name;
    this.app.syncWindowBackgroundColor();
  }

  private remove(): void {
    document.getElementById(ACTIVE_THEME_STYLE_ID)?.remove();
  }
}

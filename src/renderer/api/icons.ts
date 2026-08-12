/**
 * Lucide icon support — the icon set Obsidian uses. Plugins reference icons
 * by kebab-case name (`message-square`, `layout-dashboard`, …) via
 * `setIcon`/`addRibbonIcon`/a view's `getIcon()`; Geode resolves those to
 * real Lucide SVGs so hosted-plugin (and Geode's own) icons render properly
 * instead of showing a placeholder or the raw name.
 */
import * as lucide from "lucide-static";

/** Custom SVGs registered by plugins via `addIcon(id, svg)`. */
const customIcons = new Map<string, string>();

export function addIcon(iconId: string, svgContent: string): void {
  customIcons.set(iconId, svgContent);
}

/** kebab/snake-case → PascalCase, matching lucide-static's export keys (e.g. `git-pull-request` → `GitPullRequest`). */
function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** The SVG markup for an icon id (custom first, then Lucide), or null if unknown. */
export function getIconSvg(iconId: string): string | null {
  const custom = customIcons.get(iconId);
  if (custom) return custom;
  const svg = (lucide as Record<string, unknown>)[toPascalCase(iconId)];
  return typeof svg === "string" ? svg : null;
}

/** True if `iconId` resolves to a known Lucide/custom icon (vs. an emoji or unknown string). */
export function hasIcon(iconId: string): boolean {
  return getIconSvg(iconId) !== null;
}

/**
 * Render an icon into `el` (Obsidian's `setIcon`). Known icon ids render as
 * an inline Lucide SVG; anything else (e.g. an emoji glyph Geode used before,
 * or an unknown id) falls back to text so it's still visible.
 */
export function setIcon(el: HTMLElement, iconId: string): void {
  const svg = getIconSvg(iconId);
  el.classList.add("geode-icon");
  el.setAttribute("data-icon", iconId);
  if (svg) {
    el.innerHTML = svg;
  } else {
    el.textContent = iconId;
  }
}

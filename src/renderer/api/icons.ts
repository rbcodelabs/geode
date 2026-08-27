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

/** True if `content` is already a complete `<svg ...>...</svg>` element (vs. a bare fragment like a lone `<path>`). */
function isCompleteSvg(content: string): boolean {
  return /^\s*<svg[\s>]/i.test(content);
}

/**
 * Register a custom icon (Obsidian's `addIcon`). Plugins commonly pass a
 * bare fragment (e.g. a single `<path>`) with no `<svg>` wrapper — valid in
 * an actual `<svg>` document context, but inert (renders zero pixels, no
 * error) when later injected via `innerHTML` into an arbitrary HTML element.
 * Normalize at registration time so `getIconSvg`'s contract — "returns
 * complete `<svg>` markup, or null" — is a string-level invariant callers
 * (and tests) can rely on, rather than a paint-time surprise. Content that's
 * already a full `<svg>` element passes through verbatim.
 */
export function addIcon(iconId: string, svgContent: string): void {
  const normalized = isCompleteSvg(svgContent)
    ? svgContent
    : `<svg viewBox="0 0 100 100" class="svg-icon ${iconId}">${svgContent}</svg>`;
  customIcons.set(iconId, normalized);
}

/** kebab/snake-case → PascalCase, matching lucide-static's export keys (e.g. `git-pull-request` → `GitPullRequest`). */
function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function lookupLucide(iconId: string): string | null {
  const svg = (lucide as Record<string, unknown>)[toPascalCase(iconId)];
  return typeof svg === "string" ? svg : null;
}

/** The SVG markup for an icon id (custom first, then Lucide), or null if unknown. */
export function getIconSvg(iconId: string): string | null {
  const custom = customIcons.get(iconId);
  if (custom) return custom;
  const direct = lookupLucide(iconId);
  if (direct) return direct;
  // Obsidian accepts both bare ("search") and "lucide-"-prefixed ids
  // ("lucide-search") for the same icon; retry with the prefix stripped
  // rather than rendering the literal id text.
  if (iconId.startsWith("lucide-")) return lookupLucide(iconId.slice("lucide-".length));
  return null;
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
    // Obsidian's icon hook: every rendered icon carries `.svg-icon` so
    // themes and plugin CSS can target it uniformly, whether the markup
    // came from Lucide (which classes itself `lucide lucide-<name>`) or a
    // plugin's own `addIcon` registration.
    el.querySelector("svg")?.classList.add("svg-icon");
  } else {
    // Obsidian renders nothing for an identifier-shaped id it doesn't
    // recognize (vs. showing the raw string), but still falls back to text
    // for a literal glyph like an emoji that was never meant to resolve.
    el.textContent = /^[A-Za-z0-9_-]+$/.test(iconId) ? "" : iconId;
  }
}

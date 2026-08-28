/**
 * Maps Geode's theme CSS custom properties onto Mermaid's `themeVariables`,
 * so diagrams follow the app's light/dark theme (and any community theme that
 * overrides those same variables) instead of shipping Mermaid's own palette.
 *
 * `buildMermaidConfig` is deliberately pure — it takes an already-read bag of
 * variable values, not an element — so the mapping is unit-testable without a
 * DOM. `readGeodeThemeVars` is the thin DOM-reading half.
 */

/** The Geode CSS custom properties Mermaid's palette is derived from. */
export interface GeodeThemeVars {
  backgroundPrimary: string;
  backgroundSecondary: string;
  textNormal: string;
  textMuted: string;
  interactiveAccent: string;
  textAccent: string;
  border: string;
  fontText: string;
  fontMonospace: string;
}

/** Fallbacks used when a variable is unset (e.g. a theme that drops one). */
const FALLBACKS: GeodeThemeVars = {
  backgroundPrimary: "#ffffff",
  backgroundSecondary: "#f5f5f5",
  textNormal: "#222222",
  textMuted: "#666666",
  interactiveAccent: "#5b6bd8",
  textAccent: "#5b6bd8",
  border: "#dddddd",
  fontText: "sans-serif",
  fontMonospace: "monospace",
};

/** Subset of Mermaid's config that Geode sets. Structural, so no mermaid import is needed. */
export interface MermaidThemeConfig {
  startOnLoad: false;
  securityLevel: "strict";
  suppressErrorRendering: true;
  theme: "base";
  darkMode: boolean;
  fontFamily: string;
  themeVariables: Record<string, string>;
}

/**
 * Build the Mermaid config for one render.
 *
 * `theme: "base"` (not `"dark"` / `"default"`) is the theme Mermaid documents
 * as the customization target: it recomputes every derived colour — node
 * fills, cluster backgrounds, sequence-diagram bands — from the primary /
 * background / line values supplied here. The prebuilt `dark` and `default`
 * themes derive theirs from their own hardcoded palettes and only accept
 * overrides for keys named explicitly, so Geode's accent colour would not
 * propagate. `darkMode` tells `base` which direction to shade derived colours.
 */
export function buildMermaidConfig(vars: Partial<GeodeThemeVars>, dark: boolean): MermaidThemeConfig {
  const v = resolveVars(vars);
  return {
    startOnLoad: false,
    // Diagram source comes from the user's own vault, but it is still
    // untrusted-ish input rendered as SVG; `strict` makes Mermaid sanitize
    // labels and refuse inline scripts. Internal-link nodes are wired by
    // Geode after render, so no `loose` security level is needed for them.
    securityLevel: "strict",
    // Geode renders its own inline error block; without this Mermaid also
    // injects a "Syntax error in text" SVG into document.body on failure.
    suppressErrorRendering: true,
    theme: "base",
    darkMode: dark,
    fontFamily: v.fontText,
    themeVariables: {
      darkMode: String(dark),
      background: v.backgroundPrimary,
      primaryColor: v.backgroundSecondary,
      primaryTextColor: v.textNormal,
      primaryBorderColor: v.border,
      secondaryColor: v.backgroundPrimary,
      secondaryTextColor: v.textNormal,
      secondaryBorderColor: v.border,
      tertiaryColor: v.backgroundSecondary,
      tertiaryTextColor: v.textMuted,
      tertiaryBorderColor: v.border,
      lineColor: v.textMuted,
      textColor: v.textNormal,
      mainBkg: v.backgroundSecondary,
      nodeBorder: v.interactiveAccent,
      nodeTextColor: v.textNormal,
      clusterBkg: v.backgroundPrimary,
      clusterBorder: v.border,
      titleColor: v.textNormal,
      edgeLabelBackground: v.backgroundPrimary,
      // Sequence diagrams read their own variable names rather than the
      // generic ones above.
      actorBkg: v.backgroundSecondary,
      actorBorder: v.interactiveAccent,
      actorTextColor: v.textNormal,
      actorLineColor: v.textMuted,
      signalColor: v.textNormal,
      signalTextColor: v.textNormal,
      labelBoxBkgColor: v.backgroundSecondary,
      labelBoxBorderColor: v.border,
      labelTextColor: v.textNormal,
      loopTextColor: v.textNormal,
      noteBkgColor: v.backgroundSecondary,
      noteTextColor: v.textNormal,
      noteBorderColor: v.border,
      // Link-styled nodes pick up the theme's accent so `internal-link`
      // classed nodes read as links.
      linkColor: v.textAccent,
      fontFamily: v.fontText,
      fontSize: "14px",
      // Mermaid uses this for `code` spans inside labels.
      classText: v.textNormal,
      altBackground: v.backgroundSecondary,
      monospaceFontFamily: v.fontMonospace,
    },
  };
}

function resolveVars(vars: Partial<GeodeThemeVars>): GeodeThemeVars {
  const out = { ...FALLBACKS };
  for (const key of Object.keys(FALLBACKS) as (keyof GeodeThemeVars)[]) {
    const value = vars[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** CSS custom property backing each `GeodeThemeVars` field. */
const CSS_VARS: Record<keyof GeodeThemeVars, string> = {
  backgroundPrimary: "--background-primary",
  backgroundSecondary: "--background-secondary",
  textNormal: "--text-normal",
  textMuted: "--text-muted",
  interactiveAccent: "--interactive-accent",
  textAccent: "--text-accent",
  border: "--background-modifier-border",
  fontText: "--font-text",
  fontMonospace: "--font-monospace",
};

/**
 * Read Geode's live theme variables off an element (defaults to `<body>`, the
 * element `App.applySettings` toggles `theme-dark` / `theme-light` on).
 */
export function readGeodeThemeVars(el: Element = document.body): Partial<GeodeThemeVars> {
  const style = getComputedStyle(el);
  const out: Partial<GeodeThemeVars> = {};
  for (const [key, cssVar] of Object.entries(CSS_VARS) as [keyof GeodeThemeVars, string][]) {
    out[key] = style.getPropertyValue(cssVar).trim();
  }
  return out;
}

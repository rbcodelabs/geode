import { describe, expect, it, vi } from "vitest";
import * as ObsidianApi from "../../src/renderer/api/obsidian";
import {
  isMermaidInfoString,
  MERMAID_LANG,
  parseFencedBlock,
} from "../../src/renderer/internal-plugins/mermaid/fence";
import {
  createMermaidLoader,
  loadMermaid,
  mermaidScriptUrl,
  type MermaidApi,
} from "../../src/renderer/internal-plugins/mermaid/load-mermaid";
import {
  buildMermaidConfig,
  type GeodeThemeVars,
} from "../../src/renderer/internal-plugins/mermaid/theme";

/**
 * Covers the pure half of Mermaid support: language detection, fence parsing,
 * the CSS-variable -> themeVariables mapping, and the lazy loader's
 * memoization contract. The DOM-bound half (render, SVG injection,
 * internal-link wiring) is covered end to end by tests/e2e/mermaid.spec.ts.
 */

const DARK_VARS: GeodeThemeVars = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#252525",
  textNormal: "#dadada",
  textMuted: "#999999",
  interactiveAccent: "#7b6cd9",
  textAccent: "#a496f0",
  border: "rgba(255, 255, 255, 0.09)",
  fontText: "Inter, sans-serif",
  fontMonospace: "SF Mono, monospace",
};

const LIGHT_VARS: GeodeThemeVars = {
  backgroundPrimary: "#ffffff",
  backgroundSecondary: "#f2f3f5",
  textNormal: "#222222",
  textMuted: "#5c5c5c",
  interactiveAccent: "#5b6bd8",
  textAccent: "#3b52c4",
  border: "rgba(0, 0, 0, 0.1)",
  fontText: "Inter, sans-serif",
  fontMonospace: "SF Mono, monospace",
};

/** A resolved MermaidApi stub; the loader only ever passes it through. */
function fakeMermaid(tag: string): MermaidApi {
  return {
    initialize: () => {},
    render: async () => ({ svg: `<svg data-tag="${tag}"></svg>` }),
  };
}

describe("mermaid language detection", () => {
  it("matches the bare mermaid info string, case-insensitively and with trailing metadata", () => {
    expect(isMermaidInfoString(MERMAID_LANG)).toBe(true);
    expect(isMermaidInfoString("  mermaid  ")).toBe(true);
    expect(isMermaidInfoString("Mermaid")).toBe(true);
    expect(isMermaidInfoString("mermaid {theme: dark}")).toBe(true);
    expect(isMermaidInfoString("mermaid title=Flow")).toBe(true);
  });

  it("does not match languages that merely start with 'mermaid', or unrelated ones", () => {
    // Edge case: a prefix match here would hijack every neighbouring language.
    expect(isMermaidInfoString("mermaidjs")).toBe(false);
    expect(isMermaidInfoString("mermaid-cli")).toBe(false);
    expect(isMermaidInfoString("js")).toBe(false);
    expect(isMermaidInfoString("base")).toBe(false);
    expect(isMermaidInfoString("")).toBe(false);
  });
});

describe("parseFencedBlock", () => {
  it("splits the info string from the body of a closed fence", () => {
    const parsed = parseFencedBlock("```mermaid\ngraph TD;\n  A-->B;\n```");
    expect(parsed).toEqual({ info: "mermaid", body: "graph TD;\n  A-->B;" });
  });

  it("handles a tilde fence, indentation, and a longer-than-three marker", () => {
    const parsed = parseFencedBlock("  ~~~~mermaid extra\n  body\n  ~~~~");
    expect(parsed).toEqual({ info: "mermaid extra", body: "  body" });
  });

  it("treats an unclosed fence as a body running to the end (block still being typed)", () => {
    // Edge case: CodeMirror hands Live Preview a FencedCode node the moment
    // the opening fence exists, long before the user types the closing one.
    const parsed = parseFencedBlock("```mermaid\ngraph TD;");
    expect(parsed).toEqual({ info: "mermaid", body: "graph TD;" });
  });

  it("returns null when the text does not open with a fence", () => {
    expect(parseFencedBlock("graph TD;\n  A-->B;")).toBeNull();
    expect(parseFencedBlock("")).toBeNull();
  });
});

describe("buildMermaidConfig", () => {
  it("maps dark-theme CSS variables onto mermaid themeVariables", () => {
    const config = buildMermaidConfig(DARK_VARS, true);

    expect(config.theme).toBe("base");
    expect(config.darkMode).toBe(true);
    expect(config.startOnLoad).toBe(false);
    // Geode renders its own inline error block, so mermaid must not inject one.
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.securityLevel).toBe("strict");

    expect(config.themeVariables.darkMode).toBe("true");
    expect(config.themeVariables.background).toBe(DARK_VARS.backgroundPrimary);
    expect(config.themeVariables.mainBkg).toBe(DARK_VARS.backgroundSecondary);
    expect(config.themeVariables.textColor).toBe(DARK_VARS.textNormal);
    expect(config.themeVariables.lineColor).toBe(DARK_VARS.textMuted);
    expect(config.themeVariables.nodeBorder).toBe(DARK_VARS.interactiveAccent);
    expect(config.themeVariables.linkColor).toBe(DARK_VARS.textAccent);
    expect(config.themeVariables.clusterBorder).toBe(DARK_VARS.border);
    expect(config.themeVariables.fontFamily).toBe(DARK_VARS.fontText);
    expect(config.themeVariables.monospaceFontFamily).toBe(DARK_VARS.fontMonospace);
    // Sequence diagrams read their own variable names, not the generic ones.
    expect(config.themeVariables.actorBkg).toBe(DARK_VARS.backgroundSecondary);
    expect(config.themeVariables.actorTextColor).toBe(DARK_VARS.textNormal);
  });

  it("maps light-theme CSS variables and flips only the theme-dependent values", () => {
    const dark = buildMermaidConfig(DARK_VARS, true);
    const light = buildMermaidConfig(LIGHT_VARS, false);

    expect(light.darkMode).toBe(false);
    expect(light.themeVariables.darkMode).toBe("false");
    expect(light.themeVariables.background).toBe(LIGHT_VARS.backgroundPrimary);
    expect(light.themeVariables.textColor).toBe(LIGHT_VARS.textNormal);
    expect(light.themeVariables.background).not.toBe(dark.themeVariables.background);
    expect(light.themeVariables.textColor).not.toBe(dark.themeVariables.textColor);
    // The font family is theme-independent, so it must survive the flip.
    expect(light.themeVariables.fontFamily).toBe(dark.themeVariables.fontFamily);
  });

  it("falls back to legible defaults for variables a theme leaves unset or blank", () => {
    // Edge case: a community theme that drops --text-accent must not produce
    // `themeVariables: { linkColor: "" }`, which mermaid renders as black.
    const config = buildMermaidConfig({ textNormal: "#111111", textAccent: "   " }, false);

    expect(config.themeVariables.textColor).toBe("#111111");
    expect(config.themeVariables.linkColor).toBe("#5b6bd8");
    expect(config.themeVariables.background).toBe("#ffffff");
    for (const value of Object.values(config.themeVariables)) {
      expect(value).not.toBe("");
    }
  });
});

describe("createMermaidLoader", () => {
  it("injects once and shares that promise with concurrent callers", async () => {
    const api = fakeMermaid("shared");
    const load = vi.fn(async () => api);
    const loadMermaid = createMermaidLoader(load);

    const [a, b, c] = await Promise.all([loadMermaid(), loadMermaid(), loadMermaid()]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(api);
    expect(b).toBe(api);
    expect(c).toBe(api);
  });

  it("reuses the resolved library on later calls without re-injecting", async () => {
    const load = vi.fn(async () => fakeMermaid("cached"));
    const loadMermaid = createMermaidLoader(load);

    const first = await loadMermaid();
    const second = await loadMermaid();

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("clears the memo on failure so a later block can retry", async () => {
    // Edge case: without this, one transient script-load failure would
    // poison every diagram for the rest of the session.
    const api = fakeMermaid("retry");
    const load = vi
      .fn<() => Promise<MermaidApi>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(api);
    const loadMermaid = createMermaidLoader(load);

    await expect(loadMermaid()).rejects.toThrow("network down");
    await expect(loadMermaid()).resolves.toBe(api);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects every concurrent caller of a failed load, then retries once", async () => {
    const api = fakeMermaid("after-failure");
    const load = vi
      .fn<() => Promise<MermaidApi>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(api);
    const loadMermaid = createMermaidLoader(load);

    const results = await Promise.allSettled([loadMermaid(), loadMermaid()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(load).toHaveBeenCalledTimes(1);

    await expect(loadMermaid()).resolves.toBe(api);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("Obsidian loadMermaid contract", () => {
  it("is exported by the compatibility module used by require('obsidian')", () => {
    // Parity ledger DEV-45053118ab68 / API-875834c93581: Obsidian's
    // `loadMermaid(): Promise<any>` must be reachable by plugins, not just
    // used internally.
    expect(ObsidianApi.loadMermaid).toBeTypeOf("function");
    expect(ObsidianApi.loadMermaid.length).toBe(0);
  });

  it("hands plugins the same memoized instance Geode renders with", () => {
    // A second copy would mean a plugin's mermaid.initialize() silently
    // failed to affect Geode's diagrams (and vice versa).
    expect(ObsidianApi.loadMermaid).toBe(loadMermaid);
  });
});

describe("mermaidScriptUrl", () => {
  it("derives the chunk URL from however the renderer bundle was loaded", () => {
    const doc = {
      querySelector: () => ({ getAttribute: () => "../../dist/renderer.js" }),
    } as unknown as Document;
    expect(mermaidScriptUrl(doc)).toBe("../../dist/mermaid.js");
  });

  it("falls back to the dev-checkout path when no renderer script tag is found", () => {
    const doc = { querySelector: () => null } as unknown as Document;
    expect(mermaidScriptUrl(doc)).toBe("../../dist/mermaid.js");
  });
});

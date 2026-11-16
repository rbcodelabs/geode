/**
 * Shared responsive viewport presets and origin helpers used by both Artifact
 * Preview (`ArtifactView`) and Web Viewer (`WebView`).
 *
 * Pure browser/renderer module: zero Electron, Node, or `src/main/*` imports so
 * it stays safe across the mobile platform boundary (`esbuild.config.mjs`).
 */

export type ViewportPreset = "desktop" | "tablet" | "mobile" | "custom" | "fill";

export interface Viewport {
  preset: ViewportPreset;
  width: number;
  height: number;
}

export const VIEWPORT_PRESET_ORDER = ["fill", "desktop", "tablet", "mobile"] as const;

export const VIEWPORTS: Record<Exclude<ViewportPreset, "custom">, Viewport> = {
  // Width/height are fallbacks for status text; a fill frame sizes to the pane.
  fill: { preset: "fill", width: 1440, height: 900 },
  desktop: { preset: "desktop", width: 1440, height: 900 },
  tablet: { preset: "tablet", width: 768, height: 1024 },
  mobile: { preset: "mobile", width: 390, height: 844 },
};

export const VIEWPORT_CONTROLS: Record<Exclude<ViewportPreset, "custom">, { icon: string; label: string }> = {
  fill: { icon: "maximize-2", label: "Fill pane" },
  desktop: { icon: "monitor", label: "Desktop" },
  tablet: { icon: "tablet", label: "Tablet" },
  mobile: { icon: "smartphone", label: "Mobile" },
};

const MIN_CUSTOM_DIMENSION = 100;
const MAX_CUSTOM_DIMENSION = 10_000;

/**
 * Validates a persisted `Viewport` object (e.g. from workspace layout state),
 * returning canonical preset dimensions or `VIEWPORTS.fill` when invalid/absent.
 */
export function normalizeViewport(raw: unknown): Viewport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...VIEWPORTS.fill };
  const candidate = raw as { preset?: unknown; width?: unknown; height?: unknown };
  const preset = candidate.preset;
  if (preset === "fill" || preset === "desktop" || preset === "tablet" || preset === "mobile") {
    return { ...VIEWPORTS[preset] };
  }
  if (preset === "custom") {
    const width = candidate.width;
    const height = candidate.height;
    if (
      typeof width === "number" &&
      typeof height === "number" &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width >= MIN_CUSTOM_DIMENSION &&
      width <= MAX_CUSTOM_DIMENSION &&
      height >= MIN_CUSTOM_DIMENSION &&
      height <= MAX_CUSTOM_DIMENSION
    ) {
      return { preset: "custom", width: Math.round(width), height: Math.round(height) };
    }
  }
  return { ...VIEWPORTS.fill };
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * True iff `originOrUrl` resolves to a loopback HTTP(S) origin (`localhost`,
 * `127.0.0.1`, `[::1]`, `::1`) or is one of those exact bare loopback hostnames.
 */
export function isLoopbackOrigin(originOrUrl: string): boolean {
  if (typeof originOrUrl !== "string") return false;
  const trimmed = originOrUrl.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

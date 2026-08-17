/**
 * Pure helpers backing Geode's global external-link click interceptor
 * (wired up in `App`), which stops a plugin-rendered `<a href="https://…">`
 * from navigating the whole renderer window and instead routes it through the
 * Web Viewer or the OS browser.
 *
 * These helpers are deliberately free of any live-DOM dependency so they can
 * be unit-tested in a plain Node (vitest) environment. `anchorSnapshot()`
 * is the only DOM-facing function; it just extracts primitives from an
 * anchor before the decision is made by the pure functions below.
 */

/**
 * Anchor classes that already have their own dedicated click handling and so
 * must NOT be intercepted a second time by the global handler:
 * - `cm-live-extlink` / `cm-live-wikilink` — Live Preview (live-preview.ts).
 * - `internal-link` / `tag` — rendered Markdown (markdown/render.ts).
 */
const HANDLED_ANCHOR_CLASSES = ["cm-live-extlink", "cm-live-wikilink", "internal-link", "tag"];

/**
 * True when `href` points somewhere the app must open externally rather than
 * navigate to in-place: http(s) web links and `mailto:` addresses. Everything
 * else (internal `app://`/`file://` resolutions, relative paths, bare hashes)
 * is treated as not-external.
 */
export function isExternalHref(href: string | null | undefined): boolean {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href.trim());
}

export interface LocalFileTarget {
  path: string;
  line?: number;
  column?: number;
}

/** Parse a local absolute path or local file: URL, separating :line[:column]. */
export function parseLocalFileHref(href: string | null | undefined): LocalFileTarget | null {
  if (!href) return null;
  let value = href.trim();
  if (!value || value.includes("\0")) return null;

  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:" || url.hostname || url.search || url.hash) return null;
      value = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (!value.startsWith("/")) {
    return null;
  }

  const suffix = value.match(/:(\d+)(?::(\d+))?$/);
  const line = suffix ? Number(suffix[1]) : undefined;
  const column = suffix?.[2] ? Number(suffix[2]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  const filePath = suffix ? value.slice(0, suffix.index) : value;
  if (!filePath.startsWith("/") || filePath === "/") return null;
  return { path: filePath, line, column };
}

/** Primitive view of a clicked anchor, extracted from the DOM by `anchorSnapshot`. */
export interface AnchorSnapshot {
  /** The href attribute as authored (e.g. "https://x.com", "#top", "note.md"). */
  rawHref: string | null;
  /** The browser-resolved absolute href (anchor.href), or null when absent. */
  resolvedHref: string | null;
  /** CSS classes on the anchor. */
  classes: string[];
  /** Whether the anchor carries a `data-href` (marks Geode-internal links/tags/embeds). */
  hasDataHref: boolean;
}

/**
 * Decide whether the global handler should intercept this anchor click and
 * route it externally. Returns false for anchors already handled elsewhere
 * (by class or `data-href`), for same-document `#` hashes and empty hrefs,
 * and for non-external targets (relative paths, `app://`/`file://`).
 */
export function shouldInterceptAnchor(a: AnchorSnapshot): boolean {
  // Anchors owned by a more specific handler, or Geode-internal links.
  if (a.classes.some((c) => HANDLED_ANCHOR_CLASSES.includes(c))) return false;
  if (a.hasDataHref) return false;

  const raw = (a.rawHref ?? "").trim();
  // Same-document / empty / bare-hash anchors: leave to default behavior.
  if (raw === "" || raw.startsWith("#")) return false;

  // Prefer the resolved absolute href (marked emits absolute URLs), but fall
  // back to the raw value so an unresolved/edge anchor is still classified.
  return (
    isExternalHref(a.resolvedHref) ||
    isExternalHref(raw) ||
    parseLocalFileHref(raw) !== null ||
    parseLocalFileHref(a.resolvedHref) !== null ||
    raw.startsWith("/") ||
    /^file:/i.test(a.resolvedHref ?? "") ||
    /^(?:javascript|data|vbscript):/i.test(raw)
  );
}

/** Extract the primitives `shouldInterceptAnchor` needs from a live anchor element. */
export function anchorSnapshot(a: HTMLAnchorElement): AnchorSnapshot {
  return {
    rawHref: a.getAttribute("href"),
    resolvedHref: a.href || null,
    classes: Array.from(a.classList),
    hasDataHref: a.hasAttribute("data-href"),
  };
}

/**
 * Portable markdown-syntax and index constants.
 *
 * These values describe the *file format* — comment and math delimiters, the
 * YAML frontmatter fence, and the body-scan cap the parser honours. None of
 * them depend on a renderer, a host, Electron or the DOM, so they belong to
 * the portable engine rather than to whichever desktop module happened to
 * declare them first.
 *
 * Splitting them out is what lets `src/wiki/*` stop importing
 * `src/indexer/metadata-indexer.ts`: the parser only ever wanted the scan-cap
 * number, not the indexer's snapshot/reconcile machinery. The desktop modules
 * that used to own these re-export from here, so every existing import site
 * keeps working and there is exactly one definition of each value.
 *
 * See `docs/design/headless-phase0.md` — the extraction dependency map records
 * "Parser imports only scan-cap constant; split constants/index contracts
 * before publishing a package" as the remediation this module performs.
 */

/** Obsidian-flavored markdown comment delimiter: `%%commented out%%`. */
export const COMMENT_DELIMITER = "%%";

/**
 * Display-math delimiter. Owned here because it is masked by the same
 * delimiter-context machinery as comments — the two are always handled as a
 * pair, so keeping them apart invites them to drift.
 */
export const MATH_BLOCK_DELIMITER = "$$";

/** The delimiters that participate in plain/non-plain context masking. */
export type MaskedDelimiter = typeof COMMENT_DELIMITER | typeof MATH_BLOCK_DELIMITER;

/**
 * A complete `%%...%%` comment span, including its delimiters.
 *
 * Global, so a fresh instance is handed out on every call — a shared global
 * regex would carry `lastIndex` between callers and silently skip matches.
 *
 * This is the blunt textual form, used where a full parse is not warranted
 * (e.g. building an inert hover excerpt). Callers that must respect code
 * spans, fences and frontmatter use `commentRanges` in
 * `src/renderer/comments/model.ts` instead.
 */
export const commentSpanPattern = (): RegExp => /%%[\s\S]*?%%/g;

/** YAML frontmatter fence. */
export const FRONTMATTER_FENCE = "---";

/**
 * A complete leading YAML frontmatter block, capturing the raw YAML body in
 * group 1. Requires a non-empty body and tolerates both LF and CRLF, and
 * accepts a closing fence terminated by end-of-file.
 *
 * Deliberately not global or sticky, so a single shared instance carries no
 * `lastIndex` state between callers.
 */
export const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * As `FRONTMATTER_BLOCK_RE`, but also matching an *empty* frontmatter block
 * (`---\n---`), in which case group 1 is `undefined`.
 *
 * Read-side parsing deliberately treats an empty block as absent, so it uses
 * the stricter pattern above. Rewrite-side callers need to recognise the empty
 * block in order to replace it rather than prepend a second one — that is the
 * only reason the two differ.
 */
export const FRONTMATTER_BLOCK_OPTIONAL_BODY_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(\r?\n|$)/;

/** Just the opening fence, for callers that classify before they parse. */
export const FRONTMATTER_OPEN_RE = /^---\r?\n/;

/**
 * Default cap on how much of a note's body is scanned for metadata.
 *
 * User-configurable per vault (Settings -> Advanced -> "Metadata scan size
 * limit", persisted at `.geode/app.json` as `metadataScanCapBytes`) — this
 * constant is only the fallback for callers that don't pass an explicit
 * value, and the value `resolveMetadataScanCapBytes` returns when the saved
 * setting is missing or invalid.
 */
export const DEFAULT_METADATA_SCAN_CAP_BYTES = 300_000;

/**
 * Floor for the configurable cap: intentionally low enough to place no
 * real-world restriction on how aggressively a user can shrink it, while
 * still ruling out 0/negative — which would skip the body scan on every
 * non-empty note, including tiny ones, defeating the setting's purpose.
 */
export const MIN_METADATA_SCAN_CAP_BYTES = 1_000; // 1 KB

/**
 * Ceiling for the configurable cap. Generous enough that setting it here
 * effectively disables the cap for any realistic Markdown note (the OOM-
 * triggering files that motivated this were 1.6MB, ~5x smaller) while still
 * bounding pathological input (e.g. a corrupted config or
 * `Number.MAX_SAFE_INTEGER`).
 */
export const MAX_METADATA_SCAN_CAP_BYTES = 1_000_000_000; // ~1GB / 1,000,000 KB

/**
 * Coerce a raw, possibly missing/invalid persisted value into a valid scan
 * cap: non-finite/non-numeric input falls back to the default, and any
 * numeric input is clamped to `[MIN_METADATA_SCAN_CAP_BYTES,
 * MAX_METADATA_SCAN_CAP_BYTES]`. Pure and side-effect free so the renderer
 * (validating the Settings input), the main process (reading the setting off
 * disk) and the portable engine all share one definition of "valid".
 */
export function resolveMetadataScanCapBytes(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_METADATA_SCAN_CAP_BYTES;
  return Math.max(MIN_METADATA_SCAN_CAP_BYTES, Math.min(n, MAX_METADATA_SCAN_CAP_BYTES));
}

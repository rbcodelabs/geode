/**
 * The headless wiki SDK — the engine's one supported entry point.
 *
 * Everything under `src/wiki/` up to now has been foundation with no caller.
 * This module is the narrow, deliberately-chosen surface a consumer outside the
 * repo's own proof scripts is allowed to depend on. It is a *narrowing*, not a
 * re-export of the directory: the parser regexes, the candidate-selection
 * pipeline, the adapter filesystem seams, the desktop scan-cap setting and the
 * raw snapshot constructor all stay internal. See
 * `docs/design/headless-wiki-sdk.md` for the full public/not-public ledger and
 * the reasoning behind each exclusion, and
 * [ADR 0023](../../docs/adr/0023-wiki-sdk-session-semantics.md) for the session
 * semantics below.
 *
 * ## Session semantics, in one paragraph
 *
 * `openWikiSession` hands back a **session**, never a snapshot. Every read is
 * served from the provider's current view at the moment you call it, so a write
 * made through this session is visible to the very next read — no refresh, no
 * re-open. A snapshot handle is deliberately not obtainable through this
 * surface, because holding one across a write is precisely the stale-read bug
 * this decision exists to make unrepresentable.
 *
 * What that does *not* promise: a sequence of reads is not a transaction. Each
 * individual read is answered from one frozen, internally consistent view, but
 * an interleaved `await`ed write between two reads will be visible to the
 * second. Nothing outside this process is observed at all until `refresh()`.
 */

import {
  openLocalWikiProvider,
  type RefreshError,
  type WriteResult,
  type WriteStatus,
} from "./folder-provider";
import type { CaptureError } from "./local-filesystem";
import { DEFAULT_SNAPSHOT_LIMITS, type SnapshotLimits } from "./snapshot";
import type {
  CapturedNote,
  Diagnostic,
  GraphResult,
  ParserCoverage,
  ReadNoteResult,
  Resolution,
  ResolvedReference,
  SearchResult,
  SubpathResult,
} from "./snapshot";

/* ------------------------------------------------------------------ types */

/**
 * The metadata vocabulary. This is the shape of `readNote(...).note.metadata`,
 * so it is public by necessity rather than by choice — a consumer cannot use
 * `readNote` without it.
 */
export type {
  CachedMetadata,
  FootnoteRefCache,
  HeadingCache,
  LinkCache,
  ListItemCache,
  Loc,
  Pos,
  ReferenceLinkCache,
  SectionCache,
  TagCache,
} from "./types";

/**
 * Query and write result vocabulary, re-exported unchanged. These are already
 * the shapes the engine answers with; renaming them at the boundary would put a
 * second name on one contract for no gain.
 */
export type {
  Diagnostic,
  GraphResult,
  ParserCoverage,
  ReadNoteResult,
  Resolution,
  ResolvedReference,
  SearchResult,
  SubpathResult,
} from "./snapshot";
export type { WriteResult, WriteStatus, RefreshError } from "./folder-provider";
export type { CaptureError } from "./local-filesystem";

/**
 * One parsed note. Aliased from the internal `CapturedNote`: "captured" is
 * capture-pipeline vocabulary, and the capture pipeline is not part of this
 * surface.
 */
export type WikiNote = CapturedNote;

/**
 * Capture limits. Aliased from the internal `SnapshotLimits` for the same
 * reason `WikiNote` is aliased — "snapshot" is a word this surface deliberately
 * does not use, and leaving it in an option type would reintroduce the concept
 * through the back door.
 */
export type WikiLimits = SnapshotLimits;

/** The default capture limits, exposed so a caller can derive from them. */
export const DEFAULT_WIKI_LIMITS: Readonly<WikiLimits> = DEFAULT_SNAPSHOT_LIMITS;

/**
 * One entry in the vault listing.
 *
 * Declared here rather than re-exported from the internal `CapturedFile`, which
 * carries an optional `text` and is documented in `snapshot.ts` as "internal
 * capture boundary, not a supported public SDK". `listFiles` never returns
 * note bodies — `readNote` does — so the public type says so.
 */
export interface WikiFileEntry {
  readonly path: string;
  readonly kind: "note" | "attachment";
}

/**
 * What the engine knows about its own coverage.
 *
 * Declared structurally rather than inferred from the snapshot, so that a drift
 * in the internal `info` object is a compile error here instead of a silent
 * change to the public contract.
 */
export interface WikiSessionInfo {
  /** Always `"scan"`: this view came from a folder walk, not a transaction. */
  readonly consistency: "scan";
  readonly scanStartedAt: string;
  readonly scanEndedAt: string;
  /** False when a limit cut the walk short — absence is then not provable. */
  readonly discoveryComplete: boolean;
  /** False when a discovered note's bytes could not be read. */
  readonly noteContentComplete: boolean;
  /** False when alias indexing cannot be trusted to be exhaustive. */
  readonly aliasCoverageComplete: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly limits: WikiLimits;
  readonly exclusionPolicy: readonly string[];
  readonly referenceSyntax: "wikilinks";
  readonly parserLimitations: readonly string[];
  readonly parserBodyCapCodeUnits: number;
}

export interface OpenWikiSessionOptions {
  /** Override any subset of the capture limits. */
  readonly limits?: Partial<WikiLimits>;
}

export type RefreshResult =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly error: RefreshError };

/**
 * A live, write-capable view of one local folder.
 *
 * Every read method answers from the current view at call time. There is no
 * method that hands out the view itself; see the module comment.
 */
export interface WikiSession {
  /** Coverage and provenance of the current view. */
  info(): WikiSessionInfo;
  /** Every note and attachment the walk retained, in sorted path order. */
  listFiles(): readonly WikiFileEntry[];
  /** One note's text, metadata, diagnostics and per-note parser coverage. */
  readNote(path: string): ReadNoteResult;
  /** Bounded, ASCII-folded literal scan over note bodies. */
  search(query: string, limit?: number): SearchResult;
  /** Resolve a wikilink target as written in `fromPath`, under strict policy. */
  resolveLink(fromPath: string, target: string): Resolution;
  /** References this note makes, each with its own resolution. */
  outgoingLinks(path: string): GraphResult;
  /** References other notes make that resolve to this one. */
  backlinks(path: string): GraphResult;
  createNote(path: string, text: string): Promise<WriteResult>;
  updateNote(path: string, text: string): Promise<WriteResult>;
  deleteNote(path: string): Promise<WriteResult>;
  /**
   * Re-read the folder from disk. The only way to observe a change made
   * outside this session.
   */
  refresh(): Promise<RefreshResult>;
}

export type OpenWikiSessionResult =
  | { readonly status: "ok"; readonly session: WikiSession }
  | { readonly status: "error"; readonly error: CaptureError };

/* ----------------------------------------------------------------- opener */

/**
 * Open a trusted local folder as a wiki session.
 *
 * Boundary, restated because it is load-bearing and inherited unchanged from
 * ADR 0019/0020: portable Node pathname APIs are not an OS sandbox against a
 * hostile *process*. This validates paths, refuses to follow symlinks, and
 * re-verifies containment immediately before each write, which defends a
 * trusted folder against malformed input and ordinary races. It does not defend
 * against an adversary racing the filesystem with equal privilege.
 */
export async function openWikiSession(
  rootPath: string,
  options: OpenWikiSessionOptions = {},
): Promise<OpenWikiSessionResult> {
  // Only `limits` is forwarded. The provider also accepts a filesystem seam and
  // two adapter sinks; all three are internal (see the exclusion ledger in
  // `docs/design/headless-wiki-sdk.md`) and must not become reachable by
  // spreading an untrusted options object through to it.
  const opened = await openLocalWikiProvider(rootPath, { limits: options.limits });
  if (opened.status === "error") return { status: "error", error: opened.error };
  const provider = opened.provider;

  // Each read dereferences the live view here, at call time. This single
  // indirection is the whole read-after-write guarantee: `provider.snapshot()`
  // returns whatever view the last applied write rebuilt, so there is no
  // captured handle that can go stale.
  const session: WikiSession = {
    info: () => provider.snapshot().info,
    listFiles: () => provider.snapshot().listFiles(),
    readNote: (path) => provider.snapshot().readNote(path),
    search: (query, limit) => provider.snapshot().search(query, limit),
    resolveLink: (fromPath, target) => provider.snapshot().resolve(fromPath, target),
    outgoingLinks: (path) => provider.snapshot().outgoing(path),
    backlinks: (path) => provider.snapshot().backlinks(path),
    createNote: (path, text) => provider.create(path, text),
    updateNote: (path, text) => provider.update(path, text),
    deleteNote: (path) => provider.delete(path),
    refresh: () => provider.refresh(),
  };
  return { status: "ok", session };
}

import type { CachedMetadata } from "./types";

/**
 * The engine's outbound contracts.
 *
 * These are deliberately tiny. `docs/design/headless-phase0.md`'s extraction
 * dependency map records the failure mode they exist to avoid: the desktop
 * host interface mixes storage vocabulary with windows, plugins and runtime
 * capabilities, and its remediation is stated as "narrow engine contracts must
 * not inherit the whole host interface".
 *
 * So nothing here extends a host type, and nothing here is a place to grow
 * one. An adapter supplies these; the engine never reaches past them. The
 * precedent is `WikiFileSystem` in `./local-filesystem`, whose narrowness is
 * exactly what makes deterministic race testing possible.
 */

/** One note's parsed state, as handed to an index. */
export interface IndexedNote {
  readonly text: string;
  readonly metadata: CachedMetadata;
}

/**
 * Somewhere to record note state. Two methods, both about one note at one
 * path. No querying — a caller that needs to read its own index owns that
 * side itself, which keeps this contract implementable by something as small
 * as a `Map`.
 */
export interface WikiIndexSink {
  upsert(path: string, note: IndexedNote): void;
  remove(path: string): void;
}

/** What actually happened to one note. */
export type WikiChangeEvent =
  | { readonly type: "created"; readonly path: string }
  | { readonly type: "updated"; readonly path: string }
  | { readonly type: "deleted"; readonly path: string };

/**
 * Somewhere to announce a change. One method, fire-and-forget.
 *
 * Emission is synchronous and happens only after the write has been durably
 * applied and the in-memory view rebuilt, so a subscriber that immediately
 * queries the provider observes the change it was just told about. A throwing
 * subscriber must not corrupt provider state — the provider isolates it.
 */
export interface WikiEventSink {
  emit(event: WikiChangeEvent): void;
}

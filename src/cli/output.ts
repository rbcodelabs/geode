/**
 * The CLI's formatting layer. No engine logic lives here, and none may.
 *
 * Everything in this module turns a result the SDK already produced into
 * bytes on a stream and a number for `exit()`. It never decides *what* an
 * answer is — only how it is written down. The one rule it enforces is the
 * reason the CLI exists at all:
 *
 * > **A named status is never flattened into prose.**
 *
 * The engine answers with `already-exists`, `portability-collision`,
 * `oversize`, `ambiguous`, `conflict`, `byte-length-mismatch` and about fifty
 * more. That vocabulary is the product. A formatter that renders all of them as
 * `Error: could not create note` destroys the only thing that makes this
 * surface worth calling from a script, so `--json` carries the status verbatim
 * and the human rendering prints it verbatim too.
 */

/* -------------------------------------------------------------- exit codes */

/**
 * Four outcomes, distinguishable without reading stdout.
 *
 * The line between `refused` and `usage` is where the failure was decided:
 * `usage` means the CLI could not turn argv into an operation and the engine
 * was never called, so there is no engine status to report. Everything the
 * engine named is `refused`, including names a shell might think of as
 * "not found" — `absent`, `missing`, `ambiguous`. `unavailable` is reserved for
 * the two cases where the thing being asked about could not be reached at all.
 */
export const EXIT = {
  /** The operation completed and the engine's status is `ok`. */
  ok: 0,
  /** The engine answered with a named non-`ok` status. The name is in the payload. */
  refused: 1,
  /** argv could not be turned into an operation. The engine was never called. */
  usage: 2,
  /** The vault folder or the catalog store could not be reached. */
  unavailable: 3,
} as const;

export type ExitName = keyof typeof EXIT;

/**
 * Statuses that mean "the thing itself was unreachable" rather than "the engine
 * considered your request and said no".
 *
 * Kept as an explicit set rather than a heuristic on the status string, so
 * adding a status to the contract cannot silently change an exit code.
 */
const UNAVAILABLE = new Set(["vault-unavailable", "unavailable", "store-failed"]);

/**
 * The affirmative statuses — the whole vocabulary has exactly two.
 *
 * `resolved` is here because a resolution's success is not spelled `ok`:
 * `Resolution.status` answers `resolved | ambiguous | missing | invalid |
 * external | unavailable`, and only the first is an answer the caller asked
 * for. Keying on the literal string `"ok"` alone would have exited 1 on every
 * successful `resolve` — which the proof caught.
 *
 * Everything else, including `ambiguous` and `missing`, is a non-answer the
 * caller has to do something about, so it exits 1 with its name intact.
 */
const AFFIRMATIVE = new Set(["ok", "resolved"]);

export function exitNameFor(status: string): ExitName {
  if (AFFIRMATIVE.has(status)) return "ok";
  return UNAVAILABLE.has(status) ? "unavailable" : "refused";
}

/* ---------------------------------------------------------------- envelope */

/** Coverage travels beside every vault answer, so "not found" is separable from "not looked at". */
export interface CoverageBlock {
  readonly discoveryComplete: boolean;
  readonly noteContentComplete: boolean;
  readonly aliasCoverageComplete: boolean;
  readonly diagnostics: readonly { code: string; path?: string; paths?: string[] }[];
}

/**
 * The `--json` payload. One shape for every command, success and refusal
 * alike, so a caller writes one parser rather than eleven.
 */
export interface CliEnvelope {
  readonly tool: "geode-wiki";
  /** Bumped only if this envelope's shape changes incompatibly. */
  readonly schemaVersion: 1;
  /** The subcommand, or `null` when argv never named a valid one. */
  readonly command: string | null;
  /** The engine's own status, verbatim. `usage` when the engine was not called. */
  readonly status: string;
  readonly exit: { readonly code: number; readonly name: ExitName };
  /** The engine's result object, unflattened. Refusal detail rides here. */
  readonly result: unknown;
  /** Present for every command that captured a vault. */
  readonly coverage?: CoverageBlock;
}

export interface CliOutcome {
  readonly command: string | null;
  readonly status: string;
  readonly result: unknown;
  readonly coverage?: CoverageBlock;
  /** Human-readable stdout lines, each newline-terminated on the way out. Ignored under `--json`. */
  readonly lines?: readonly string[];
  /**
   * Human stdout written verbatim, with nothing appended. `read` uses this so
   * that `geode-wiki read … > note.md` reproduces the file's bytes exactly
   * rather than gaining or losing a trailing newline.
   */
  readonly raw?: string;
  /** Honesty notes — incomplete discovery, truncation, parser gaps. Always stderr. */
  readonly warnings?: readonly string[];
}

export function envelope(outcome: CliOutcome): CliEnvelope {
  const name = outcome.status === "usage" ? "usage" : exitNameFor(outcome.status);
  return {
    tool: "geode-wiki",
    schemaVersion: 1,
    command: outcome.command,
    status: outcome.status,
    exit: { code: EXIT[name], name },
    result: outcome.result,
    ...(outcome.coverage ? { coverage: outcome.coverage } : {}),
  };
}

/* --------------------------------------------------------------- rendering */

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Write one outcome and hand back its exit code.
 *
 * Warnings go to stderr in *both* modes. Under `--json` they are also in the
 * payload as `coverage`, but a human piping stdout to a file should still see
 * that the walk was cut short.
 */
export function emit(outcome: CliOutcome, json: boolean, streams: Streams): number {
  const shape = envelope(outcome);
  if (json) {
    streams.out(JSON.stringify(shape) + "\n");
  } else if (outcome.raw !== undefined) {
    streams.out(outcome.raw);
  } else {
    for (const line of outcome.lines ?? []) streams.out(line + "\n");
  }
  for (const warning of outcome.warnings ?? []) streams.err(warning + "\n");
  return shape.exit.code;
}

/* ---------------------------------------------------------------- warnings */

/**
 * The capture's own admissions, as lines.
 *
 * `discoveryComplete` is the sharpest of the three: with it false, a `missing`
 * resolution and an `absent` note mean "I did not find it in what I walked",
 * which is not the same claim as "it is not there". Saying so out loud is the
 * point — a caller that is not told will read the first as the second.
 */
export function coverageWarnings(coverage: CoverageBlock): string[] {
  const lines: string[] = [];
  if (!coverage.discoveryComplete) {
    lines.push("warning: discovery incomplete — a limit cut the walk short, so absence is not provable");
  }
  if (!coverage.noteContentComplete) {
    lines.push("warning: some discovered notes could not be read — their text and links are missing from every answer");
  }
  if (!coverage.aliasCoverageComplete) {
    lines.push("warning: alias indexing is not exhaustive — an alias may fail to resolve that would otherwise match");
  }
  for (const diagnostic of coverage.diagnostics) {
    const where = diagnostic.path ?? diagnostic.paths?.join(", ");
    lines.push(`diagnostic: ${diagnostic.code}${where ? ` (${where})` : ""}`);
  }
  return lines;
}

/** Per-note parser coverage, which is a different claim from the walk's coverage. */
export function parserWarnings(path: string, coverage: {
  referencesCertain: boolean; headingsCertain: boolean;
  blocksCertain: boolean; frontmatterCertain: boolean; bodyScanned: boolean;
}): string[] {
  const gaps: string[] = [];
  if (!coverage.bodyScanned) gaps.push("the body was not scanned in full");
  if (!coverage.referencesCertain) gaps.push("references are not certain");
  if (!coverage.headingsCertain) gaps.push("headings are not certain");
  if (!coverage.blocksCertain) gaps.push("block ids are not certain");
  if (!coverage.frontmatterCertain) gaps.push("frontmatter is not certain");
  return gaps.length ? [`warning: ${path}: ${gaps.join("; ")}`] : [];
}

/* ------------------------------------------------------------ human lines */

/** `status` first on every refusal line, so the vocabulary survives the human rendering too. */
export function refusalLine(status: string, detail: Record<string, unknown>): string {
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length ? `${status}  ${parts.join(" ")}` : status;
}

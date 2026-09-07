/**
 * Preflight for the three Obsidian documentation corpora the parity ledger is
 * generated from.
 *
 * The corpora are clones of upstream Obsidian repos that live OUTSIDE this
 * repository, and their default locations are under `/private/tmp`. macOS clears
 * `/tmp`, so they disappear on their own — after a reboot, or simply after
 * enough days pass. When that happened, `npm run parity:check` died with a raw
 * `ENOENT: ... scandir '/private/tmp/geode-audit-obsidian-help/en'` and a Node
 * stack trace pointing into `readdir`, which says nothing about what is actually
 * wrong or how to fix it. A required gate that rots on its own should say so in
 * its own words.
 *
 * Split pure/IO like the rest of the repo: `formatMissingCorpusError` is a pure
 * string builder (unit-tested), `preflightCorpora` does the filesystem check.
 */

import { stat } from "node:fs/promises";

/** One of the three upstream documentation corpora the ledger reads. */
export interface CorpusSpec {
  /** Human label used in the error message. */
  label: string;
  /** Resolved absolute path we expect to find it at. */
  path: string;
  /** CLI flag that overrides this path. */
  flag: string;
  /** Upstream repo to clone it from. */
  repo: string;
}

/**
 * Build the operator-facing error for one or more missing corpora. Pure — takes
 * the already-determined missing list so it can be tested without touching disk.
 */
export function formatMissingCorpusError(missing: CorpusSpec[]): string {
  const plural = missing.length === 1 ? "corpus is" : "corpora are";
  const lines: string[] = [
    `Parity ledger ${plural} missing — cannot generate or check the ledger.`,
    "",
    "The parity ledger is built from clones of the upstream Obsidian documentation",
    "repositories. These live outside this repo, default to paths under /private/tmp,",
    "and are cleared by macOS periodically — so this is expected to recur and does NOT",
    "mean the ledger or your changes are broken.",
    "",
    `Missing (${missing.length} of 3):`,
  ];
  for (const corpus of missing) {
    lines.push(`  - ${corpus.label}: ${corpus.path}`);
  }
  lines.push(
    "",
    "Re-clone them (see docs/spec/05-parity-ledger.md § Refresh procedure):",
    "",
  );
  for (const corpus of missing) {
    lines.push(`  git clone ${corpus.repo} ${corpus.path}`);
  }
  lines.push(
    "",
    "Or point the generator at existing clones elsewhere:",
    "",
    `  npm run parity:check -- ${missing.map((c) => `${c.flag} <path>`).join(" ")}`,
  );
  return lines.join("\n");
}

/**
 * Thrown when a corpus is absent. Distinguished from a genuine bug so the entry
 * point can print the guidance and exit non-zero WITHOUT a stack trace — the
 * stack is noise here, since the cause is a missing external clone rather than
 * anything in this code.
 */
export class MissingCorpusError extends Error {
  readonly missing: CorpusSpec[];
  constructor(missing: CorpusSpec[]) {
    super(formatMissingCorpusError(missing));
    this.name = "MissingCorpusError";
    this.missing = missing;
  }
}

/**
 * Verify every corpus directory exists before the ledger walk begins. Throws a
 * single actionable error listing everything missing at once, rather than
 * failing on the first `readdir` deep inside the walk.
 */
export async function preflightCorpora(corpora: CorpusSpec[]): Promise<void> {
  const missing: CorpusSpec[] = [];
  for (const corpus of corpora) {
    try {
      const info = await stat(corpus.path);
      if (!info.isDirectory()) missing.push(corpus);
    } catch {
      missing.push(corpus);
    }
  }
  if (missing.length > 0) throw new MissingCorpusError(missing);
}

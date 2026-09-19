/**
 * `geode-wiki` — the headless engine as a command.
 *
 * ## Why a command at all
 *
 * The SDK from the previous increment is callable only from something that can
 * `import` it. Agents shell out; a subcommand with an exit code and a JSON
 * payload is a first-class interface for them, not a human convenience.
 *
 * It also dissolves a problem a long-lived server would have had to solve.
 * Every invocation is a fresh process: it captures the folder, answers one
 * question, and exits. There is no handle to go stale against a vault a human
 * is editing in the same second, because there is no handle. That is why
 * `refresh()` — the eleventh method on `WikiSession` — has no subcommand here:
 * the process *is* the refresh, and exposing it would imply a session that
 * outlives one answer.
 *
 * ## What this file is allowed to contain
 *
 * Argument parsing and dispatch. Nothing else. It imports `../wiki/index` and
 * `../catalog/index` and may not reach past either into the parser, the
 * candidate pipeline, the snapshot constructor, the catalog contract or the
 * PostgreSQL adapter. `scripts/run-wiki-cli-proof.mjs` audits esbuild's
 * per-file import records to enforce that rather than trust it: if a module
 * under `src/cli/` ever imports anything from `src/` other than those two entry
 * points, the proof names the offending edge and fails.
 *
 * If a subcommand cannot be written within that rule, the SDK surface is
 * missing something and the fix belongs there — not here.
 *
 * ## No new dependency
 *
 * `parseArgs` from `node:util`. Adding an argument-parsing library to get
 * marginally nicer help text would be a scope decision dressed up as an
 * implementation detail.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  openWikiSession,
  type CaptureError,
  type WikiLimits,
  type WikiSession,
} from "../wiki/index";
import { publishFolder, restoreFolder } from "../catalog/index";
import {
  coverageWarnings,
  emit,
  parserWarnings,
  refusalLine,
  type CliOutcome,
  type CoverageBlock,
  type Streams,
} from "./output";

/* ------------------------------------------------------------------ usage */

const USAGE = `geode-wiki — the Geode headless wiki engine as a command

Usage:
  geode-wiki <command> [options]

Vault commands (each takes --root <dir>):
  info                            coverage and provenance of the capture
  list                            every note and attachment, in path order
  read <path>                     one note's text; metadata under --json
  search <query>                  bounded, ASCII-folded literal scan
  resolve <from-path> <target>    resolve a wikilink under strict policy
  outgoing <path>                 references this note makes
  backlinks <path>                references that resolve to this note
  create <path> --text <s>        create a note
  update <path> --text <s>        replace a note's text
  delete <path>                   delete a note

Catalog commands (libpq PG* variables select the server):
  catalog-publish --root <dir> --vault-id <id> --mutation-id <id>
                  --base-sequence <n> [--schema <name>]
  catalog-restore --into <dir> --vault-id <id> [--schema <name>]

Options:
  --json                  structured output; named statuses preserved verbatim
  --limit <n>             search: maximum hits
  --text <string>         create/update: the note text
  --text-file <path>      create/update: read the text from a file, or - for stdin
  --max-entries <n>       capture: override the entry ceiling
  --max-note-bytes <n>    capture: override the per-note byte ceiling
  --schema <name>         catalog: schema name; defaults to GEODE_CATALOG_SCHEMA
  --help                  this text

Exit codes:
  0  ok           the operation completed and its status is "ok"
  1  refused      the engine answered with a named non-ok status, which is in
                  the payload — "absent", "ambiguous", "already-exists",
                  "portability-collision", "oversize", "conflict", and so on
  2  usage        argv could not be turned into an operation; nothing ran
  3  unavailable  the vault folder or the catalog store could not be reached

There is no "refresh" command. Every invocation is a fresh capture, so the
process is the refresh.`;

/* ------------------------------------------------------------ option specs */

type OptionSpec = Record<string, { type: "string" | "boolean" }>;

const SHARED: OptionSpec = { json: { type: "boolean" }, help: { type: "boolean" } };
const CAPTURE: OptionSpec = {
  root: { type: "string" },
  "max-entries": { type: "string" },
  "max-note-bytes": { type: "string" },
};
const TEXT: OptionSpec = { text: { type: "string" }, "text-file": { type: "string" } };

/** Positional arity is declared, not inferred, so a missing argument is a usage error rather than `undefined`. */
const COMMANDS: Record<string, { positionals: readonly string[]; options: OptionSpec }> = {
  info: { positionals: [], options: { ...SHARED, ...CAPTURE } },
  list: { positionals: [], options: { ...SHARED, ...CAPTURE } },
  read: { positionals: ["path"], options: { ...SHARED, ...CAPTURE } },
  search: { positionals: ["query"], options: { ...SHARED, ...CAPTURE, limit: { type: "string" } } },
  resolve: { positionals: ["from-path", "target"], options: { ...SHARED, ...CAPTURE } },
  outgoing: { positionals: ["path"], options: { ...SHARED, ...CAPTURE } },
  backlinks: { positionals: ["path"], options: { ...SHARED, ...CAPTURE } },
  create: { positionals: ["path"], options: { ...SHARED, ...CAPTURE, ...TEXT } },
  update: { positionals: ["path"], options: { ...SHARED, ...CAPTURE, ...TEXT } },
  delete: { positionals: ["path"], options: { ...SHARED, ...CAPTURE } },
  "catalog-publish": {
    positionals: [],
    options: {
      ...SHARED, root: { type: "string" }, "vault-id": { type: "string" },
      "mutation-id": { type: "string" }, "base-sequence": { type: "string" },
      schema: { type: "string" },
    },
  },
  "catalog-restore": {
    positionals: [],
    options: {
      ...SHARED, into: { type: "string" }, "vault-id": { type: "string" },
      schema: { type: "string" },
    },
  },
};

/* ----------------------------------------------------------------- helpers */

/** A usage failure. Carries the same envelope as everything else, with status `usage`. */
function usage(message: string, command: string | null = null): CliOutcome {
  return {
    command,
    status: "usage",
    result: { message },
    lines: [`usage error: ${message}`, "", "Run `geode-wiki --help` for the full surface."],
  };
}

function integer(raw: string | undefined, flag: string): number | { error: string } {
  if (raw === undefined) return { error: `${flag} is required` };
  if (!/^\d+$/.test(raw)) return { error: `${flag} must be a non-negative integer, got ${JSON.stringify(raw)}` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { error: `${flag} is out of range` };
  return value;
}

const isError = (value: unknown): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value;

/** Everything on a result except `status`, for the human refusal line. */
function detailOf(result: object): Record<string, unknown> {
  const { status: _ignored, ...rest } = result as Record<string, unknown> & { status?: unknown };
  return rest;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------------- entry */

export interface RunContext {
  readonly streams: Streams;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadableStream;
}

/**
 * Parse one argv, run one operation, write one answer, hand back one exit code.
 *
 * Takes its streams and environment rather than reaching for `process`, so the
 * proof harness and the unit tests exercise the same code path the binary does.
 */
export async function run(argv: readonly string[], context: RunContext): Promise<number> {
  const { streams } = context;

  if (argv.length === 0) {
    return emit(usage("no command given"), false, streams);
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    streams.out(USAGE + "\n");
    return 0;
  }

  const name = argv[0];
  const spec = COMMANDS[name];
  if (!spec) {
    const known = Object.keys(COMMANDS).sort().join(", ");
    return emit(usage(`unknown command ${JSON.stringify(name)}; known commands are ${known}`), false, streams);
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv.slice(1)],
      options: spec.options,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, string | boolean | undefined>;
    positionals = parsed.positionals;
  } catch (error) {
    return emit(usage(error instanceof Error ? error.message : String(error), name), false, streams);
  }

  const json = values.json === true;
  if (values.help === true) {
    if (json) return emit({ command: name, status: "ok", result: { usage: USAGE } }, true, streams);
    streams.out(USAGE + "\n");
    return 0;
  }

  if (positionals.length !== spec.positionals.length) {
    const shape = spec.positionals.map((p) => `<${p}>`).join(" ");
    return emit(
      usage(
        `${name} takes ${spec.positionals.length} positional argument(s)` +
        `${shape ? ` (${shape})` : ""}, got ${positionals.length}`,
        name,
      ),
      json,
      streams,
    );
  }

  const outcome = await dispatch(name, values, positionals, context);
  return emit(outcome, json, streams);
}

/* ---------------------------------------------------------------- dispatch */

async function dispatch(
  name: string,
  values: Record<string, string | boolean | undefined>,
  positionals: readonly string[],
  context: RunContext,
): Promise<CliOutcome> {
  if (name === "catalog-publish") return catalogPublish(values, context);
  if (name === "catalog-restore") return catalogRestore(values, context);

  const root = values.root;
  if (typeof root !== "string" || root === "") return usage("--root <dir> is required", name);

  // Everything decidable from argv alone is decided here, *before* the folder
  // is touched. Exit 2 means "the engine was never called", and that is only
  // true if no option can fail validation after the capture has started —
  // `search --root /nowhere q --limit many` has two problems, and the one the
  // caller has to fix first is the one they wrote.
  const limits: Partial<WikiLimits> = {};
  for (const [flag, key] of [["max-entries", "maxEntries"], ["max-note-bytes", "maxNoteBytes"]] as const) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const parsed = integer(raw as string, `--${flag}`);
    if (isError(parsed)) return usage(parsed.error, name);
    limits[key] = parsed;
  }

  let limit: number | undefined;
  if (name === "search" && values.limit !== undefined) {
    const parsed = integer(values.limit as string, "--limit");
    if (isError(parsed)) return usage(parsed.error, name);
    limit = parsed;
  }

  let text = "";
  if (name === "create" || name === "update") {
    const resolved = await resolveText(name, values, context);
    if (typeof resolved !== "string") return resolved;
    text = resolved;
  }

  const opened = await openWikiSession(root, { limits });
  if (opened.status !== "ok") return unavailableVault(name, root, opened.error);
  const session = opened.session;
  const info = session.info();
  const coverage: CoverageBlock = {
    discoveryComplete: info.discoveryComplete,
    noteContentComplete: info.noteContentComplete,
    aliasCoverageComplete: info.aliasCoverageComplete,
    diagnostics: info.diagnostics,
  };
  const warnings = coverageWarnings(coverage);

  switch (name) {
    case "info": return commandInfo(session, coverage, warnings);
    case "list": return commandList(session, coverage, warnings);
    case "read": return commandRead(session, positionals[0], coverage, warnings);
    case "search": return commandSearch(session, positionals[0], limit, coverage, warnings);
    case "resolve": return commandResolve(session, positionals[0], positionals[1], coverage, warnings);
    case "outgoing": return commandGraph("outgoing", session.outgoingLinks(positionals[0]), coverage, warnings);
    case "backlinks": return commandGraph("backlinks", session.backlinks(positionals[0]), coverage, warnings);
    case "create": case "update": case "delete":
      return commandWrite(name, session, positionals[0], text, coverage, warnings);
    default: return usage(`unhandled command ${JSON.stringify(name)}`, name);
  }
}

function unavailableVault(command: string, root: string, error: CaptureError): CliOutcome {
  return {
    command,
    status: "vault-unavailable",
    result: { root, code: error.code },
    lines: [refusalLine("vault-unavailable", { root, code: error.code })],
  };
}

/* ------------------------------------------------------------ vault reads */

function commandInfo(session: WikiSession, coverage: CoverageBlock, warnings: string[]): CliOutcome {
  const info = session.info();
  return {
    command: "info", status: "ok", result: info, coverage, warnings,
    lines: [
      `consistency            ${info.consistency}`,
      `scanStartedAt          ${info.scanStartedAt}`,
      `scanEndedAt            ${info.scanEndedAt}`,
      `discoveryComplete      ${info.discoveryComplete}`,
      `noteContentComplete    ${info.noteContentComplete}`,
      `aliasCoverageComplete  ${info.aliasCoverageComplete}`,
      `referenceSyntax        ${info.referenceSyntax}`,
      `parserBodyCap          ${info.parserBodyCapCodeUnits} code units`,
      `files                  ${session.listFiles().length}`,
      `exclusionPolicy        ${info.exclusionPolicy.join(", ")}`,
      `parserLimitations      ${info.parserLimitations.join("; ")}`,
    ],
  };
}

function commandList(session: WikiSession, coverage: CoverageBlock, warnings: string[]): CliOutcome {
  const files = session.listFiles();
  return {
    command: "list", status: "ok", result: { files, count: files.length }, coverage, warnings,
    lines: files.map((file) => `${file.kind.padEnd(10)} ${file.path}`),
  };
}

function commandRead(
  session: WikiSession, path: string, coverage: CoverageBlock, warnings: string[],
): CliOutcome {
  const read = session.readNote(path);
  if (read.status !== "ok") {
    return {
      command: "read", status: read.status, result: { path, reason: read.reason }, coverage,
      warnings, lines: [refusalLine(read.status, { path, reason: read.reason })],
    };
  }
  return {
    command: "read", status: "ok", coverage,
    result: {
      path: read.note.path, text: read.note.text,
      metadata: read.note.metadata, diagnostics: read.note.diagnostics, parserCoverage: read.note.coverage,
    },
    // Verbatim bytes, so redirecting stdout to a file round-trips the note.
    raw: read.note.text,
    warnings: [
      ...warnings,
      ...parserWarnings(path, read.note.coverage),
      ...read.note.diagnostics.map((d) => `diagnostic: ${d.code}${d.path ? ` (${d.path})` : ""}`),
    ],
  };
}

function commandSearch(
  session: WikiSession, query: string, limit: number | undefined,
  coverage: CoverageBlock, warnings: string[],
): CliOutcome {
  const found = session.search(query, limit);
  const extra: string[] = [];
  // "No hits" and "no hits in the part I scanned" are different answers, and
  // only one of them is evidence of absence.
  if (!found.complete) extra.push("warning: search did not cover every note — a miss is not evidence of absence");
  if (found.truncated) extra.push("warning: results truncated at the limit — there may be more");
  return {
    command: "search", status: found.status, result: { query, ...found }, coverage,
    warnings: [...warnings, ...extra],
    lines: found.status === "ok"
      ? found.hits.map((hit) => `${hit.path}:${hit.offset}  ${hit.snippet.replace(/\n/g, "\\n")}`)
      : [refusalLine(found.status, { query })],
  };
}

function commandResolve(
  session: WikiSession, fromPath: string, target: string,
  coverage: CoverageBlock, warnings: string[],
): CliOutcome {
  const resolution = session.resolveLink(fromPath, target);
  const lines = [refusalLine(resolution.status, {
    path: resolution.path, reason: resolution.reason,
    subpath: resolution.subpath.status === "none" ? undefined : resolution.subpath.status,
  })];
  for (const candidate of resolution.candidates) lines.push(`  candidate  ${candidate}`);
  return {
    command: "resolve", status: resolution.status,
    result: { fromPath, target, ...resolution }, coverage, warnings, lines,
  };
}

function commandGraph(
  command: "outgoing" | "backlinks",
  graph: { status: string; references: { link: string; sourcePath: string; resolution: { status: string; path?: string } }[]; coverage: object },
  coverage: CoverageBlock, warnings: string[],
): CliOutcome {
  return {
    command, status: graph.status, result: graph, coverage, warnings,
    lines: graph.status === "ok"
      ? graph.references.map((reference) =>
          `${reference.resolution.status.padEnd(11)} ${reference.sourcePath} -> ` +
          `${JSON.stringify(reference.link)}${reference.resolution.path ? ` = ${reference.resolution.path}` : ""}`)
      : [refusalLine(graph.status, {})],
  };
}

/* ----------------------------------------------------------- vault writes */

/**
 * Resolve the note body from argv, or hand back the usage failure.
 *
 * Runs before the folder is opened, so a caller who spelled the flags wrong
 * gets exit 2 rather than a capture they did not ask for.
 */
async function resolveText(
  name: string,
  values: Record<string, string | boolean | undefined>,
  context: RunContext,
): Promise<string | CliOutcome> {
  const inline = values.text;
  const file = values["text-file"];
  if (typeof inline === "string" && typeof file === "string") {
    return usage("--text and --text-file are mutually exclusive", name);
  }
  if (typeof inline === "string") return inline;
  if (typeof file === "string") {
    try {
      return file === "-" ? await readAll(context.stdin) : await readFile(file, "utf8");
    } catch (error) {
      return usage(`--text-file could not be read: ${error instanceof Error ? error.message : String(error)}`, name);
    }
  }
  return usage(`${name} requires --text <string> or --text-file <path>`, name);
}

async function commandWrite(
  name: "create" | "update" | "delete",
  session: WikiSession, path: string, text: string,
  coverage: CoverageBlock, warnings: string[],
): Promise<CliOutcome> {
  const result = name === "create" ? await session.createNote(path, text)
    : name === "update" ? await session.updateNote(path, text)
    : await session.deleteNote(path);

  return {
    command: name, status: result.status, result: { path, ...result }, coverage, warnings,
    lines: [result.status === "ok" ? `ok  ${result.path ?? path}` : refusalLine(result.status, { path })],
  };
}

/* --------------------------------------------------------------- catalog */

function connectionFrom(
  values: Record<string, string | boolean | undefined>, context: RunContext,
): { schema: string } | { error: string } {
  const schema = (values.schema as string | undefined) ?? context.env.GEODE_CATALOG_SCHEMA;
  if (!schema) return { error: "--schema <name> is required, or set GEODE_CATALOG_SCHEMA" };
  return { schema };
}

async function catalogPublish(
  values: Record<string, string | boolean | undefined>, context: RunContext,
): Promise<CliOutcome> {
  const root = values.root;
  const vaultId = values["vault-id"];
  const mutationId = values["mutation-id"];
  if (typeof root !== "string" || root === "") return usage("--root <dir> is required", "catalog-publish");
  if (typeof vaultId !== "string") return usage("--vault-id <id> is required", "catalog-publish");
  if (typeof mutationId !== "string") return usage("--mutation-id <id> is required", "catalog-publish");
  const baseSequence = integer(values["base-sequence"] as string | undefined, "--base-sequence");
  if (isError(baseSequence)) return usage(baseSequence.error, "catalog-publish");
  const connection = connectionFrom(values, context);
  if ("error" in connection) return usage(connection.error, "catalog-publish");

  const result = await publishFolder({
    root, vaultId, mutationId, baseSequence,
    connection: { schema: connection.schema, env: context.env },
  });

  if (result.status !== "ok") {
    return {
      command: "catalog-publish", status: result.status, result,
      lines: [refusalLine(result.status, detailOf(result))],
    };
  }
  return {
    command: "catalog-publish", status: "ok", result,
    coverage: { ...result.coverage },
    warnings: coverageWarnings({ ...result.coverage }),
    lines: [
      `ok  vault=${result.receipt.vaultId} sequence=${result.receipt.sequence}`,
      `notes=${result.receipt.noteCount} assets=${result.receipt.assetCount}`,
      `digest=${result.receipt.digest}`,
    ],
  };
}

async function catalogRestore(
  values: Record<string, string | boolean | undefined>, context: RunContext,
): Promise<CliOutcome> {
  const into = values.into;
  const vaultId = values["vault-id"];
  if (typeof into !== "string" || into === "") return usage("--into <dir> is required", "catalog-restore");
  if (typeof vaultId !== "string") return usage("--vault-id <id> is required", "catalog-restore");
  const connection = connectionFrom(values, context);
  if ("error" in connection) return usage(connection.error, "catalog-restore");

  const result = await restoreFolder({
    into, vaultId, connection: { schema: connection.schema, env: context.env },
  });

  if (result.status !== "ok") {
    return {
      command: "catalog-restore", status: result.status, result,
      lines: [refusalLine(result.status, detailOf(result))],
    };
  }
  return {
    command: "catalog-restore", status: "ok", result,
    lines: [
      `ok  vault=${result.vaultId} sequence=${result.sequence}`,
      `notes=${result.noteCount} assets=${result.assetCount} bytes=${result.totalBytes}`,
      `root=${result.root}`,
    ],
  };
}

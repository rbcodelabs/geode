# `geode-wiki` — the headless engine as a command

The reference for the command surface. The *reasoning* — why a CLI rather than
an MCP server, why four exit codes, why `refresh()` has no subcommand — is in
[ADR 0024](../adr/0024-wiki-cli-over-mcp-server.md). This document is what the
thing does.

It sits on two curated entry points and nothing else:

| Entry point | Exports at runtime | Ledger |
|---|---|---|
| `src/wiki/index.ts` | `openWikiSession`, `DEFAULT_WIKI_LIMITS` | [headless-wiki-sdk.md](headless-wiki-sdk.md) |
| `src/catalog/index.ts` | `publishFolder`, `restoreFolder` | [below](#the-catalog-entry-point) |

## Building it

`geode-wiki` is a **build artifact**, not a committed file:

```bash
npm run build:cli          # -> dist/cli/geode-wiki.mjs, chmod 755
```

`package.json` registers it as `bin.geode-wiki`. It is an in-repo bin: nothing
here is published to npm or any registry, and doing so is not authorized.

Why bundled rather than run from source, given that Node 26 strips types
natively: three compounding resolution facts, recorded in full in
`scripts/build-cli.mjs`. In short, the package is CommonJS, the engine is
written in ESM syntax with extensionless relative imports, and loading the SDK
across that boundary leaves `cjs-module-lexer` unable to see its named exports.

## The surface

```
geode-wiki <command> [options]
```

### Vault commands

Each takes `--root <dir>`. Every invocation captures the folder fresh.

| Command | Positional | SDK method |
|---|---|---|
| `info` | — | `info()` |
| `list` | — | `listFiles()` |
| `read` | `<path>` | `readNote(path)` |
| `search` | `<query>` | `search(query, limit?)` |
| `resolve` | `<from-path> <target>` | `resolveLink(fromPath, target)` |
| `outgoing` | `<path>` | `outgoingLinks(path)` |
| `backlinks` | `<path>` | `backlinks(path)` |
| `create` | `<path>` | `createNote(path, text)` |
| `update` | `<path>` | `updateNote(path, text)` |
| `delete` | `<path>` | `deleteNote(path)` |

Ten commands against eleven session methods. **`refresh()` is deliberately
absent**: a fresh process per invocation means the capture is at most
milliseconds old when it is used, so the process *is* the refresh. A `refresh`
subcommand would imply a session that outlives one answer, and there isn't one.

### Catalog commands

```
catalog-publish --root <dir> --vault-id <id> --mutation-id <id>
                --base-sequence <n> [--schema <name>]
catalog-restore --into <dir> --vault-id <id> [--schema <name>]
```

The schema comes from `--schema` or `GEODE_CATALOG_SCHEMA`; the server comes
from the standard libpq `PG*` variables. **No configuration file is invented**,
and none is read. `--base-sequence` is required rather than looked up, so a
caller states the sequence it believes the vault is at and gets `conflict` by
name when it is wrong, instead of clobbering blind.

### Options

| Option | Applies to | Effect |
|---|---|---|
| `--json` | all | One-line structured envelope on stdout |
| `--limit <n>` | `search` | Maximum hits |
| `--text <s>` | `create`, `update` | The note body |
| `--text-file <p>` | `create`, `update` | Body from a file, or `-` for stdin |
| `--max-entries <n>` | vault commands | Override the capture entry ceiling |
| `--max-note-bytes <n>` | vault commands | Override the per-note byte ceiling |
| `--help` | all | The surface |

## Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | The engine answered affirmatively |
| 1 | `refused` | A named non-affirmative status, carried in the payload |
| 2 | `usage` | argv could not be turned into an operation; nothing ran |
| 3 | `unavailable` | The vault folder or the catalog store could not be reached |

Three properties worth stating explicitly, because each is a thing a caller can
rely on:

- **Exactly two statuses in the whole vocabulary are affirmative**: `ok` and
  `resolved`. A successful `resolve` answers `resolved`, not `ok`.
- **`missing` (exit 1) and `unavailable` (exit 3) are different answers.**
  `missing` means the engine looked and did not find it. `unavailable` means it
  could not look — the source note was never walked, or the folder is not there.
- **Exit 2 means the engine was never called.** Every argv-decidable check runs
  before the folder is opened, so
  `search --root /nowhere q --limit many` exits 2 for the `--limit`, not 3 for
  the root.

## The `--json` envelope

One shape for every command, success and refusal alike.

```jsonc
{
  "tool": "geode-wiki",
  "schemaVersion": 1,
  "command": "resolve",        // null when argv never named a valid one
  "status": "ambiguous",       // the engine's own status, verbatim
  "exit": { "code": 1, "name": "refused" },
  "result": { /* the engine's result object, unflattened */ },
  "coverage": { /* present for every command that captured a vault */ }
}
```

**Named statuses are never flattened into prose.** That rule is the point of the
whole surface. A caller must be able to tell `already-exists` from
`portability-collision` from `oversize`, and `resolved` from `ambiguous` from
`missing` from *not scanned*. Refusal detail — which path, which limit, observed
vs. allowed — rides in `result` alongside the status.

`exit.code` always equals the process's actual exit status. The proof asserts
that on every invocation, so a caller trusting either is trusting the same
thing.

### Observed

```
$ geode-wiki resolve --root /tmp/vault Index.md Dup --json
{"tool":"geode-wiki","schemaVersion":1,"command":"resolve","status":"ambiguous",
 "exit":{"code":1,"name":"refused"},"result":{"fromPath":"Index.md","target":"Dup",
 "status":"ambiguous","candidates":["a/Dup.md","b/Dup.md"],"subpath":{"status":"none"},
 "discoveryComplete":true,"aliasCoverageComplete":true},"coverage":{...}}
  [exit 1]

$ geode-wiki create --root /tmp/vault Target.md --text x --json
{"tool":"geode-wiki","schemaVersion":1,"command":"create","status":"already-exists",
 "exit":{"code":1,"name":"refused"},"result":{"path":"Target.md","status":"already-exists"},
 "coverage":{...}}
  [exit 1]
```

Note that `ambiguous` reports both candidates and picks neither — the SDK
answers under agent-strict policy, not the desktop-compatibility resolver that
silently tie-breaks. The audit below is what keeps those two from converging.

## Honest diagnostics

Every vault answer carries the capture's own account of itself, so *not found*
stays separable from *not looked at*.

`coverage` in the envelope, and the same information as stderr warnings in both
modes:

```
$ geode-wiki search --root /tmp/vault plesiosaur --max-entries 2 --json
{… "status":"ok","exit":{"code":0,"name":"ok"},
 "result":{"query":"plesiosaur","hits":[],"truncated":false,"complete":false,…},
 "coverage":{"discoveryComplete":false,"noteContentComplete":true,
             "aliasCoverageComplete":false,"diagnostics":[{"code":"entry-limit","path":"Index.md"}]}}
warning: discovery incomplete — a limit cut the walk short, so absence is not provable
warning: alias indexing is not exhaustive — an alias may fail to resolve that would otherwise match
diagnostic: entry-limit (Index.md)
warning: search did not cover every note — a miss is not evidence of absence
  [exit 0]
```

**That search exits 0 with no hits, and is right to.** An incomplete search is
an answer, not an error. What must never happen is that it looks like a complete
one — hence `complete: false`, `discoveryComplete: false`, the named diagnostic,
and four lines on stderr.

Warnings go to stderr in both modes, so `geode-wiki read … > note.md` still
tells the operator the walk was cut short. Human `read` writes the note's exact
bytes to stdout and nothing else, so that redirect round-trips the file.

## The layering, and how it is enforced

The CLI is an argument-parsing and formatting layer. It contains no engine
logic, and this is checked rather than asserted:

- **Per-edge.** `scripts/run-wiki-cli-proof.mjs` reads esbuild's per-file import
  records. A module under `src/cli/` may import `src/wiki/index.ts`,
  `src/catalog/index.ts` and its own siblings — nothing else in `src/`. A
  violation fails naming the edge:
  `src/cli/output.ts imports src/wiki/link-resolution.ts (as "../wiki/link-resolution")`.
- **Exact input set**, not a permitted superset, so a module quietly
  disappearing fails too.
- **The reverse direction.** `src/cli/` is in the prefixes
  `scripts/run-wiki-sdk-proof.mjs` forbids from the SDK's own graph. An engine
  module reaching back into output formatting would make the SDK unusable by
  anything that is not a terminal.

Both audits were verified non-vacuous by breaking them on purpose and observing
the named failure, then reverting.

The absences that carry the most meaning are `src/wiki/search.ts` (the desktop
operator query language), `src/wiki/link-resolution.ts` (the
desktop-compatibility resolver) and `src/wiki/query-projection.ts` (the
restore-equality test oracle). Any of them appearing would mean a second,
contradictory contract had shipped under one surface.

## The catalog entry point

`src/catalog/index.ts` is the catalog's counterpart to `src/wiki/index.ts`: a
narrowing, not a re-export. At runtime it exports exactly two functions.

**Public:**

| Export | Why |
|---|---|
| `publishFolder(options)` | Capture a folder through the wiki SDK and publish it as one vault |
| `restoreFolder(options)` | Verify one vault out of the store and materialize it onto a folder |

**Not public, and why:**

| Excluded | Reason |
|---|---|
| `CatalogStore`, `CatalogRestoreSource` | Outbound ports for adapter authors, not for callers |
| `validatePublication`, `verifyRestoredVault` | Halves of an operation. Exposing them invites a caller to validate and then commit something else |
| `install`, `drop` | Schema lifecycle is an administrative act with its own script (`scripts/catalog-schema-admin.mts`). A publish command must not be able to drop a schema |
| `openSession`, `publishSql`, `query` | Raw `psql` access and the failure-injection flags. Proof machinery |
| `readVault` | The unverified read. Callers want the verified one |
| `materializeRestoredVault` | Reachable only as the second half of `restoreFolder`, so a restore cannot be materialized without being verified first |

**Statuses.** `PublishFolderStatus` and `RestoreFolderStatus` *include* the
portable contract's vocabularies rather than collapsing them — 15 publish
validation statuses, the commit statuses, and 18 restore statuses all survive to
the command line by name. Three are added here for failures the contract has no
opinion about because they happen before or after it:

| Status | Meaning | Exit |
|---|---|---|
| `invalid-schema` | Not a schema this adapter may create, use or drop | 1 |
| `vault-unavailable` | The folder could not be captured at all | 3 |
| `entry-unreadable` | One captured file could not be read back | 1 |

A successful publish carries `coverage`, because a vault whose walk was cut
short still publishes and a caller that is never told cannot distinguish "this
vault has four notes" from "four notes is as far as I got".

**Attachment content types are guessed from the extension** and labelled as a
guess. Anything unrecognised is published as `application/octet-stream`, which
the default allowlist accepts — the allowlist's teeth are in a caller's
tightened limits, not in that table. The contract verifies the content address
against the bytes either way, which is the check that actually protects the
store.

## Proofs

| Command | What it proves | Needs |
|---|---|---|
| `npm run proof:wiki-cli` | The binary in real subprocesses: all four exit codes, the refusal vocabulary, cross-process read-after-write with distinct PIDs, the enforced layering | nothing |
| `npm run proof:wiki-cli:postgres` | `catalog-publish` in one process, `catalog-restore` in another, then nine `geode-wiki` questions answering identically against the restored folder | libpq `PG*` |

The cross-process check is the one that could not have been faked. A long-lived
session would satisfy "create a note, then read it back" out of its own heap. A
command can only satisfy it by having actually written to disk and actually
re-captured — in a second process, with a different PID, asserted.

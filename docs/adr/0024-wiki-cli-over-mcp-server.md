# ADR 0024 — A CLI, not an MCP server, over the wiki SDK

Status: Accepted
Date: 2026-09-19
Extends [ADR 0023](0023-wiki-sdk-session-semantics.md). Defers, does not reject,
an MCP server.

## Context

[ADR 0023](0023-wiki-sdk-session-semantics.md) gave the headless engine one
curated entry point, `src/wiki/index.ts`, and stopped there. Its closing
sentence — "Not published, no CLI, no MCP server" — named the next increment as
an MCP server, and the build package that authorized this work originally
specified one.

That plan was challenged by the product owner before implementation began, and
revised: **a CLI instead, MCP deferred.** This ADR records why, because the
reasoning is not "a CLI is easier" and the distinction matters for what gets
built next.

### An SDK has one kind of caller, and it is the rarer one

`openWikiSession` is reachable only from something that can `import` it — a
TypeScript or JavaScript process in the same build. That is a real audience and
a small one. The audience this engine is being built toward is agents, and the
thing agents do constantly, in every harness, with no integration work at all,
is **shell out**. A subcommand with an exit code and a JSON payload is a
first-class agent interface, not a human convenience that happens to be nearby.

An MCP server is also an agent interface — a better one for some purposes. But
it is a *protocol* interface, and it requires the agent's harness to be
configured for it. Shelling out requires nothing.

### A short-lived invocation dissolves the staleness problem rather than solving it

ADR 0023 spent its length on one hazard: a caller holding a view across a write
and getting a silently wrong answer. Its answer was structural — hand out a
session that dereferences the provider at call time, so no stale handle is
obtainable.

That answer is sound, and it bounds the problem to *one process's own writes*. It
says nothing about the other half, which a long-lived server would have had to
face immediately:

> The vault is a folder of Markdown files, and a human is editing it in a
> desktop app at the same time.

A server holding a session for minutes or hours is stale against that human from
the moment its capture completes, and `refresh()` only converts the question
into "how often, and how do you know?". Every available answer is a policy with
failure modes: poll and you are stale between polls; watch the filesystem and you
inherit every cross-platform `fsevents`/`inotify` hazard; refresh per request and
the session was never a session.

A command invocation has none of these. It starts, captures, answers one
question, and exits. The capture is at most milliseconds old when it is used,
and there is no handle to go stale because the process is gone. **The eleventh
session method, `refresh()`, therefore has no subcommand: the process is the
refresh.** That is not a gap in the surface; it is the design.

This is also why the proof harness is built the way it is. A long-lived session
would satisfy "create a note, then read it back" out of its own heap and prove
nothing about durability. A command can only satisfy it by having actually
written to disk and then actually re-captured, in a second process with a
different PID — which is what `scripts/run-wiki-cli-proof.mjs` asserts.

## Decision

Build `geode-wiki`: a command over the SDK, registered as an in-repo `bin`.

**1. The CLI is an argument-parsing and formatting layer, and that is enforced.**

Modules under `src/cli/` may import `src/wiki/index.ts`, `src/catalog/index.ts`
and each other. Nothing else in `src/`. This is checked against esbuild's
per-file import records, so a violation fails with the offending *edge* named —
not merely with a changed dependency set. The reverse direction is enforced too:
`src/cli/` was added to the prefixes the SDK's own graph audit forbids, because
an engine module reaching back into output formatting would make the SDK
unusable by anything that is not a terminal.

If a subcommand cannot be written within that rule, the SDK surface is missing
something and the fix belongs there.

**2. Named statuses are preserved, never flattened.**

The engine's refusal vocabulary — `already-exists`, `portability-collision`,
`capture-incomplete`, `ambiguous`, `oversize`, `conflict`,
`byte-length-mismatch`, and the rest — is the product. `--json` carries the
engine's own result object with its status verbatim, refusal detail included.
A formatter that rendered all of them as `Error: could not create note` would
destroy the only thing that makes this surface worth calling from a script.

**3. Four exit codes, distinguishable without parsing stdout.**

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | The engine answered affirmatively |
| 1 | `refused` | The engine answered with a named non-affirmative status, which is in the payload |
| 2 | `usage` | argv could not be turned into an operation; the engine was never called |
| 3 | `unavailable` | The vault folder or the catalog store could not be reached at all |

Two things about this table are load-bearing and were both caught by tests
rather than by inspection:

- **The whole vocabulary has exactly two affirmative statuses**, and only one of
  them is spelled `ok`. A resolution's success is `resolved`. Keying the exit
  code on the literal string `"ok"` exited 1 on every successful `resolve`.
- **`missing` and `unavailable` are different answers and get different codes.**
  `missing` means the engine looked and did not find it. `unavailable` means it
  could not look — the source note was never walked, or the folder is not there.
  Collapsing them would tell a caller a note does not exist when the truth is
  that nobody checked.

**4. Exit 2 means the engine was never called, and that is kept true.**

Every check decidable from argv alone runs *before* the folder is opened. So
`search --root /nowhere q --limit many` exits 2 for the unparseable `--limit`,
not 3 for the unreachable root. This was not the first implementation: the
ordering bug was found by a unit test that expected 2 and observed 3, and is now
pinned in both the unit tests and the subprocess proof.

**5. Honest diagnostics travel with every answer.**

Coverage — `discoveryComplete`, `noteContentComplete`, `aliasCoverageComplete`
and the capture's diagnostics — is in the `--json` envelope for every vault
command, and on stderr as warnings in both modes. A search that did not cover
every note reports `complete: false` *and still exits 0*, because an incomplete
search is an answer rather than an error. What must never happen is that it
looks like a complete one.

**6. No new runtime dependency.** `parseArgs` from `node:util`.

**7. Publish and restore get their own curated entry point.**

ADR 0022 keeps the catalog outside the wiki graph, so the CLI cannot get
publish and restore from `src/wiki/index.ts`. Assembling them inline out of
`validatePublication`, `publish`, `restore`, `materializeRestoredVault` and the
adapter *is* logic, and re-deriving it per caller is how two callers end up
publishing subtly different vaults. `src/catalog/index.ts` is that assembly,
once, in the layer that already knows a database exists. It exports two
functions at runtime. Schema lifecycle — `install`, `drop`, `openSession`,
`publishSql` — stays internal: creating and dropping schemas is an
administrative act with its own script, not something a publish command should
be able to reach.

## Consequences

**The `bin` is a build artifact.** `npm run build:cli` must run before
`geode-wiki` is invokable. Node 26 strips types natively, so pointing `bin`
straight at `src/cli/main.ts` looks like it should work. It does not, for three
compounding reasons recorded in full in `scripts/build-cli.mjs`: the package is
CommonJS so a `.ts` file under it cannot contain `import`; renaming to `.mts`
makes it ESM, which demands file extensions the engine's internal imports do not
have; and importing the SDK from an ESM entry loads it as CommonJS, where
`cjs-module-lexer` does not recognise the `export const` that type stripping
leaves behind — observed as `SyntaxError: The requested module … does not
provide an export named 'DEFAULT_WIKI_LIMITS'`. Bundling is what every existing
proof in this repo already does.

**No registry publication.** In-repo `bin` only. Publishing this package is out
of scope by contract and is not authorized by this ADR.

**MCP is deferred, not rejected.** Nothing here forecloses it, and the layering
makes it cheaper: an MCP server would sit beside `src/cli/` as a second consumer
of the same two entry points, under the same import audit. It would have to
answer the staleness question this increment sidestepped — which is a reason to
build it deliberately rather than by default.

**One thing the CLI cannot do that the SDK can.** A single invocation cannot
hold a vault across several writes and reads and be certain nothing else changed
underneath, because each invocation re-captures. That is the cost of dissolving
the staleness problem instead of solving it, and callers who need the stronger
property should use the SDK directly.

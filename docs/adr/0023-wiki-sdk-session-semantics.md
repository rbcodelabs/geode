# ADR 0023 — Wiki SDK session semantics

Status: Accepted
Date: 2026-09-19
Supersedes: nothing. Extends [ADR 0019](0019-readonly-local-wiki-snapshot.md) and
[ADR 0020](0020-write-capable-local-wiki-provider.md).

## Context

Everything built under `src/wiki/` so far is foundation with no caller.
`package.json` declared no `bin`, no export map and no entry point, so nothing
outside this repo's own proof scripts could invoke the engine at all. This is
increment 5's first half — the SDK. The MCP server is separate, not begun here,
and not authorized by this ADR.

Giving the engine an entry point forces one question that the read and write
ADRs deliberately left open, because neither had a caller to ask it:

**What does a consumer hold between calls?**

ADR 0019 answers reads with a *snapshot*: a frozen, detached, point-in-time
capture with no back-reference to the folder it came from. ADR 0020 adds writes,
and does so by rebuilding that snapshot after every applied write —
`folder-provider.ts` reassigns `view = createWikiSnapshot(captured, info)` inside
`commit()`, and `snapshot()` returns whatever `view` currently is.

Those two facts are individually correct and jointly a trap. A snapshot obtained
before a write is *still valid* — it is frozen and self-consistent — it simply
describes a world that no longer exists, and nothing about it says so. Any
consumer that does the natural thing:

```ts
const view = provider.snapshot();
await provider.create("N.md", "…");
view.readNote("N.md");   // "absent", silently and forever
```

gets a wrong answer with no error, no staleness flag and no type signal. An
agent-facing surface — which is what this SDK exists to become — would hit this
on its very first create-then-read tool sequence.

## Decision

**The SDK hands out a session, and a session never hands out a view.**

`openWikiSession` in `src/wiki/index.ts` returns a `WikiSession`: eleven methods,
no handle. Every read method dereferences `provider.snapshot()` *at call time*:

```ts
readNote: (path) => provider.snapshot().readNote(path),
```

That one indirection is the whole guarantee. Because the provider rebuilds its
view inside `commit()` before returning from a write, a read issued after an
awaited write is answered from a view that already contains it. No refresh, no
re-open, no staleness flag for a caller to forget to check.

Crucially, the decision is not "document that you should re-fetch the snapshot".
It is "make the stale handle unobtainable". `WikiSession` has no `snapshot()`,
no `provider`, and no other route to either, so the broken sequence above cannot
be written against this surface. A convention a caller must remember is a bug
waiting for a deadline; a missing method is not.

### Evidence this is the right reading of the code

- `snapshot.ts` returns `freeze({ info, listFiles, readNote, search, resolve,
  outgoing, backlinks })` — an object with no reference to the folder, the
  provider, or a generation counter. It cannot detect its own staleness, and
  adding that ability would mean changing the snapshot contract, which is
  explicitly out of scope for this increment.
- `folder-provider.ts` `commit()` rebuilds the view *before* it notifies the
  index sink and *before* it emits the change event. The ordering is not
  incidental: `contracts.ts` states it as a contract — "emission is synchronous
  and happens only after the write has been durably applied and the in-memory
  view rebuilt, so a subscriber that immediately queries the provider observes
  the change it was just told about". Read-after-write is therefore already the
  provider's intended semantics; the SDK's job was to stop the caller from
  opting out of it by accident.
- `openLocalWikiSnapshot` has no write path at all, so a bare snapshot is only
  safe in a strictly read-only program. The SDK cannot know it is in one, so it
  must not offer the shape that is only conditionally safe.

### What the session deliberately does not promise

- **A sequence of reads is not a transaction.** Each individual read is answered
  from one frozen, internally consistent view. Two reads with an awaited write
  between them will disagree, correctly.
- **Nothing outside the process is observed until `refresh()`.** There is no
  filesystem watcher. An external edit is invisible until a caller asks for it,
  and `refresh()` refuses with `root-changed` if the root is no longer the same
  directory. This is inherited unchanged from ADR 0020.
- **Per-note content identity is still not pinned across capture.** A note edited
  outside this process between capture and `updateNote` is overwritten,
  last-writer-wins. ADR 0020 records this as follow-up; the SDK does not change
  it and does not hide it.

### The surface is a narrowing, not a re-export

The second decision, recorded here because it is inseparable from the first: the
entry point exposes a deliberately chosen subset, and everything else under
`src/wiki/` is internal **by omission**. At runtime the module exports exactly
two values — `openWikiSession` and `DEFAULT_WIKI_LIMITS`.

The full public/not-public ledger, with a reason per exclusion, is
`docs/design/headless-wiki-sdk.md`. The exclusions that matter most:

| Excluded | Why |
| --- | --- |
| `src/wiki/search.ts` (`parseQuery`, `matchFileAgainstTerms`) | The desktop search view's operator query language. ADR 0020 records that it is deliberately **not** converged with the snapshot's bounded literal scan. Exporting both would ship two different meanings of "search" under one surface |
| `src/wiki/link-resolution.ts` (`resolveFirstLinkpathDest`) | The desktop-compatibility resolver, which silently tie-breaks ambiguity. The SDK answers under agent-strict policy, which reports it. One SDK must not carry both answers |
| `constants.ts` parser regexes, `commentSpanPattern`, `resolveMetadataScanCapBytes`, the scan-cap constants | File-format internals and a desktop *setting*. `commentSpanPattern` hands out a `/g` regex whose `lastIndex` is caller-visible state; the scan-cap resolver is settings plumbing for `.geode/app.json` |
| `metadata.ts` (`parseMetadata`, `maskCode`, `buildLineStarts`, `offsetToLoc`) | A consumer receives parsed metadata from `readNote`. Exporting the parser invites callers to parse text the engine never captured, under cap semantics the engine owns |
| `selectLinkCandidates`, `normalizeWikiPath`, `CandidateProvider` | Already documented in-source as "internal policies, not a public SDK". A second normalizer in consumer hands is how two disagreeing definitions of a valid path start |
| `WikiFileSystem` / `nodeWikiWriteFileSystem` / `captureLocalWikiFolder` / `createWikiSnapshot` | Adapter seams and the capture boundary, whose in-source comments already say they exist for deterministic failure testing |
| `WikiIndexSink`, `WikiEventSink`, `WikiChangeEvent` | With no filesystem watcher, the only events that can fire are ones the caller itself caused — and it already has that information in the returned `WriteResult`. Surface with no information in it |
| `catalog-contract.ts`, `catalog-materialize.ts`, `query-projection.ts` | The cloud publish/restore path and its restore-equality test oracle. Different concern, live adapter still evolving, and no part of an agent's local-vault interface |

Three types are renamed at the boundary rather than re-exported verbatim, because
the internal names carry vocabulary the surface deliberately drops: `SnapshotLimits`
→ `WikiLimits`, `DEFAULT_SNAPSHOT_LIMITS` → `DEFAULT_WIKI_LIMITS`, `CapturedNote` →
`WikiNote`. One type is declared fresh rather than re-exported: `WikiFileEntry`
is `{ path, kind }`, dropping the optional `text` that internal `CapturedFile`
carries, because `listFiles` never returns note bodies.

`OpenWikiSessionOptions` accepts `limits` and nothing else, and the opener
forwards that field explicitly rather than spreading its options object — so an
adapter seam cannot be smuggled in through an untrusted options bag.

## Boundary — what this is not

- **Not published.** There is no registry publication and no external
  distribution. The export map's `./wiki` resolves to TypeScript source, because
  every in-repo consumer (the proof scripts, and the MCP server that follows)
  bundles from source with esbuild exactly as the existing proofs do. A separate
  `dist` artifact would be build surface with no consumer.
- **Not a CLI.** Deliberately deferred by the approved package.
- **Not an MCP server.** That is the second half of increment 5 and is not begun.
- **No contract changes underneath.** The snapshot and provider contracts are
  untouched; this increment adds a file and an export map. Had the surface only
  been makeable coherent by changing them, that was defined as a scope question
  rather than a decision to take here. It was not needed.
- **Not an OS sandbox.** The ADR 0019/0020 boundary is inherited verbatim:
  portable Node pathname APIs defend a trusted folder against malformed input
  and ordinary races, not against an adversary racing the filesystem with equal
  privilege.

## Consequences

- `tests/unit/wiki-sdk.test.ts` pins the decision directly: create, update and
  delete are each asserted visible to the *next* read with no refresh; the
  session is asserted to expose no `snapshot` or `provider` key; the runtime
  export list is asserted to be exactly two names; and an options object
  carrying a hostile `filesystem`, `index` and `events` is asserted not to reach
  the provider.
- `scripts/wiki-sdk-proof.mts` (npm `proof:wiki-sdk`, wrapped by
  `tests/unit/wiki-sdk-node.test.ts`) drives open → search → read-with-metadata
  → resolve (unique, ambiguous, missing, alias) → backlinks → create/update/delete
  in a fresh Node process, importing **only** `src/wiki/index.ts`.
- The proof's runner audits esbuild's complete input graph as an **exact** set,
  not a permitted superset, so a module that quietly disappears fails as loudly
  as one that appears. Named boundary checks run first so a crossing reports
  which boundary was crossed.
- Adding a method to `WikiSession` now requires updating two asserted method
  lists. That friction is intended: the cost of widening an agent-facing
  contract should be visible in the diff.

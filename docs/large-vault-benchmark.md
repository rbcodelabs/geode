# Synthetic large-vault measurements

This standalone tooling generates synthetic data and measures complete pinned
desktop revisions. It does not change the application or the existing simple
`generatedNote()` benchmark. Results are measurements, not performance gates or
promises about real vaults. Never point it at a personal vault.

## Generate

Use Node 24 (the repository toolchain) and an **absolute, canonical, fresh output
path whose parent exists**. Existing destinations, symlinks and symlink ancestors
are refused. On macOS, use `/private/tmp`, not the `/tmp` symlink.

```sh
npm run generate:stress-vault -- --output=/absolute/parent/generated-10k
node scripts/generate-synthetic-vault.mjs --output=/absolute/parent/generated-50k --notes=50000 --profile=dense --seed=1
node scripts/generate-synthetic-vault.mjs --output=/absolute/parent/generated-100k --notes=100000 --profile=linked
```

Defaults: 10,000 notes, `linked` profile, seed 1. Accepted sizes are 20–100,000;
seeds are unsigned 32-bit integers. `linked` emits 24 wiki references per note;
`dense` emits 96. All notes also contain one Markdown link (separate from the
wiki graph), structured frontmatter, tags, headings, a list block ID, variable
filler and one shallow transclusion of a link-free heading section. Every 100th
note is at least 128 KiB, with references before filler and below the scan cap.

References include cyclic next-note links, hubs, exact paths, unique aliases,
unique basenames, sibling-relative links, heading/block links, one local PNG
embed, and one intentionally missing target. Portable nested Unicode paths have
duplicate basename buckets; shared aliases are bounded to 32 notes per bucket.
Ambiguity query cases are separate from the deterministic bulk graph. Desktop
does not normalize explicit `./` paths; that query records its missing result
separately from strict Node resolution. No parity claim is made for policy
differences. The navigation sequence uses only valid exact targets.

Writes are sequential, with bounded per-note memory. The content digest hashes
note-index order followed by the attachment, each as UTF-8 path, NUL, bytes, NUL.
The manifest is excluded from its own digest. An incomplete marker is created
first, and removed only after the final manifest is written. Failed or interrupted
directories are preserved; there is no automatic overwrite or recursive cleanup.

## Measure

```sh
npm run benchmark:stress-vault -- --output=/absolute/parent/measurements
```

The default comparison is baseline
`c45ebee9c172b4020620c5d63e53acbddff5d46b` versus candidate
`68d7b5353bdd5b960629d422e96c2a4223761085`: three paired runs at each combination
of 10k/50k and linked/dense, alternating baseline/candidate order. Three paired
small same-revision controls run first; their failure stops the matrix. Control
spread exposes OS/first-launch noise even when the code is identical; the first
cold sample is retained, not discarded as warmup. Use
`--baseline=<commit> --candidate=<commit>` to pin other revisions,
`--sizes=100000` to opt into 100k, `--profiles=linked`, `--pairs=3`,
`--control-notes=100`, `--control-pairs=3`, and `--phase-minutes=15` to set explicit parameters.

Reuse an untouched generated fixture with `--fixture=/absolute/generated-vault`.
This selects that fixture instead of the default size/profile matrix. The tool
validates its version, bounded options, exact inventory, absence of symlinks or
special files, content digest and query/navigation plan before copying. It
validates copies before launch and source integrity after each sample. An opened
fixture containing `.geode` state is no longer a valid source: generate a fresh
one. Do not open source fixtures while the benchmark is running.

Small real-Electron smoke (four serial samples including control):

```sh
node scripts/run-large-vault-benchmark.mjs --output=/absolute/parent/smoke --sizes=20 --profiles=linked --pairs=1 --control-notes=20 --control-pairs=1 --phase-minutes=1
```

The controller creates detached complete revision worktrees under the output
directory, verifies identical package/lock inputs, stages one private installed
dependency copy with byte/link fingerprints checked before and after copying,
and builds each revision against that frozen copy. Runtime caches are excluded;
links escaping the dependency tree are refused. The external sample harness is
copied alongside it with source hashes so both samples use the same frozen code
and runtime. Builds,
generation and fixture copies are excluded from phase timings. Each sample has a
fresh vault copy and user-data directory: `.geode/metadata-cache/index.sqlite`
lives **inside the vault**, so fresh user data alone is not cold cache isolation.
Warm restarts reuse only that sample's copy. Electron runs serially; do not run
the repository Electron suite concurrently. Output roots use `stress-` rather
than the test reaper's `geode-` temp prefix.

Each sample measures cold application-cache startup and warm restart, then 100
actual reading-view clicks with active destination/render checks; production
desktop resolution categories; ten external modifications plus one addition and
deletion with full graph verification; and DOM-free Node capture/construction and
query batches. The Node snapshot receives all generated entries with explicit
limits, not the smaller filesystem capture defaults. Node and desktop parser
coverage remains distinct; Markdown examples are not counted as wiki edges.
Navigation render checks assert the destination heading, not attachment image
decoding. A successful navigation sample does not prove that embedded images loaded.
The deleted note is the last globally unique basename outside modified indices
0–9 (index 1 modulo 8), not necessarily the final note. This prevents legitimate
basename fallback from invalidating the missing-link oracle. The exact deletion
path is recorded; Node measurements still use the unmodified source fixture.

Startup readiness requires layout, initialized metadata, expected note/graph row
counts and background idle, followed by exhaustive independently generated graph
checks. `waitForBackgroundIdle()` alone is insufficient. Startup timing and
oracle overhead are reported separately. Incremental timing covers writes through
convergence of precomputed affected rows; exhaustive graph verification is reported
separately. Category warmups are
excluded; raw repeated batch times remain available.

Memory samples come from Electron's real per-process metrics every 250 ms. They
are working sets by process type and phase, summed totals, sampled peak and settled state,
**not unique physical memory or guaranteed peak RSS**. Renderer event-loop delay
sampling begins after first-window access; very early boot and brief memory peaks
can be missed. Cold is application-cache cold, not OS filesystem-cache cold.

The parent watches each phase independently so a blocked synchronous Node build
cannot bypass the deadline. Failures, interruptions and timeouts retain their
last checkpoint, logs, configuration and files; there are no replacement retries.
Before each copy the controller requires 5 GiB plus four fixture sizes of free
space. It stops the remaining matrix on insufficient headroom, preserving prior
evidence. Large dense snapshots may exceed available memory; that is a recorded
result, not a reason to weaken the fixture or silently raise the heap limit.
Electron samples stop at a conservative summed working-set limit of half physical
RAM by default (`--max-working-set-mib` sets an explicit alternative). This is a
resource safety stop, not a performance regression threshold. The remaining matrix
stops on a resource limit, keeping completed measurements. Node's heap defaults
are not raised. Correctness failures, timeouts and resource-limited runs exit
nonzero; a slowdown by itself does not. Valid phases of partial samples remain
in comparisons, with missing/invalid phases excluded rather than treated as zero.

## Evidence and cleanup

`report.json`, `report.md`, per-sample JSON/config/logs, manifests, fixture digests,
environment data and exact commits remain in the output directory. There are no
regression thresholds. Review failed/partial phases alongside absolute times,
paired changes and spread; synthetic samples alone do not prove production
performance. No results are published automatically.
For window closures, preserve each sample's `userdata/crash-journal.json` and
`userdata/diagnostic.log` alongside the reports when present. The harness does not
directly retain Electron stderr/lifecycle events or completed per-click timings
from an interrupted navigation phase. A watchdog recovery identifies the closure
mechanism, not the underlying stall or whether benchmark overhead contributed.

No output is automatically deleted, including revision worktrees and failed
sample copies. After archiving evidence, explicitly remove those exact detached
worktrees with `git worktree remove <recorded-path>` and remove only the chosen
benchmark output directory. Never run recursive cleanup against an unresolved
variable, a vault, home, or a repository root.
# Methodology v2 safeguards

Startup now records initial layout/cache-count readiness, terminal utility completion plus queued renderer background application, and exhaustive graph validation separately. The primary startup timer ends at terminal readiness, before the oracle. An unavailable utility is an explicit failed sample, never a normal performance result. These timings must not be compared directly with methodology v1.

An independent parent samples OS RSS every 500 ms with a two-second query deadline. The default limit remains half physical RAM (8192 MiB on a 16 GiB host); `--max-working-set-mib` also sets this parent limit. RSS includes the owned sample Node process and ancestry/identity-verified Electron groups, including detached descendants. It is distinct from the existing Electron working-set measurement and is not unique physical memory. Three consecutive collection errors fail closed; unsupported platforms fail preflight. Resource-limit or monitoring-unavailable stops the remaining matrix.

Each sample retains `.guard.json` (membership, RSS, errors and termination evidence), `.events.jsonl` (stderr/lifecycle and completed partial navigation clicks), and the original last checkpoint when interrupted. Only freshly identity-verified owned process groups may be terminated. If OS identity collection fails during cleanup, only the owned Node handle is signalled and unresolved detached cleanup is reported; unrelated processes are never guessed or killed. No watchdog settings or app code change.

## Bounded desktop cache hydration

Desktop now reads persisted metadata through optional begin/page/cancel IPC capabilities. Each sender owns one vault-session-bound, opaque reader token backed by a dedicated SQLite read transaction. The snapshot is pinned at begin; ordered keyset pages examine at most 50 rows and serialize to at most 256 KiB, including their envelope. Large JSON blobs are length-checked before fetching, and oversized or malformed entries are reported as bounded omission counts. Operational database errors terminate the stream rather than masquerading as corrupt rows.

Readers close on completion, error, cancellation, replacement, reload, window destruction, or vault switching. They expire after 30 seconds idle or five minutes total. The read snapshot can retain WAL pages until closed; this bounds lifetime, not WAL bytes. No database schema or watchdog settings change.

The renderer applies pages directly into its authoritative cache and preserves newer mutations and deletion/rename tombstones. Missing entries are recovered one file per yield. With a background indexer, initial metadata readiness does not await missing-file recovery: recovery runs in the background queue and is included in `waitForBackgroundIdle()`. This preserves cold-start responsiveness while recovering unchanged omitted entries that the changed-only utility will not resend; recovered notes receive per-file resolve notifications after graph resolution. Consequently, benchmark terminal readiness must still await queued background work. Hosts without paging retain the old API; an advertised paging failure never retries the bulk read. These bounds do not guarantee a fixed heap peak or eliminate later renderer-resolution bottlenecks.

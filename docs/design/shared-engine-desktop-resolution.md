# Shared engine: desktop link-resolution adoption

## Implementation contract

Approach: one pure candidate-selection pipeline, with named `desktop-compatibility`
and `agent-strict` policies. Desktop `MetadataCache.getFirstLinkpathDest` and the
Node snapshot both call it. Keep their validation, result shapes, subpath handling,
and compatibility behavior unchanged. This is not a desktop snapshot backend.

Files: `src/wiki/link-candidates.ts`, `src/wiki/link-resolution.ts`, `src/wiki/snapshot.ts`, resolver unit tests,
fresh-Node proof, Electron navigation coverage, `.github/workflows/verify.yml`,
and this design/usage documentation. No new dependency or public API.

Key decisions: share exact/extension, relative, basename, and alias stage ordering;
policies retain desktop shortest-path/stable ties versus strict sorted ambiguity,
desktop literal paths versus strict normalization, and strict explicit-relative
isolation. Strict source validation and incomplete alias coverage remain intact.
Adapters keep their indices, file objects, lifecycle, and subpath processing.

Visual reference: not applicable; no visual or navigation behavior change.
Riskiest assumption: the stage abstraction preserves every existing short circuit.
Out of scope: search/index migration, mutations, cloud, synchronization, release,
merge, published SDK, and storage changes.

Done when: a real desktop navigation test, adapter parity tests, shared-stage
adoption tests, and fresh-Node proof demonstrate this capability; full desktop
gate/typecheck and both Node proofs pass; duplicate candidate orchestration is
removed. Performance guard is no >20% median warm resolver regression on repeated
synthetic runs (absolute timings reported); heap is diagnostic, not a hard gate.

## Verification prerequisite

PR verification uses the existing macOS / Node 25 stack: `npm ci`, typecheck,
both DOM-free Node proofs, and full `npm test` (unit, build, Electron). It runs on
all PR bases so stacked branches are covered, with read-only repository permission,
no publishing or deployment. Workflow glue is configuration; its executable
contract is covered by a unit test before the workflow is added.

## Rollout boundary

This is a read-only in-process refactor. No persisted schema or note bytes change.
Reverting the adoption commit restores prior resolution without data migration.
Passing tests does not authorize merge or release; hosted verification must be
observed separately after the stack is published.

## Actual consumers and policy boundaries

Desktop: reading-view click → `App.openLink` →
`MetadataCache.getFirstLinkpathDest` → `resolveFirstLinkpathDest` →
`selectLinkCandidates(..., "desktop-compatibility")`.

Node: `openLocalWikiSnapshot` → `createWikiSnapshot.resolve` →
`selectLinkCandidates(..., "agent-strict")`.

| Concern | Desktop compatibility | Agent strict |
| --- | --- | --- |
| Exact/extension priority | Literal identity before `.md` | Same |
| Relative fallback | Literal source-folder prefix | Normalized components |
| Explicit `./` / `../` | Literal lookup; legacy fallback | Relative-only, traversal rejected |
| Basename bucket | Shortest path, stable input ties | All candidates, sorted ambiguity |
| Alias bucket | First indexed entry, constant work | All candidates; coverage checked by snapshot |
| Index key | Lowercase | NFC and lowercase |
| Selector | Strip `#` / `^`, desktop handles headings | File result plus separate subpath status |

Common candidate selection owns path/extension, relative, basename and alias
stage ordering. Neither consumer has a second implementation of those stages.
Source validity, URL classification and incomplete alias coverage remain in the
strict wrapper; metadata parsing and captured bytes are unchanged.

Tests include a substitution of the shared selector's returned candidate and
verify both production consumers follow it. Fresh Node uses the desktop policy
over a synthetic lookup adapter; its results are compared to real MetadataCache
on the same fixtures. The same process also checks strict snapshot results.
The Electron test clicks an actual rendered alias and follows a duplicate-basename
link through `App.openLink`, then checks original fixture bytes are unchanged.

## Gate scope and limitations

The existing `.claude/hooks/pr-checklist-reminder.sh` emits a reminder after a
push; it is not a pre-push blocker. Its synthetic stdin pipe test verifies the
reminder output only. The new PR workflow runs real commands and fails on their
exit status. Required branch protection is repository administration and is not
changed here. No remote passing result is implied by local workflow validation.
The optional external companion-plugin fixture keeps its existing opt-in skip.

Workflow actions reuse the existing release workflow's v5 versions and Node25;
configuration was checked against the official
[checkout v5 documentation](https://github.com/actions/checkout/blob/v5/README.md)
and [setup-node v5 documentation](https://github.com/actions/setup-node/blob/v5/README.md).
No secrets or credential persistence are needed by the verification job.

## Reproducible verification

```sh
npm run typecheck
npm run proof:headless
npm run proof:local-wiki
npm run test:unit -- tests/unit/shared-link-resolution.test.ts tests/unit/pr-verification.test.ts
node scripts/run-shared-link-node-proof.mjs
npm test
node scripts/run-link-resolution-benchmark.mjs c45ebee9c172b4020620c5d63e53acbddff5d46b
node scripts/run-link-resolution-benchmark.mjs
```

The benchmark bundles the exact old resolver and snapshot with `git show` for
the immutable comparison revision, without changing branches. Each fresh Node
process warms and measures 9 samples of 140,000 resolutions over 2,000 synthetic
notes, plus a desktop alias bucket containing 2,000 candidates. Retained heap is
observed after explicit GC; it is a diagnostic, not a production memory claim.
Repeat before/after pairs in a quiet environment and report raw samples.
Keep command logs outside `test-results/`, which Playwright clears at startup.

### Measured local comparison (2026-09-11)

Node 25.9.0, macOS arm64. Three paired fresh-process runs, nine timed samples
per workload per process; reported aggregate is the median of the three process
medians. No samples were discarded, including a 223ms strict outlier in run 3.

| Workload | Baseline ms / 140k | Shared ms / 140k | Change |
| --- | --- | --- | --- |
| Desktop mixed tiers | 25.259 | 26.365 | +4.4% |
| Desktop 2,000-candidate alias | 29.556 | 31.321 | +6.0% |
| Strict snapshot mixed tiers | 123.622 | 125.970 | +1.9% |

Per-process medians (baseline → shared), in milliseconds:

- Desktop: 26.159 → 25.938; 25.259 → 28.708; 23.318 → 26.365.
- Large alias bucket: 31.192 → 31.453; 29.556 → 31.321; 29.488 → 30.260.
- Strict: 129.311 → 122.222; 123.330 → 125.970; 123.622 → 142.246.

Each paired median stayed within the 20% guard. Mixed desktop aggregate cost
was approximately 0.180 → 0.188 microseconds per resolution. Retained heap after
GC was about 10.13MB baseline versus 10.15MB shared; no large sustained increase
was observed. These are synthetic resolver measurements, not end-to-end UI or
production service latency guarantees. Raw samples are emitted by the command
and retained in the dedicated verification record.

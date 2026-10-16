# Public API parity audit — October 2026

This is technical evidence for the parity ledger, not a roadmap. The first
bounded pass assesses all 13 direct `CachedMetadata` properties against official
public documentation and tests. No production behavior changes in this pass.

## Reproducible source baseline

The checked-in inventory has **2,863 requirements**, not the older 2,856 documented
in `05-parity-ledger.md`: 179 help pages, 1,319 developer pages, 50 changelog deltas,
301 API declarations and 1,014 API members. The seven-row difference is inventory
drift (three help pages, one declaration, three members), not seven closed gaps.

Reproduction uses clean checkouts of:

| Corpus | Exact commit |
| --- | --- |
| [obsidian-help](https://github.com/obsidianmd/obsidian-help/tree/08ef563f07b78dd589f19b1583d089c1e2d2377c) | `08ef563f07b78dd589f19b1583d089c1e2d2377c` |
| [obsidian-developer-docs](https://github.com/obsidianmd/obsidian-developer-docs/tree/c56c7e770ba25dd0ea392aacf4588f9425970d36) | `c56c7e770ba25dd0ea392aacf4588f9425970d36` |
| [obsidian-api](https://github.com/obsidianmd/obsidian-api/tree/9abd9605ce081383674aae1ed111c456edde0688) | `9abd9605ce081383674aae1ed111c456edde0688` |

The release-note slice remains desktop 1.13.2–1.13.4. This is a fixed assessment
baseline; it does not claim to include every subsequent upstream release.
Generated `sourceLink` and baseline `ref` fields still use `master`; these commit
links are the immutable review references. A future generator change should make
source pinning machine-readable without accidentally changing canonical row IDs.

Clone each repository, check out its exact commit above, then run:

```sh
node scripts/generate-parity-ledger.mts \
  --help-root /path/to/obsidian-help \
  --developer-root /path/to/obsidian-developer-docs \
  --api-root /path/to/obsidian-api
node scripts/generate-parity-ledger.mts --check \
  --help-root /path/to/obsidian-help \
  --developer-root /path/to/obsidian-developer-docs \
  --api-root /path/to/obsidian-api
```

## Initial CachedMetadata findings (`0afe4ef` baseline)

The [pinned declaration](https://github.com/obsidianmd/obsidian-api/blob/9abd9605ce081383674aae1ed111c456edde0688/obsidian.d.ts)
and [developer property inventory](https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Reference/TypeScript%20API/CachedMetadata.md)
are assessed together. Each property has two independently addressable ledger
rows: its developer page and its declaration member. Both receive the same
bounded finding. The two container rows are `partial`, never a proxy for all
members being complete.

| Property | Status | Direct evidence / remaining limit |
| --- | --- | --- |
| `blocks` | missing | Explicit paragraph block ID produces no public blocks record. |
| `embeds` | partial | Wiki embed works; Markdown image syntax is absent. |
| `footnoteRefs` | verified | ID and exact span, code/definition exclusion and absent case tested. |
| `footnotes` | missing | Definition cache array absent; rendered footnotes do not satisfy it. |
| `frontmatter` | verified | YAML properties, aliases, malformed and absent cases tested. |
| `frontmatterLinks` | missing | Quoted wikilink property produces no public link array. |
| `frontmatterPosition` | missing | Public span absent; internal end offset is a different contract. |
| `headings` | partial | Heading text/levels and code exclusion tested; exact HeadingCache span assertions incomplete. |
| `links` | partial | Wiki syntax/positions work; Markdown links from upstream example absent. |
| `listItems` | partial | Ordered/unordered/tasks, nesting, source lines, block IDs and exclusion tested. Root items in one list incorrectly use different negative parents; upstream requires the shared negative first-item line. |
| `referenceLinks` | partial | Current full/collapsed entries contain display text, while upstream requires destination URLs; documented shortcut example is absent. |
| `sections` | partial | Heading/paragraph/list/YAML/code observed; callout and other block semantics unverified. |
| `tags` | partial | YAML/inline/nested tags and code exclusion observed; full position semantics unverified. |

Two properties verified, seven partial and four missing means **28 previously
unknown rows assessed: four verified, sixteen partial, eight missing**. This is
one API family, not 28 independent product capabilities. No existing help/service
status is removed or hidden; Publish, Web Clipper and other service gaps remain
visible in the ledger.

`tests/unit/parity-metadata-audit.test.ts` adds one ordinary contract check and
nine expected-failure diagnostics. The latter assert the desired upstream
behavior and pass only because the known gap still reproduces. They must lose
`.fails` when fixed. Their green runner status is not evidence of compatibility;
they support `missing`/`partial` findings only. Existing `metadata-cache.test.ts`
and `list-items.test.ts` provide the remaining passing behavior evidence.

## Source implementation follow-up

The stacked metadata package implements the nine reproduced gaps. Its current
bounded evidence and remaining limits are recorded in
[metadata-parity-implementation.md](../design/metadata-parity-implementation.md).
The table above preserves the initial audit snapshot; the generated ledger reads
the current evidence map. Original expected failures become ordinary regressions
only when their contracts pass. The implementation adds a separate expected-failing
nested-label grammar diagnostic.

## Next audit inventory

1. Fix the nine reproduced cache gaps with normal regression tests, then assess
   related `BlockCache`, `FootnoteCache`, `FrontmatterLinkCache`, `Pos` and
   `CacheItem` contracts. Re-evaluate every affected member, not only containers.
2. Audit `Vault` adapter/binary/process/event signatures and options against
   existing public-contract tests, retaining the documented ctime gap.
3. Audit metadata link resolution and lifecycle under rename/delete, duplicate
   basenames and persisted-cache hydration; existing MetadataCache method coverage
   does not prove every metadata shape.
4. Inventory remaining unknown developer/API families by public member count and
   plugin impact, then assess bounded families. Keep DOM claims tied to actual
   Electron evidence under the ledger policy.

## Verification

Targeted command:

```sh
npm run test:unit -- tests/unit/parity-metadata-audit.test.ts \
  tests/unit/metadata-cache.test.ts tests/unit/metadata-cache-public-contracts.test.ts \
  tests/unit/list-items.test.ts tests/unit/parity-ledger.test.ts tests/unit/parity-corpus.test.ts
```

Observed on the local host: six files, **118 ordinary passes and nine expected
failures**, no unexpected failures. `pm-config.md` has no compute-offload entry.
Full repository gates are recorded with the PR; these targeted results alone do
not claim full-suite verification. No UI behavior changes, so screenshots/manual
Electron verification are not applicable to this documentation/test audit.

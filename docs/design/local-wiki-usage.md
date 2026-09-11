# Internal read-only local wiki snapshot

This internal Node entry point inspects a trusted, user-selected folder without
Electron. It implements the [acceptance contract](headless-local-readonly.md)
and [ADR-0019](../adr/0019-readonly-local-wiki-snapshot.md). It is not a published
package, CLI product, MCP service or desktop replacement.

## Use from repository TypeScript

For a module directly under `scripts/`:

```ts
import { openLocalWikiSnapshot } from "../src/wiki/local-filesystem";

const result = await openLocalWikiSnapshot("./example-vault");
if (result.status === "error") {
  console.error(result.error.code); // no host path in diagnostic errors
} else {
  const wiki = result.snapshot;
  const files = wiki.listFiles();
  const read = wiki.readNote("folder/Source.md"); // captured text + metadata
  const matches = wiki.search("planning", 20);
  const link = wiki.resolve("folder/Source.md", "../Target#Heading");
  const outgoing = wiki.outgoing("folder/Source.md");
  const backlinks = wiki.backlinks("Target.md");
  console.log({ files, read, matches, link, outgoing, backlinks, info: wiki.info });
}
```

The adapter's `filesystem` option is a deterministic test seam. Queries never
access it. `createWikiSnapshot` is the internal capture boundary for adapter
inputs and synthetic collision fixtures. Editing/deleting disk files leaves
captured results unchanged; reopen to refresh. A scan is assembled over time,
not a globally atomic revision. Ordinary result data is recursively frozen;
note reads additionally clone metadata to isolate mutable YAML Set/Map values
and cycles. Binary YAML values are also cloned, since typed arrays cannot be
frozen. Caller mutation cannot affect later queries.

## Query semantics

Read results distinguish `ok`, `invalid`, `absent` and `unavailable`. Unavailable
notes retain identities. Attachments are identities only; no bytes are read.
Resolution distinguishes `resolved`, `ambiguous`, `missing`, `invalid`,
`external` and `unavailable`. Identities preserve spelling and are case-sensitive.

Resolver tiers: root path, source-folder path, normalized basename, then alias.
Each path tier tries literal identity before adding `.md`; the literal file wins
when both exist. Basename/alias matching uses NFC plus lowercase and returns all
candidates in the chosen tier. Explicit `./` and `../` targets use only relative
lookup. Paths are literal, never percent-decoded. URLs are classified, not fetched;
root-absolute paths and file URLs are invalid.

File and subpath resolution are separate. A missing/unknown heading still yields
a backlink to its resolved file; ambiguous files yield no confirmed backlink.
Alias fallback returns `unavailable` when discovery or frontmatter coverage
cannot establish a unique/absent alias, carrying known candidates and
`aliasCoverageComplete`. Exact file resolution still works.

No result claims a complete Markdown graph. The unchanged parser extracts
wikilinks/embeds. Diagnostics disclose unsupported ordinary Markdown links,
setext headings, paragraph block IDs, CRLF heading gaps, tilde-fence reference
uncertainty, problematic/BOM-prefixed frontmatter and the body scan cap. Heading validation
uses exact parsed ATX text; blocks use parsed list-item/section IDs. Uncertain
subpaths yield `unknown`. Graph responses carry global coverage including
unloaded notes and incomplete discovery; parser uncertainty does not invalidate
raw-text search.

Search trims input and scans literal raw text, including YAML, code and comments.
Case folding is **ASCII only** (`A`–`Z`); other characters match literally,
preserving original code-unit offsets near emoji and Unicode case expansions.
Each hit is the first match per note, ordered by path, with at most 250 code units
of surrounding line text. Default result limit: 50; maximum: 500; query maximum:
1,024 code units. `truncated` describes the result limit; `complete` separately
describes discovery and loaded-note coverage.

## Limits and filesystem behavior

Defaults: 10,000 eligible files, 50,000 visited directory entries, depth 32,
2 MiB per Markdown file and 64 MiB total attempted note bytes. Override `limits`
with positive safe integers. Root files are depth 1; depth 1 excludes root
subdirectories. Incremental enumeration closes on early termination. Visited
entries include exclusions, special files and directories. Capped membership
follows filesystem enumeration; query ordering is deterministic for that set.
One extra directory entry may be observed to establish truncation.

The byte budget reserves expected sizes even for failed reads. Allocation never
exceeds the stat-observed size, plus a separate one-byte growth probe. Invalid
UTF-8, oversize, read failures and observed changes yield unavailable identities.
BOMs are preserved in text and offsets. The parser's separate 300,000-unit cap
counts body JavaScript code units after successfully parsed mapping frontmatter.

Dot-prefixed segments and `node_modules` directories are excluded silently;
descendant symlinks and special files have diagnostics. A selected symlink root
canonicalizes once. Component checks, canonical containment, no-follow and
nonblocking open where supported, and pre/post-read identity checks reject
observed changes. These portable pathname checks are not an OS sandbox against
a hostile process repeatedly replacing ancestor directories. No writes, rename,
watcher, persistence, database, cloud, sync or public interface is included.

## Reproduce

```sh
npm run proof:local-wiki
npm run proof:headless
npm run typecheck
npm run test:unit -- tests/unit/local-wiki-snapshot.test.ts tests/unit/local-wiki-filesystem.test.ts tests/unit/local-wiki-node.test.ts
npm test
```

The proof audits runtime inputs and starts fresh Node without Electron, `window`
or `document`. It creates a disposable synthetic vault, exercises all seven
operations, checks ambiguity/partial parsing, and proves disk changes cannot
mutate results. Existing parser, types and desktop resolver are unchanged.

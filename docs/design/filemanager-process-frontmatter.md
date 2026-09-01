# FileManager.processFrontMatter bounded parity slice

**Date:** 2026-09-01

**Status:** Implemented as partial parity

**Parity IDs:** `DEV-7462e954af0c`, `API-MEMBER-8913f8abd51f`

## Contract and design

`FileManager.processFrontMatter(file, fn, options?)` accepts an extant Markdown
`TFile` owned by the current vault. It reads the latest text, parses the leading
YAML block using Geode's canonical frontmatter helper, invokes the synchronous
callback, safely serializes the result, and forwards changed text plus
`DataWriteOptions` to `Vault.modify`. `Vault.modify` is skipped when the
serialized bytes are unchanged; a no-op callback can still normalize
noncanonical YAML formatting. A callback or serialization error rejects without
calling `Vault.modify`.

All `FileManager` instances that target the same `Vault` share an in-memory
per-path promise queue. Same-path calls therefore serialize and read after the
preceding write, while calls for different paths remain independent. Rejected
operations are converted to a non-rejecting queue tail so later calls continue.
The file's identity, original path, existence, and Markdown extension are checked
before enqueue and again before its queued mutation starts.

The text transform preserves body bytes and reuses the source's LF or CRLF newline
style when rewriting or creating the YAML block. Malformed existing YAML follows
the established helper policy: the callback receives an empty object and a
successful mutation replaces the malformed block.

## Evidence

- `tests/unit/file-manager-process-frontmatter.test.ts` observes the public
  signature, ownership/type guards, no-op behavior, options forwarding,
  same-path serialization, independent paths, queue recovery, queued
  revalidation, and zero-write failures.
- `tests/unit/frontmatter-io.test.ts` observes create/update/remove behavior,
  malformed YAML policy, LF/CRLF and body preservation, prototype-sensitive
  keys, no-op behavior, and serializer failure.
- `tests/e2e/plugin-process-frontmatter.spec.ts` loads a real CommonJS hosted
  plugin, invokes commands that mutate and throw, observes Vault/metadata-cache
  refresh, checks disk persistence, and relaunches Geode to prove reload.

## Honest parity boundary

This is **partial**, not full atomic parity. The queue coordinates only
`processFrontMatter` calls in one Geode renderer runtime for the same `Vault`.
It does not coordinate direct `Vault.modify` calls, another Geode runtime, or an
external filesystem writer. Host-side compare-and-swap or locking would require
a larger Vault/adapter IPC design.

`DataWriteOptions` are forwarded unchanged to `Vault.modify`, but the current
Vault/host IPC does not apply requested `ctime` or `mtime` values. Timestamp
support remains a separate limitation.

The generated API spec and parity JSON entries are intentionally not edited in
this branch because open PR #154 already changes those files. After that PR is
resolved, reconcile `DEV-7462e954af0c` and `API-MEMBER-8913f8abd51f` to `partial`
using the evidence above, retaining both limitations verbatim.

# ADR-0050: Vault packs (`.vault`) for organization-provided starting vaults

**Date:** 2026-10-21
**Status:** Accepted
**Compass:** OPP-13

## Context

Two seeding paths exist today, and neither lets an organization hand a user a
ready-made vault as a single file:

- `src/main/starter-vault.ts` copies the bundled `resources/starter-vault/`
  folder. It is reachable only from the "Try the sample vault" button.
- ADR 0014 (`bootstrapFreshVault`) seeds one theme and a list of
  `owner/repo` GitHub plugins, but only if the deployer rebuilds the app with
  files in `resources/`, and only when the vault has no `.geode/` folder yet.

An enterprise wants to distribute initial notes, templates, settings, and
**private plugins** (not on GitHub) without forking or rebuilding Geode.

## Decision

1. **Format.** A vault pack is a zip file with the extension `.vault`:
   - `vault-pack.json` (root): `{ packVersion: 1, id, name, version,
     description?, minGeodeVersion?, plugins: [...], contentSha256 }`.
   - `vault/`: files copied into the new vault root. Under `.geode/`, only
     an allowlist is honored (`app.json`, `hotkeys.json`, `themes/`,
     `snippets/`, `plugins.json`); runtime state is never extracted.
   - `plugins/<id>/`: bundled plugin builds (`manifest.json`, `main.js`,
     optional `styles.css`), installed to `.geode/plugins/<id>/`.
   - A manifest plugin entry is either `{ id, source: "bundled", sha256 }` or
     `{ id, source: "github", repo: "owner/repo" }`, plus `enabled` and
     `locked` flags.
2. **One apply function.** `applyVaultPack(packSource, destRoot, opts)` in
   `src/main/vault-pack.ts`. `copyStarterVault` and `bootstrapFreshVault`
   become callers: the built-in starter vault is a pack, and ADR 0014 inputs
   are translated into an in-memory pack. GitHub plugins still go through
   `installCommunity`.
3. **Entry points.** Vault Hub "Create vault from pack…", opening or
   dropping a `.vault` file, a `--vault-pack <path>` launch flag, and a
   machine-level pack directory (beside the ADR 0002 policy path) listed on
   the hub as an organization vault. Authors get "Save vault as pack…".
4. **Safety.**
   - Extraction rejects absolute paths, `..` segments, symlinks, and
     entries outside `vault/` and `plugins/`; enforces total-size,
     file-count, and compression-ratio limits (zip-slip / zip-bomb).
   - Files are staged in a temp directory and moved into place atomically.
     A failed apply leaves no partial vault.
   - Bundled plugin `sha256` values are verified against `main.js` bytes.
   - ADR 0002 policy is enforced after install: a blocked plugin is
     installed disabled, never enabled.
5. **Consent (v1).** Every pack shows a confirmation screen before anything
   is written: name, version, file count, and each plugin with source and
   hash, with a clear warning that plugins run with full system access.
   The screen also warns when a bundled plugin reuses the id of a first-party
   plugin. Consent is enforced by the main process, not the renderer (see
   Implementation notes). The only path without the screen is
   `--vault-pack <absolute local path> --yes` on the **first** process launch,
   which is logged as an unattended apply; a pack handed to an already-running
   instance, or opened as a file, always shows the screen.
6. **Seed once.** A pack is applied only to an empty or new folder. Updating
   an existing vault from a newer pack is out of scope.

## Non-goals

Signing and trusted publisher keys (deferred; the manifest reserves a
`signature` field), pack updates/merging, remote pack URLs, per-user
templating.

## Options considered

| Option | Why rejected |
|---|---|
| Extend ADR 0014 build-time `resources/` seeding | Requires a rebuild per organization; cannot carry private plugins or arbitrary notes. |
| Tar or bare folder distribution | Zip is the common single-file format users and MDM tools already handle. |
| GitHub-only plugin references | Private enterprise plugins are the primary use case. |
| Silent install for managed machines | Needs a trust anchor (signing). Deferred rather than invented now. |

## Consequences

- Easier: one file carries an organization's whole starting vault.
- Riskier: importing a pack executes third-party plugin code once enabled.
  The consent screen and hash checks are the v1 mitigation.
- Revisit when: an organization needs silent deployment (add signing) or
  pack updates for existing vaults.

## Test plan

- Unit: manifest validation; zip-slip, symlink, oversize, and ratio
  rejection; `.geode/` allowlist; hash mismatch; atomic rollback on failure;
  policy-blocked plugin installs disabled; ADR 0014 inputs produce the same
  result as before.
- E2E: create a vault from a fixture pack through the hub (consent screen,
  notes present, bundled plugin enabled); declining writes nothing.

## Implementation notes

Where the implementation made a decision the sections above leave open:

- **`contentSha256`** is the sha256 of, for every file entry sorted by archive
  path, the line `<archive path>\0<sha256 hex of bytes>\n` (paths are
  `vault/<path>` and `plugins/<id>/<file>`). It detects corruption and edits;
  it is not a signature (`signature` stays reserved).
- **Per-file hashes.** `sha256` covers `main.js`. A bundled entry may also carry
  `files: { "manifest.json": ..., "styles.css": ... }`; when present, every
  shipped non-`main.js` file must be listed and match. Packs without `files`
  still import.
- **Strict layout.** Entries outside `vault/` and `plugins/` (including Finder's
  `__MACOSX/`) reject the pack. `plugins/<id>/` may hold only `manifest.json`,
  `main.js` and `styles.css`, and every directory must be declared in the
  manifest. Inside `vault/.geode/`, non-allowlisted files are skipped and
  counted. Path segments are compared NFC-normalized and case-folded: any
  `.geode` lookalike (`.GEODE`, or `.geode` below the root) rejects the whole
  pack, as do `:`, trailing dot/space, control characters and Windows reserved
  names in any segment. Duplicate detection uses the same folded key.
  `plugins.json` ids the manifest does not declare are ignored.
- **Limits.** 128 MiB total expansion, 64 MiB per entry, 20,000 entries, ratio
  limit 200:1 for entries over 1 MiB, and for every entry once the archive
  expands past 16 MiB. The ZIP container is parsed by a small in-repo reader
  over `node:zlib` (no dependency).
- **ADR 0014 inputs.** `default-plugins.json` entries carry no id until
  `installCommunity` resolves them, so `applyVaultPack` takes an
  `unresolvedGithubPlugins` option instead of manifest entries, plus
  `githubFailure: "skip"` to keep ADR 0014's "never block opening a vault".
  GitHub plugins install into the staging directory before the final move.
- **Starter vault.** It remains byte-identical to the pre-pack behavior: only
  `.geode/app.json` is honored from `resources/starter-vault/`, and empty
  folders are preserved.
- **`locked`** is validated and carried in the summary but is reserved: nothing
  enforces it and the consent screen does not show it.
- **GitHub plugins are unpinned.** A `github` entry resolves to whatever the
  repository's latest release is at apply time, so it is not covered by
  `contentSha256`. Pin or bundle plugins whose exact bytes matter; pinning is
  future work alongside signing.
- **Main-owned consent.** `inspect` accepts only a pack path main obtained for
  that window (its file picker, the organization directory listing, the
  launch argument, or a drop that main re-validates as an absolute local
  `.vault` file). It retains the inspected bytes under a random token bound to
  the requesting window, valid for 10 minutes, single use, and dropped when the
  window closes. `create` needs that token and a destination parent that main
  supplied (its folder picker or the default Documents location), and applies
  the retained bytes, not the file on disk. Dropped paths are the one input main
  cannot observe natively.
- **`--yes`.** Honored only from the first process's argv, only with
  `--vault-pack`, and only for an absolute local path (UNC paths, `//host`,
  URLs and relative paths never skip the prompt; UNC and URLs are refused
  outright). The unattended apply is written to the console and the
  diagnostics log.
- **Entry points.** Hub button, drop, `--vault-pack`, OS file association /
  `open-file`, the organization directory (`vault-packs/` beside the policy
  file, or `GEODE_PACK_DIR`; listed from each pack's manifest only and cached),
  and File > "Save Vault as Pack…". Stale `.geode-pack-*` staging folders older
  than an hour are swept from the default vault location at startup.

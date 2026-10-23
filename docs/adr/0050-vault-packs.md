# ADR-0050: Vault packs (`.vault`) for organization-provided starting vaults

**Date:** 2026-10-21
**Status:** Accepted
**Compass:** OPP-13
**Amended:** 2026-10-22 (pinned GitHub plugins)

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
     `{ id, source: "github", repo: "owner/repo", range?, minReleaseAgeDays? }`
     (see "Pinned GitHub plugins"), plus `enabled` and `locked` flags.
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
- **GitHub plugins without a `range` are unpinned.** An entry with no `range`
  resolves to whatever the repository's latest release is at apply time and is
  not covered by `contentSha256`. Pin it with a `range` (see "Pinned GitHub
  plugins" below) or bundle it. Pinning to exact bytes still needs signing.
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

## Pinned GitHub plugins

Amends the "GitHub plugins are unpinned" note above. Closes the gap a security
review flagged: a `github` plugin entry was "whatever is latest", so a
compromised or hijacked repository release reached every new vault.

### Manifest

A `source: "github"` entry gains two optional fields:

```json
{ "id": "my-plugin", "source": "github", "repo": "acme/my-plugin",
  "range": "^1.4.0", "minReleaseAgeDays": 3, "enabled": true }
```

- **`range`**: an npm-style semver range (`^1.4.0`, `~1.4`, `>=1.4.2 <2`,
  `1.x`, `1.2.3 - 2.0.0`, `^1 || ^3`). Matched by an in-repo implementation
  (`src/shared/semver-range.ts`, no dependency). A malformed range rejects the
  whole pack at validation. Absent means unpinned, and the entry behaves
  exactly as before: the repository's newest release, no age floor, no lock.
- **`minReleaseAgeDays`**: optional, 0 to 365, only valid with a `range`.

### Resolution

With a `range`, the resolver reads the repository's release list (not
`releases/latest`) and installs the **highest satisfying version**, not the most
recently published one. Drafts and releases whose tag is not semver are ignored.
Prereleases are excluded unless the range itself names a prerelease (npm's
rule: `>=1.4.0` never matches `1.5.0-beta.1`, `>=1.5.0-beta.1` does). The
installed manifest's own `version` must also satisfy the range, so a tag that
lies about its contents is refused.

### Minimum release age

Modeled on pnpm's `minimumReleaseAge`. Releases published less than N days ago
(by `published_at`) are skipped, so a freshly pushed malicious release has time
to be noticed and pulled. N is, in order of precedence:

1. `packs.minReleaseAgeDays` in the ADR 0002 managed policy, when set. It is
   authoritative: a pack cannot lower what an administrator raised, and `0`
   waives the wait.
2. The entry's `minReleaseAgeDays`.
3. The default, **3**.

If every satisfying release is younger than N, the install **fails** with an
error naming the newest candidate and its age; it never falls back to a young
release. An unreadable `published_at` counts as too young. Set 0 (policy or
entry) to take the newest satisfying release at once; the consent screen shows
"no release-age wait" when that is in force.

### Lock record

After a ranged plugin installs, Geode writes `.geode/plugins.lock.json` in the
new vault:

```json
{ "lockVersion": 1, "plugins": { "my-plugin": {
    "repo": "acme/my-plugin", "range": "^1.4.0", "minReleaseAgeDays": 3,
    "version": "1.4.2", "ref": "v1.4.2",
    "files": { "manifest.json": "<sha256>", "main.js": "<sha256>", "styles.css": "<sha256>" },
    "lockedAt": "2026-10-22T12:00:00.000Z" } } }
```

The file is written by Geode, never extracted from a pack: it is not on the
`.geode/` allowlist, so a pack's copy is skipped like any other runtime state.
It is written in the staging directory, so it appears atomically with the vault.
Unpinned plugins are not locked.

While the plugin stays installed, `installCommunity` (the single choke point
for pack apply, reinstall and the community auto-update path) consults the lock:

- **Within the range.** Resolving (including the renderer's update check) uses
  the locked range and age floor. A result outside the range is refused, even if
  the caller supplies a wider range or asks for a specific tag.
- **Same version, same bytes.** When the resolved version equals the locked
  version, the downloaded files must match the recorded sha256 values (reusing
  `validateArtifactHashes`, the path catalog certificates use), or the install
  is refused and the existing plugin directory is left untouched.
- **New version in range.** The install proceeds and the lock entry moves
  forward to the new version and hashes.
- **Uninstall releases the lock.** The entry only applies while
  `.geode/plugins/<id>/` exists; the next ranged install overwrites a stale
  entry. A corrupt lock file is an error, never ignored, since ignoring it would
  switch off the checks it exists for.

The lock protects against a re-published or altered release and against drifting
across a major version. It does not protect against an administrator-level local
attacker (they can edit the lock) or replace signing, which stays deferred.

### Managed machines

ADR 0002 gains an optional `packs` section. `packs.requireGithubRange: true`
(default off) refuses any pack GitHub entry without a `range`, at inspect and
apply, and refuses ADR 0014 `default-plugins.json` entries, which cannot carry
one. `packs.minReleaseAgeDays` is described above.

### Consent screen

For each GitHub plugin the screen shows **"Pinned range ^1.4.0"** or
**"Unpinned: latest release"** (the latter with a warning), what the plugin
resolves to right now, and the age rule. The resolved version is a best-effort
lookup made when the pack is inspected (8 second limit, no download); if it
fails or every candidate is too young, the screen says so instead. The version
actually installed is resolved again at apply time and may differ if a new
release appeared in between, but it always satisfies the same range.

### Consequences and tests

- Pack authors who want reproducibility add a `range`. Existing packs keep
  working unchanged.
- Applying a ranged pack needs the repository's releases to exist and be old
  enough; a brand new plugin release blocks a pack that depends on it for N days
  unless the author or administrator sets 0.
- Unit tests: `tests/unit/semver-range.test.ts` (range grammar, prerelease
  rule), `tests/unit/pinned-github-plugins.test.ts` (resolution, age cutoff and
  its no-eligible-release error, lock write, lock mismatch, out-of-range
  refusal, in-range update) and `tests/unit/vault-pack-pinning.test.ts`
  (manifest validation, legacy entries, policy refusal, forged lock skipped,
  consent rows, service annotation).

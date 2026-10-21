# Compass sync provider (`compass.docs`)

An internal (core) plugin, `src/renderer/internal-plugins/compass-sync/`, registers a `conditional-mutation-v1`
provider that syncs a vault's Markdown notes with the docs of a Compass workspace. It is a thin client over Compass's
sync REST API; Geode's coordinator keeps the baseline, journal, conflict and approval logic.

## Packaging

Same pattern as the iCloud provider: a core plugin toggled in Settings > Core plugins, registered through
`registerSyncProvider`, secrets in the app's secure storage (`host.secrets.app`, like the HTTPS hub token, because
internal plugins have no plugin secret capability). Requests use `pluginFetch`, i.e. main-process networking outside the
renderer CSP. A community plugin would also work but could not ship with the app or reuse the coordinator fix below.

## Configuration (Settings > Core plugins > Compass sync, then Settings > Sync)

| Field | Stored in |
|---|---|
| Compass URL, workspace id, extra header **name**, deletion mode | device state, per vault |
| Access token, extra header **value** | secure storage, per vault; never the vault or settings |

The extra header carries e.g. `x-vercel-protection-bypass` for preview deployments; the bearer token is always sent too.
Test connection runs the provider's `preflight`. Then choose **Compass** in Settings > Sync and preview, approve, run.

## Wire contract (`{baseUrl}/api/v1/workspaces/{ws}/sync/docs`)

- `GET scan?cursor&continuation&limit`: paged; follow `continuation` while `hasMore`; the last page's `cursor` is the
  checkpoint. Anything but `status: complete`, a null cursor, a mode change, or a `hasMore` page without a new
  continuation yields `partial`. `409 continuation_stale` restarts the walk (max 3 times). `404` is `unavailable`.
- `GET {id}?revision=` content; `409 revision_conflict` is a `SyncPreconditionError`.
- `POST` create, `PUT {id}` (`expectedRevision`, `operationKey`), `POST {id}/move`, `DELETE {id}?expectedRevision=`.
  Mutation paths end in `.md`; scan and response paths do not, so the provider adds and strips the extension.
- Folders are implicit: never created or deleted remotely (removing one is a no-op).
- Delta scans are supported but off by default (`useDelta`): a delta cannot show a rename's old path, and the
  coordinator would leave the stale local copy. Snapshots prove absence.

## Mapping and exclusions

Only exact-lowercase `.md` files are represented. `SyncProvider.excludePath(path, data?)` (new, optional, mirrors the
append-only hook) excludes everything else, UTF-8-invalid content, and the reserved `Geode Trash/` folder. The
coordinator applies it to local and remote files alike, so an excluded file is never uploaded, downloaded, or read as a
deletion. Remote entries a vault cannot hold (hidden segments, unsafe names) are left out of scans.

## Capabilities, trash and `binary`

`binary: true` is required by Geode; only UTF-8 text is ever sent and non-UTF-8 files are excluded. `trash: true` is
required to be recoverable. Compass `DELETE` is a hard delete, so by default `trash()` **moves** the doc to
`Geode Trash/<timestamp>-<id>/<original path>.md` (checked by `expectedRevision`), exactly as iCloud uses
`.geode-trash/`. The scan hides that folder, so other devices see a deletion. "Delete permanently" mode uses `DELETE`
and is not recoverable; the setting says so. A server-side soft delete would make the move unnecessary.

## Smoke test against a real deployment

```bash
COMPASS_URL=https://<deployment> COMPASS_WORKSPACE_ID=<id> COMPASS_TOKEN=cmp_... \
COMPASS_EXTRA_HEADER_NAME=x-vercel-protection-bypass COMPASS_EXTRA_HEADER_VALUE=<secret> \
npm run smoke:compass-sync          # add COMPASS_SMOKE_HARD_DELETE=1 to DELETE the probe instead of trashing it
```

It runs preflight, scan, create, create replay, read, update, stale update, move, trash and a final scan against a
throwaway `Geode Smoke <timestamp>/` folder and exits 1 on any failed check.

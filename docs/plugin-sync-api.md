# Plugin-provided vault sync API

Geode keeps ordinary vault files local and delegates only remote storage operations to plugins. This API is Geode-specific, not Obsidian compatibility.

```ts
const { Plugin } = require("geode");

class ExamplePlugin extends Plugin {
  onload() {
    this.registerSyncProvider({
      id: "example.remote",
      name: "Example Remote",
      capabilities: {
        binary: true,
        conditionalWrites: true,
        delta: true,
        completeSnapshots: true,
        atomicMoves: true,
        trash: true,
      },
      open: async ({ vaultId }) => createSession(vaultId),
    });
  }
}
```

## Conditional-mutation provider contract

`open()` returns a session with `scan`, `read`, `create`, `update`, `move`, `trash`, and `close`. Paths are NFC-normalized vault-relative `/` paths. Entries carry a stable `id`, opaque `revision`, kind, and path. A scan declares `snapshot` or `delta`; deletion from a delta requires an explicit tombstone. Partial, cancelled, and unavailable results fail closed.

Creates receive a durable `operationKey` and must be idempotent for it. Updates, moves, and trash receive `expectedRevision`; a mismatch rejects. Providers must observe every `AbortSignal` and release resources in `close()`.

For this contract, Geode rejects providers lacking binary payloads, conditional writes, an authoritative snapshot/delta mechanism, or recoverable trash. `maxFileSize`, when present, is checked before bytes are read. The optional discriminator is `protocol: "conditional-mutation-v1"`; omitting it preserves existing provider compatibility.

## Append-only history provider contract

Providers without atomic conditional mutation may implement `protocol: "append-only-history-v1"` instead. This is a different storage protocol, not permission to perform unsafe mutable writes. See [ADR 0016](adr/0016-causal-append-only-vault-history.md) and the exact TypeScript contract in `src/renderer/sync/history-types.ts`.

An append-only provider exposes `discover(signal)`, idempotent `createVault({name, operationId}, signal)`, and `open({binding, deviceId}, signal)`. Shared vault descriptors contain immutable schema/protocol, a shared vault UUID, a physical root ID, descriptor ID, and display name. Device identity and local paths never substitute for shared identity. A session exposes `scan`, `putBlob`, `readBlob`, `appendRecord`, and `close`. Capabilities declare `conditionalWrites: false`, `appendOnly: true`, binary/delta support, and a 104857600-byte file limit.

Records contain stable entity and operation UUIDs, exact causal parent record IDs, namespace, immutable file/folder kind, location, explicit deletion state, and a verified immutable blob reference for a live file. Concurrent heads are conflicts; timestamps never choose a winner. Folder identities survive renames. Missing/invalid dependencies and contradictory records remain pending/quarantined. Cursor reset unions history rather than replacing it; list absence never means deletion.

`scan.records` is an untrusted `unknown[]` boundary. Preserve duplicate variants and bounded malformed evidence with its proven record ID so Geode can quarantine the affected history. Never silently omit malformed records or repair an immutable object in place. Verify physical object identity/content on retries; actual blob SHA-256 and size are verified before publishing/applying. An unavailable or integrity-blocked run must not report up-to-date.

Optional `scan.blobAvailability` is an array of `{id, status: "available" | "pending" | "corrupt"}` physical-blob evidence. It is persisted atomically with history/cursor. Pending evidence blocks affected current heads even when local bytes match; available clears pending, but cannot clear corruption of the same immutable object. A later healthy head referencing a different blob is eligible despite an obsolete ancestor's corrupt blob. Unrelated components can continue. Missing physical objects never author tombstones.

The optional `excludePath(path, bytes?)` hook declares ownership exclusions. Geode checks it for outgoing content and incoming bytes before local application, shows the reason, and never turns exclusion into deletion. Providers with another document/task engine must exclude all managed paths, including eligibility before a link is created.

## Lifecycle and approval

Registration belongs to the plugin generation and disappears during unload. A vault can have one active provider. First run requires `app.sync.preview()` followed by `app.sync.run({ approvePreview: true })`; Geode rejects approval if the vault, provider, cursor, or plan changed. Settings → Sync exposes selection, preview/approval, pause/resume, conflicts, and errors.

Conditional and append-only providers share lifecycle arbitration from initial hydration through operation settlement. Disconnect cancels pending initialization and clears both device-local provider selections, including selections whose plugin is temporarily unregistered. Registering another plugin during activation or cleanup cannot silently select a second protocol.

## Secrets and state

Use `Plugin.loadSecret`, `Plugin.saveSecret`, and `Plugin.removeSecret`. The host namespaces calls to the owning plugin. Electron encrypts values outside the vault. Hosts without native secure storage reject writes instead of falling back to local storage or `data.json`.

Desktop community plugins are trusted code with renderer/Node access. Capability handles bind normal plugin calls to a renderer and namespace; they do not sandbox a malicious installed plugin or isolate its secrets from other privileged code. Install only trusted providers.

Baseline, cursor, preview fingerprint, and operation journal are device-local. Providers never write these, credentials, recovery state, or `.geode/sync` content remotely.

Use `Plugin.loadDeviceState(key)` / `saveDeviceState(key, value)` for provider reservation metadata. These keys are plugin-namespaced and persisted atomically with file/directory fsync outside the vault. Serialize each account/vault read-modify-write sequence; an atomic replacement is not compare-and-swap. Credentials and resumable session URLs belong in secret storage, not journals. Private filenames use bounded hashes; legacy short encoded keys are migrated on access.

Desktop `requestUrl` runs through main-process networking, preserving bytes/status/headers (including resumable `308` responses without `Location`). `text` and `json` decode lazily. Requests support a Geode `signal` extension, a 120-second timeout, bounded redirects, cross-origin credential stripping, and 100 MiB request/response caps. Errors omit URLs, tokens, and response bodies. No renderer `fetch` bypass is needed.

## Immutable setup, scope, and recovery

Settings → Sync requires explicit creation or selection of a discovered shared vault, followed by preview/approval. A new device's missing local files never author deletions. Current approved bindings restore on restart; legacy experimental state requires reconnect and preview. Content changes debounce for two seconds; remote polling runs every 30 seconds while enabled, with bounded retry backoff after failures. Pause, disconnect, unload, and vault switching cancel work. One desktop window owns synchronization for a local vault; all same-vault windows participate in editor preparation.

Portable configuration is a separate logical namespace, not raw `.geode` replication. Category files export only editor/display preferences, appearance/theme selection, validated hotkey overrides, and Daily Notes configuration. Theme/snippet assets use explicit allowlisted mapping. Community plugin data, enablement, credentials, workspace/session state, performance settings, and Web Viewer configuration are excluded. Turning a scope off does not delete its remote history.

The exact categories are `editor.json` (`readableLineLength`, `foldHeading`, `showLineNumber`, `showRibbon`, `showStatusBar`), `appearance.json` (`theme`, `baseFontSize`, `cssTheme`), `hotkeys.json` (version 1 with validated overrides), and `daily-notes.json` (`enabled`, `folder`, `format`, `template`). Fresh un-authored defaults adopt an existing remote category with a local preimage guard; locally authored differences remain conflicts.

Immutable conflicts show the exact displayed heads. Keep local or select an explicit version; resolution parents are exactly those displayed IDs, so an unseen branch remains conflicted. For blocked recovery, **Stop pending retries & preview** abandons retries while preserving frozen bytes/preimages. It is not rollback: a remote record may already exist. Review the new preview before continuing.

Frozen transfer bytes, per-operation intents/receipts, and recovery preimages remain device-local. The host checks content preimages under the same main-process vault lock as normal Geode mutations, uses durable staging/atomic replacement, and refuses nonempty-folder trash. Dirty Markdown/Canvas/Base writers block incoming changes. Failed refresh restores app controls but keeps stale views read-only until a successful retry. New/closed/switched windows invalidate a prepared participant set.

## Conditional-provider conflict and deletion policy

Both-changed and remote precondition failures preserve the local original and materialize remote bytes as a timestamped `.sync-conflict-*` sibling. Edit-versus-delete is a conflict. Geode never silently merges. Local and remote deletions use trash only; permanent purge is outside this contract.

Settings lists persisted conflicts with **Keep local** and **Accept remote** actions. Keep local sends the current local version (or preserves its deletion); Accept remote restores the remote version (or moves a remotely deleted local file to trash). A newer remote revision requires another sync before resolution. Remote copies remain available for manual recovery after resolution, and `.sync-conflict-<timestamp>` names are reserved and excluded from sync.

Local baselines use SHA-256 of transferred bytes. Planning hashes eligible files, including same-size/same-timestamp edits. Legacy metadata-only baselines are treated as changed rather than trusted for deletion. Upload recovery uses the journal's transferred-byte hash, never the current file's hash.

Electron uses a separate strict scan for synchronization. Unlike the explorer's tolerant list, it includes configuration files and fails on traversal/stat errors or unsupported symbolic links. These failures never prove deletion. Conflict resolution refreshes either a snapshot or the persisted index plus delta; new remote revisions supersede old conflict metadata while retaining recovery copies. Recovery verifies remote bytes before trusting an upload receipt's revision.

## Experimental beta limits

Use disposable vault copies only. Main-process guards serialize cooperative Geode writers, but external processes can still write in the final check-to-mutation interval; do not combine this beta with another filesystem sync engine. SHA-256 scanning reads eligible content and can be expensive. Files over 100 MiB are visibly blocked. Staging requires disk headroom, and disk failures stop before publication/application when preparing a batch.

Local staged bytes/journals/preimages and remote immutable history are retained; garbage collection is not part of this beta and storage usage grows. Keep enough space for retained history and recovery copies. Actual authenticated multi-client Drive behavior, independent authorization discovery, interrupted transfer durability, and a 24-hour soak remain release gates. Passing synthetic/provider tests does not satisfy those live gates; the Google provider remains disabled in the distributed beta until they pass.

Folder rename currently republishes descendant records whose derived paths change. This is conservative but adds work for large subtrees and can conflict with an independent child edit; the parent-only publication optimization is deferred.

The experimental Settings panel refreshes status after actions or reopening, not continuously during background sync. Reopen Sync to inspect newly detected background conflicts/errors. Version choices currently show record-ID prefixes rather than content previews; inspect the retained versions before resolving an unfamiliar conflict.

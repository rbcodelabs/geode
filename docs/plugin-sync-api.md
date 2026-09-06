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

## Provider contract

`open()` returns a session with `scan`, `read`, `create`, `update`, `move`, `trash`, and `close`. Paths are NFC-normalized vault-relative `/` paths. Entries carry a stable `id`, opaque `revision`, kind, and path. A scan declares `snapshot` or `delta`; deletion from a delta requires an explicit tombstone. Partial, cancelled, and unavailable results fail closed.

Creates receive a durable `operationKey` and must be idempotent for it. Updates, moves, and trash receive `expectedRevision`; a mismatch rejects. Providers must observe every `AbortSignal` and release resources in `close()`.

Geode rejects providers lacking binary payloads, conditional writes, an authoritative snapshot/delta mechanism, or recoverable trash. `maxFileSize`, when present, is checked before bytes are read.

## Lifecycle and approval

Registration belongs to the plugin generation and disappears during unload. A vault can have one active provider. First run requires `app.sync.preview()` followed by `app.sync.run({ approvePreview: true })`; Geode rejects approval if the vault, provider, cursor, or plan changed. Settings → Sync exposes selection, preview/approval, pause/resume, conflicts, and errors.

## Secrets and state

Use `Plugin.loadSecret`, `Plugin.saveSecret`, and `Plugin.removeSecret`. The host namespaces calls to the owning plugin. Electron encrypts values outside the vault. Hosts without native secure storage reject writes instead of falling back to local storage or `data.json`.

Baseline, cursor, preview fingerprint, and operation journal are device-local. Providers never write these, credentials, recovery state, or `.geode/sync` content remotely.

## Conflict and deletion policy

Both-changed and remote precondition failures preserve the local original and materialize remote bytes as a timestamped `.sync-conflict-*` sibling. Edit-versus-delete is a conflict. Geode never silently merges. Local and remote deletions use trash only; permanent purge is outside this contract.

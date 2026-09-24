# Geode Headless

Node 22+ ESM library for local Markdown wiki operations and immutable document content.
This package is prepared for publication; it is not published by the build or proof commands.

```ts
import { openWikiSession } from '@rbcodelabs/geode-headless/wiki';
const opened = await openWikiSession('/trusted/wiki');
if (opened.status === 'ok') {
  await opened.session.createNote('Hello.md', '# Hello');
  const note = opened.session.readNote('Hello.md');
}
```

The `catalog/cloud` entry exports the existing bounded Node DSQL/private Blob catalog
adapter. `wiki` does not load cloud dependencies. No Electron runtime is included.
Only the three named entry points are supported; internal paths are not exported.

## Documents

```ts
import { createDocumentStore } from '@rbcodelabs/geode-headless/documents';
import { createPrivateBlobStore } from '@rbcodelabs/geode-headless/catalog/cloud';

// Authorize the caller for workspaceId before constructing/using this store.
const objects = createPrivateBlobStore({
  prefix: 'preview_documents/', token: process.env.DOCUMENT_BLOB_TOKEN!,
  maxObjectBytes: 1_048_576, maxReadBytes: 10_485_760,
  maxUploadedBytes: 23_068_672, maxOperations: 110, timeoutMs: 10_000,
  beforeWrite: async pathname => { await recordCleanupInventory(pathname); },
});
const store = createDocumentStore({ namespace: workspaceId, objects, maxContentBytes: 1_048_576 });
const saved = await store.putContent('# A document');
if (saved.status === 'ok') {
  // Commit reference + metadata + expected revision + history atomically in your DB.
  await commitDocumentReference(saved.reference);
  const content = await store.readContent(saved.reference);
}
```

The callbacks and workspace identifier above belong to the embedding application.
Persist the exact reference JSON server-side: version, namespace, SHA-256 digest and
UTF-8 byte length. Treat it as opaque. It is not a signed authorization capability.
Never accept a storage key or URL from an API caller. Namespace identifiers match
`[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. Every read checks namespace before storage access,
then verifies digest and length. Exact BOM, whitespace and Unicode are preserved;
unpaired UTF-16 surrogates are refused because UTF-8 encoding would lose information.

Repeated/concurrent identical writes reuse the same immutable object. Upload failures
are accepted only when a verified reread proves the bytes arrived; successful uploads
are also read back before a reference is returned. The embedding application owns
operation IDs, authorization, current revision, history and orphan cleanup. The SDK
never updates a mutable document head or creates database schemas.

Results distinguish `invalid`, `namespace-mismatch`, `oversized`, `missing`,
`integrity-failure`, and `unavailable`; writes omit read-only statuses. Do not turn
these into an empty document. Invalid factory options throw before any I/O.
Storage adapters must bound time and bytes; the supplied private Blob adapter does so
and records every possible upload through `beforeWrite` before issuing the request.
Budgets are per handle and include SDK retry reservations.

## Build and prove

From the Geode checkout, run `npm run build:headless`, then `npm pack ./packages/headless`.
`npm run proof:headless-package` installs a packed artifact in a temporary independent
consumer, exercises all entry points and typechecks under NodeNext. Set
`GEODE_PROOF_NODE` to a Node 22 binary to verify the minimum supported runtime.
Publication requires separate release authority and confirmed npm scope ownership.

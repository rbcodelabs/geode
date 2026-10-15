# PDF viewer — P1

Open a PDF from the file explorer or an internal vault link to view a read-only PDF tab. The toolbar provides previous/next page, a page number, zoom, and Fit width. The PDF text layer supports native browser selection. Internal links may specify `#page=2`; the selected file and successfully rendered page are restored with the workspace.

The desktop host authorizes bytes inside the current vault. External roots and hosts without the dedicated PDF resource capability show an explicit unsupported state. PDF source bytes are never rewritten by the viewer. PDF links, forms, scripting, XFA, annotations, search, thumbnails, exporting, and shared Markdown/Canvas embeds are outside this implementation checkpoint.

## Limits and recovery

P1 admits four live PDF documents per App, including loading or retained failed documents. A fifth tab shows a capacity message and Retry without reading bytes or creating a viewer frame. Close another PDF, then retry. This policy limits document admission; it does not guarantee a global decoder CPU or memory ceiling.

Documents are limited to 64 MiB, 1,000 pages, and eight million rendered pixels per page. Page input must name an existing page. A page request becomes saved state only after a successful render. Corrupt documents, unavailable resources, blocked or invalid WASM, and timeouts show an error and Retry.

Closing a document cancels publication, requests native-read cancellation, closes its private port, and removes its owned frame after bounded decoder disposal. A document lease remains held until an actual native read settles. Cancellation checks run between file chunks; they do not abort a stalled operating-system read. Root teardown waits for these reads before releasing their admission budget.

## Isolation and implementation evidence

PDF.js 6.4.299 and matching codec/font/CMap resources are bundled locally. A fixed cross-origin, Node-free iframe owns the display and a real Node-free worker. A private validated MessagePort carries copied authorized bytes and bounded view state. Neither viewer nor worker receives a vault path or a host I/O bridge. Both have their own restrictive content security policies; operational asset adapters alone are not a security sandbox. JavaScript codec fallbacks and fake-worker parsing are disabled.

See [ADR 0034](../adr/0034-pdf-viewer-and-embeds.md) for the accepted boundary, rejected direct-worker approach, proof conditions, and tradeoffs. The [engine capture evidence](../screenshots/pdf-engine/README.md) records actual synthetic fixture decoding and isolation proof. Product UI tests are in `tests/e2e/pdf-viewer.spec.ts`; authored tests are not evidence of a completed run. Full application regression gates and shared embed integration remain pending at this checkpoint.

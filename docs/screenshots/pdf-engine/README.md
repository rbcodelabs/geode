# PDF engine isolation proof captures

Captured 2026-10-15 with Electron 42.10.0 and pinned PDF.js 6.4.299 at source `bb1a25b`, using the actual desktop preload/preferences and the fixed Node-free viewer origin. These fictional fixture captures show the actual engine output, not the future product toolbar or application UI.

Run after `npm run build`:

```
./node_modules/.bin/electron scripts/proof-pdf-isolation.cjs
./node_modules/.bin/electron scripts/proof-pdf-isolation.cjs --bad-wasm
./node_modules/.bin/electron scripts/proof-pdf-isolation.cjs --blocked-wasm
```

All three commands exited zero with explicit assertions. The base proof checks production parent bridge presence, frame/worker isolation, independent CSP enforcement against native APIs, zero probe-server connections, eleven rejected invalid initialization/private-port/load cases, one accepted initialization and disposal acknowledgment. Source/build hashes are printed with results. Separate unit tests isolate source and origin predicates; the native forged-window probe exercises their combined rejection.

- `FieldGuide.png`: page two of the three-page fixture, with the exact expected text; native TextLayer text was programmatically selected.
- `CMYK.png`: the packaged ICC/QCMS rendering. The sampled RGB agrees within three levels with independent LittleCMS conversion through the pinned profile.
- `JPX.png`: the generated lossless color checkerboard decoded with OpenJPEG WASM. Pixel samples match the authored colors.
- `JBIG2.png`: the generated black/white checkerboard decoded with JBIG2 WASM. Sample positions agree with the Poppler rendering.
- `CMap.png`: text using the packaged predefined CMap and local font fallback, extracted/selected as `AB`.

All five images were visually inspected; all 4×4 tile centers of both checkerboards were additionally checked from the captured PNGs. Corrupt packaged WASM and CSP-blocked WASM each failed with CompileError before document readiness, rather than succeeding with missing images. These checks do not establish application keyboard interaction, lifecycle integration or PDF parity.

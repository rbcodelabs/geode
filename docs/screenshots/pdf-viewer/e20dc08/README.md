# Actual product run — e20dc08

These four actual Electron 42.10 captures come from source/test head `e20dc08`, using fictional local PDF fixtures. Command: `PDF_SCREENSHOTS=1 ./node_modules/.bin/playwright test tests/e2e/pdf-viewer.spec.ts --retries=0`.

All three flows passed in 8.3 seconds: navigation/zoom/native keyboard selection/source hash, capacity/retry, and strict page-3 persistence/restart plus malformed-layout fallback/restart. Desktop, live dark theme, and corrupt-file Retry states were inspected. The first flow also exercised ready-frame ownership hold/resume, but its held-state assertion lacked an explicit host port receipt barrier; deterministic unit coverage supplied that stronger witness.

`narrow.png` records a discovered usability defect: at 920px app width the compact label's zero font size also hides the page input numeral. This historical image is evidence of that defect, not an approved final narrow state. A CSS correction and new computed-font/visible-value browser assertion require a subsequent actual capture.

The host window's existing security warning is distinct from the isolated viewer/worker content security policies. Independent production-preload isolation/native-network/codec proof is documented with the engine captures. This product run does not establish shared Markdown/Canvas embeds, full regression completion, or complete PDF parity.

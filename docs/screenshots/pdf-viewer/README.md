# PDF tab product evidence

`desktop-selection-0a82b66.png` is an actual Electron 42.10 capture from source `0a82b66`, using the fictional FieldGuide PDF. It shows page 2, the native tab/toolbar, and native keyboard text selection. The targeted run passed the navigation/zoom/selection/source-hash flow and the shared four-document capacity/retry flow; the third flow failed its saved-page assertion before restart. This capture does not establish restoration or complete PDF parity.

Command: `PDF_SCREENSHOTS=1 ./node_modules/.bin/playwright test tests/e2e/pdf-viewer.spec.ts --retries=0`.

The capture was inspected against the approved compact native reference. The synthetic page content is rendered by the pinned PDF engine; the surrounding Geode chrome is the real application. The prototype archive and independent isolation/codec evidence remain distinct from this product UI evidence.

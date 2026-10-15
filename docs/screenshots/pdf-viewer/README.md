# PDF tab product evidence

The current `desktop.png`, `dark.png`, `narrow.png`, and `error.png` are actual Electron 42.10 captures from frozen source/test head `398693c`, using fictional local PDFs. All four were inspected against the approved compact native reference. The narrow page input visibly shows page 2; its accessible label remains Page number.

Command: `PDF_SCREENSHOTS=1 ./node_modules/.bin/playwright test tests/e2e/pdf-viewer.spec.ts --retries=0`. All three flows passed in 8.5 seconds. Assertions cover page/zoom/rapid navigation, actual native keyboard text selection, unchanged PDF source hash, Node-free frame/blocked parent DOM, four-document admission with no fifth read, close/retry, live dark appearance, the narrow input's value and font size, corrupt-file error/Retry, strict saved page-3 restoration, and malformed saved-page fallback/restoration. The ownership witness waits for receipt of an actual child state message while held before proving saved state remains unchanged, then proves subsequent states are accepted after resume.

The white PDF paper in the dark capture preserves the authored document; surrounding chrome follows the application theme. Independent production-preload isolation/native-network/codec proof is recorded with the [engine captures](../pdf-engine/README.md). Full application regression and shared Markdown/Canvas embed integration remain separate gates; these product captures do not establish complete PDF parity.

Historical evidence is preserved: `desktop-selection-0a82b66.png` records native selection in the earlier two-pass/one-failure run. [The e20dc08 captures](e20dc08/README.md) record the first three-pass run and the narrow input defect discovered during inspection; they are not the final narrow state.

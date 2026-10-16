> Historical evidence imported from `d475ef94607bf1642d2ca5e93ddab89ee95e9268`. Its prior checks do not verify prerequisite A. See [current delivery provenance](../../design/native-prerequisite-delivery.md) and the fresh frozen-source gate results.

# Retained Canvas media: QA extension

Task69e5c4b9-fd6f-4171-bccf-106aa85782f4; native Solution
ac76d20b-1183-4698-af07-21e3d0560dfe. Test-only child of the reviewed background
proof9e3e0ea, on unchanged production source from ef18b43a23947c16564e55ece845f08b09215216.

This extends the per-node resource oracle to three additional failing full-run
cases: detached initial media, authored file cards, and group selection actions.
Each keeps every original menu/picker/selection/camera/schema/vendor/render/reload
assertion; only obsolete global revoke-on-unrelated-render assumptions change.
The unchanged restored-media test in canvas-file-card remains in the run too.

Unchanged nodes must keep the exact connected owning DOM node, actual child media
node where applicable, and computed CSS/source blob URL. The exact active tracked
URL set must equal the actual presentation URLs. PNG gets a fresh native
Image.decode positive with 1x1 dimensions. Audio uses the valid731-byte synthetic
MP3 fixture documented under tests/e2e/fixtures/media: fresh native audio must fire
loadeddata with finite positive duration. No autoplay or audible playback claim
is made. The previous ID3-only audio headers could not support a positive oracle.
The invalid short Clip.mp4 fixture remains picker-only; video decoding is untested.

Superseded/removed group backgrounds and actual UI tab/navigation closes require
exactly one revocation per observed URL, disconnected old owning/media nodes, and
a fresh native image/audio rejection. An audio probe timeout throws; it cannot
satisfy the negative oracle. A negative console/request event is excluded only
for that exact known already-revoked probe URL; unrelated errors still fail.

Existing renderer reload checks remain. Added real UI closure and actual saved
layout barriers ensure the old renderer retires all resources before reload, and
the new tracker is installed before Canvas opens. Additional disk-byte assertions
ensure those lifecycle proofs do not write Canvas data. Resource proof snapshots
remain on disk even if a later assertion fails.

Pre-run candidate validation: app typecheck, isolated test-file typecheck, build,
and Playwright discovery (six cases in five files) pass locally. Electron has not
run on this extension yet; root review and a coordinator slot are required. The
prior65b actual2/2 proof remains bounded to its original two flows. The full-run
failure artifacts are preserved in the coordinator's combined-a84 archive; no
resource leak clearance for these three additional flows is claimed before the
actual run.

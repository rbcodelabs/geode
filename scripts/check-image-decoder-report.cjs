const assert = require("node:assert/strict");
const IMAGE_DECODER_SOURCE_PATHS = Object.freeze([
  "src/main/image-resource.ts", "src/main/image-ipc.ts", "src/shared/image-cleanup.ts", "src/renderer/image-inspection/image-session.ts",
  "scripts/image-decoder-proof/native-helper.ts", "scripts/proof-image-decoder.cjs", "scripts/run-image-decoder-proof.cjs",
  "scripts/check-image-decoder-report.cjs", "scripts/image-decoder-proof/generate-fixtures.py",
  "tests/e2e/image-decoder-lifecycle.spec.ts", "scripts/large-vault-runner-lib.mjs",
]);
const families = ["png", "jpeg", "gif", "webp", "bmp", "avif"];
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const names = new Set(["readStart", "readSettled", "urlCreate", "urlRevoke", "decodeStart", "decodeSettled", "publish", "closeStart", "closeSettled", "hide", "clear", "release", "cancel", "cancelSettled", "revokedProbeRejected", "load", "error", "intentB", "intentC", "decoder-source-retained", "decoder-source-cleared", "decoder-listeners-released", "decoder-reference-released"]);
const sorted = value => Object.keys(value).sort();
const exactly = (events, name) => {
  const selected = events.filter(event => event.name === name);
  assert.equal(selected.length, 1, `one ${name}`); return selected[0];
};
const before = (left, right) => assert.ok(left.seq < right.seq, `${left.name} before ${right.name}`);
function events(value) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 1000, "bounded native ledger");
  value.forEach((event, index) => {
    assert.equal(event.seq, index + 1, "contiguous callback sequence");
    assert.ok(names.has(event.name), "known native ledger event");
    assert.ok(sha(event.id), "64hex callback request ID");
  });
  return value;
}
function ownedDecode(list, read, usedURLs, outcome, dimensions) {
  const created = exactly(list, "urlCreate"), start = exactly(list, "decodeStart"), settled = exactly(list, "decodeSettled"), revoked = exactly(list, "urlRevoke");
  assert.ok(typeof created.url === "string" && created.url.startsWith("blob:"), "owned blob URL");
  assert.ok(!usedURLs.has(created.url), "unique URL ownership"); usedURLs.add(created.url);
  assert.equal(start.connected, false, "decoder begins detached"); assert.equal(start.srcAttribute, created.url);
  before(exactly(list, "readSettled"), created); before(created, start); before(start, settled); before(created, revoked);
  for (const event of list) {
    assert.equal(event.id, read.id, "captured request identity");
    assert.equal(event.path, read.path, "captured request path");
    if (event.url !== undefined) assert.equal(event.url, created.url, "exact owned URL");
  }
  assert.ok(["fulfilled", "rejected"].includes(settled.outcome), "actual Promise settlement outcome");
  if (outcome) assert.equal(settled.outcome, outcome);
  if (settled.outcome === "fulfilled") {
    assert.equal(settled.width, dimensions.width); assert.equal(settled.height, dimensions.height);
    assert.equal(settled.currentSrc, created.url, "actual decoded URL");
  }
  const cleared = exactly(list, "decoder-source-cleared"), listeners = exactly(list, "decoder-listeners-released"), released = exactly(list, "decoder-reference-released");
  before(settled, cleared); before(cleared, listeners); before(listeners, released);
  assert.equal(cleared.srcAttribute, null, "actual private decoder source cleared after settlement");
  const cancel = list.find(event => event.name === "cancel");
  if (cancel) {
    const retained = exactly(list, "decoder-source-retained"), ack = exactly(list, "cancelSettled");
    before(start, retained); before(exactly(list, "clear"), retained); before(retained, settled); before(retained, exactly(list, "release"));
    assert.equal(retained.srcAttribute, created.url); assert.equal(retained.connected, false); assert.equal(retained.settled, false);
    before(released, ack); assert.equal(ack.decoderPresent, true); assert.equal(ack.cleanupUncertain, false);
  } else assert.equal(list.filter(event => event.name === "decoder-source-retained").length, 0);
  return { created, start, settled, revoked, cleared, listeners, released };
}
function presentationCleanup(list, revoked, published = false) {
  const hide = exactly(list, "hide"), clear = exactly(list, "clear"), release = exactly(list, "release");
  before(hide, clear); before(clear, release); if (revoked) before(release, revoked);
  assert.equal(clear.srcAttribute, null, "actual source attribute removed");
  assert.equal(hide.presentationPresent, published); assert.equal(clear.presentationPresent, published, "published clear and absent presentation are distinct");
}
function nativePublication(event, fixture, url) {
  assert.equal(event.width, fixture.width); assert.equal(event.height, fixture.height);
  assert.equal(event.currentSrc, url, "actual published URL"); assert.equal(event.connected, true, "actual image remains connected at publication");
}
function familyLedger(row, usedIDs, usedURLs, fixture) {
  const all = events(row.events);
  assert.ok(all.every(event => ["positive", "beforeDecode", "pendingClose"].includes(event.scenario)), "exact scenario identity");
  for (const scenario of ["positive", "beforeDecode", "pendingClose"]) {
    const list = all.filter(event => event.scenario === scenario);
    assert.ok(list.every(event => event.path === fixture.path), "exact manifest fixture path on every family callback");
    const read = exactly(list, "readStart"), readSettled = exactly(list, "readSettled");
    assert.ok(!usedIDs.has(read.id), "fresh actual request ID"); usedIDs.add(read.id);
    assert.ok(list.every(event => event.id === read.id), "case request identity"); before(read, readSettled);
    const close = exactly(list, "closeStart"), closed = exactly(list, "closeSettled"); before(close, closed); before(readSettled, closed);
    for (const name of ["hide", "clear", "release"]) { const event = exactly(list, name); before(close, event); before(event, closed); }
    if (scenario !== "positive") {
      const cancel = exactly(list, "cancel"), ack = exactly(list, "cancelSettled");
      before(close, cancel); before(cancel, ack); before(ack, closed);
    } else assert.equal(list.filter(event => event.name === "cancel" || event.name === "cancelSettled").length, 0);
    if (scenario === "beforeDecode") {
      assert.equal(list.filter(event => ["urlCreate", "urlRevoke", "decodeStart", "decodeSettled", "publish", "decoder-source-retained", "decoder-source-cleared", "decoder-listeners-released", "decoder-reference-released"].includes(event.name)).length, 0, "no pre-admission native work");
      assert.equal(exactly(list, "cancelSettled").decoderPresent, false);
      presentationCleanup(list); before(read, close); before(close, readSettled); continue;
    }
    const decoded = ownedDecode(list, read, usedURLs, scenario === "positive" ? "fulfilled" : undefined, row);
    presentationCleanup(list, decoded.revoked, scenario === "positive");
    before(decoded.settled, closed); before(decoded.revoked, closed); before(decoded.released, closed);
    if (scenario === "positive") {
      const publish = exactly(list, "publish"); before(decoded.settled, publish); before(publish, close); before(close, decoded.revoked);
      nativePublication(publish, row, decoded.created.url);
      before(decoded.cleared, exactly(list, "clear"));
      before(closed, exactly(list, "revokedProbeRejected"));
    } else {
      before(decoded.start, close); before(close, decoded.settled);
      assert.equal(list.filter(event => event.name === "publish").length, 0, "no obsolete publication");
    }
  }
}
function twoReadLedger(value, usedIDs, usedURLs, kind, fixture) {
  const all = events(value), reads = all.filter(event => event.name === "readStart"); assert.equal(reads.length, 2);
  const [a, b] = reads;
  assert.deepEqual(reads.map(event => event.path), kind === "latest" ? ["A.png", "C.png"] : ["corrupt.png", "recovery.png"]);
  for (const read of reads) { assert.ok(!usedIDs.has(read.id), "fresh control request ID"); usedIDs.add(read.id); }
  assert.ok(all.every(event => event.id === a.id || event.id === b.id), "control callback identity");
  const first = all.filter(event => event.id === a.id), second = all.filter(event => event.id === b.id);
  const da = ownedDecode(first, a, usedURLs, undefined, fixture), db = ownedDecode(second, b, usedURLs, "fulfilled", fixture);
  presentationCleanup(first, da.revoked); presentationCleanup(second, db.revoked, true);
  before(a, exactly(first, "readSettled")); before(b, exactly(second, "readSettled")); before(da.settled, b);
  before(da.revoked, b); before(da.released, b);
  for (const name of ["hide", "clear", "release"]) before(exactly(first, name), b);
  assert.equal(first.filter(event => event.name === "publish").length, 0);
  const publish = exactly(second, "publish"), close = exactly(second, "closeStart"), closed = exactly(second, "closeSettled");
  nativePublication(publish, fixture, db.created.url);
  before(db.cleared, exactly(second, "clear")); before(db.released, closed);
  before(db.settled, publish); before(publish, close); before(close, db.revoked); before(db.revoked, closed);
  for (const name of ["hide", "clear", "release"]) { const event = exactly(second, name); before(close, event); before(event, closed); }
  if (kind === "latest") {
    const cancel = exactly(first, "cancel"), ack = exactly(first, "cancelSettled"); before(da.start, cancel); before(cancel, ack); before(ack, b);
  } else { assert.equal(da.settled.outcome, "rejected"); before(da.revoked, b); }
}
function validateImageDecoderReport(report, expected) {
  assert.match(expected.commit, /^[0-9a-f]{40}$/); assert.match(expected.runId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(report.schema, 2); assert.equal(report.completed, true); assert.equal(report.failure, null);
  for (const key of ["commit", "runId", "fixtureManifestSha256", "bundleSha256", "readerBundleSha256", "preloadSha256"]) assert.equal(report[key], expected[key], key);
  for (const key of ["fixtureManifestSha256", "bundleSha256", "readerBundleSha256", "preloadSha256"]) assert.ok(sha(expected[key]), key);
  assert.deepEqual(sorted(expected.sourceHashes), [...IMAGE_DECODER_SOURCE_PATHS].sort());
  assert.ok(Object.values(expected.sourceHashes).every(sha)); assert.deepEqual(report.sourceHashes, expected.sourceHashes);
  assert.equal(report.runtime.electron, expected.electron); assert.match(report.runtime.node, /^\d+\.\d+\.\d+$/);
  assert.equal(report.runtime.platform, expected.platform); assert.equal(report.runtime.processSandboxDisabled, expected.processSandboxDisabled);
  assert.deepEqual(report.preferences, expected.preferences);
  assert.deepEqual(report.helperInputs, ["scripts/image-decoder-proof/native-helper.ts", "src/renderer/image-inspection/image-session.ts"]);
  assert.deepEqual(report.readerInputs, ["src/main/image-resource.ts", "src/shared/image-cleanup.ts"]);
  assert.equal(report.remainingImageElements, 0); assert.deepEqual(report.network, []);
  assert.deepEqual(expected.fixtures.map(row => row.family), families); assert.equal(report.families.length, 6);
  assert.deepEqual([...report.families.map(row => row.family)].sort(), [...families].sort());
  const usedIDs = new Set(), usedURLs = new Set();
  for (const fixture of expected.fixtures) {
    const row = report.families.find(row => row.family === fixture.family);
    for (const key of ["family", "mime", "bytes", "sha256", "width", "height"]) assert.equal(row[key], fixture[key], `${fixture.family} ${key}`);
    assert.deepEqual(row.reader, { mime: fixture.mime, bytes: fixture.bytes, sha256: fixture.sha256 });
    assert.deepEqual(row.positive, { settled: true, published: true, width: fixture.width, height: fixture.height, closed: true });
    assert.deepEqual(row.beforeDecode, { closed: true, decodeCalls: 0, urlCreates: 0, publications: 0 });
    assert.deepEqual(row.pendingClose, { decodeStarted: true, pendingAtClose: true, decodeSettled: true, closeSettled: true, presentationSourceRemoved: true,
      decoderSourceRetainedWhilePending: true, decoderSourceRemovedAfterSettlement: true, decoderDetached: true, publications: 0, outcome: row.pendingClose.outcome });
    assert.ok(["fulfilled", "rejected"].includes(row.pendingClose.outcome));
    assert.deepEqual(row.urls, { created: 2, revoked: 2, unique: true, freshRevokedDecodeRejected: true }); assert.equal(row.sourceUnchanged, true);
    familyLedger(row, usedIDs, usedURLs, fixture);
    const pending = row.events.find(event => event.scenario === "pendingClose" && event.name === "decodeSettled");
    assert.equal(row.pendingClose.outcome, pending.outcome);
  }
  const corrupt = report.controls.corruptPNG;
  for (const key of ["path", "mime", "bytes", "sha256"]) assert.equal(corrupt[key], expected.corruptPNG[key]);
  for (const key of ["headerAdmitted", "rejected", "recovered", "closed"]) assert.equal(corrupt[key], true);
  const png = expected.fixtures.find(row => row.family === "png");
  twoReadLedger(corrupt.events, usedIDs, usedURLs, "corrupt", png);
  const latest = report.controls.latest;
  assert.deepEqual(latest.readPaths, ["A.png", "C.png"]); assert.equal(latest.aSettledBeforeCRead, true);
  assert.equal(latest.obsoletePublications, 0); assert.equal(latest.closed, true); assert.equal(latest.urlsRevokedOnce, true);
  twoReadLedger(latest.events, usedIDs, usedURLs, "latest", png);
}
exports.IMAGE_DECODER_SOURCE_PATHS = IMAGE_DECODER_SOURCE_PATHS;
exports.validateImageDecoderReport = validateImageDecoderReport;

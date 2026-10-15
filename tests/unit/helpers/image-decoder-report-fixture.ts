/** Synthetic validator/wrapper fixtures only; never native execution evidence. */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { IMAGE_DECODER_SOURCE_PATHS } = require("../../../scripts/check-image-decoder-report.cjs");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = fs.readFileSync("tests/fixtures/image-decoder/manifest.json");
const manifest = JSON.parse(manifestBytes.toString());
function ledger(family: string, index: number) {
  const events: any[] = [];
  const emit = (scenario: string, name: string, id: string, extra = {}) => events.push({ seq: events.length + 1, scenario, name, id, ...extra });
  for (const [at, scenario] of ["positive", "beforeDecode", "pendingClose"].entries()) {
    const id = (index * 10 + at + 1).toString(16).padStart(64, "0"), url = `blob:synthetic-${family}-${scenario}`;
    emit(scenario, "readStart", id);
    if (scenario !== "beforeDecode") {
      emit(scenario, "readSettled", id); emit(scenario, "urlCreate", id, { url }); emit(scenario, "decodeStart", id, { url });
    }
    if (scenario === "positive") { emit(scenario, "decodeSettled", id, { url, outcome: "fulfilled", width: 8, height: 8, currentSrc: url }); emit(scenario, "publish", id, { url, width: 8, height: 8, currentSrc: url, connected: true }); }
    emit(scenario, "closeStart", id); for (const name of ["hide", "clear", "release"]) emit(scenario, name, id, name === "clear" ? { srcAttribute: null, currentSrc: "" } : {});
    if (scenario !== "beforeDecode") emit(scenario, "urlRevoke", id, { url });
    if (scenario !== "positive") { emit(scenario, "cancel", id); emit(scenario, "cancelSettled", id); }
    if (scenario === "beforeDecode") emit(scenario, "readSettled", id);
    if (scenario === "pendingClose") emit(scenario, "decodeSettled", id, { url, outcome: "rejected" });
    emit(scenario, "closeSettled", id);
    if (scenario === "positive") emit(scenario, "revokedProbeRejected", id, { url });
  }
  return events;
}
export function validDecoderReport() {
  const expected = {
    commit: "a".repeat(40), runId: "ad925431-abcd-4000-9000-100000000001", fixtureManifestSha256: hash(manifestBytes), fixtures: manifest.fixtures, corruptPNG: manifest.corruptPNG,
    sourceHashes: Object.fromEntries(IMAGE_DECODER_SOURCE_PATHS.map((source: string) => [source, "b".repeat(64)])),
    bundleSha256: "d".repeat(64), readerBundleSha256: "f".repeat(64), preloadSha256: "e".repeat(64), electron: "42.10.0", platform: "linux", processSandboxDisabled: true,
    preferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true },
  };
  const report = { schema: 1, completed: true, failure: null, commit: expected.commit, runId: expected.runId,
    fixtureManifestSha256: expected.fixtureManifestSha256, sourceHashes: { ...expected.sourceHashes }, bundleSha256: expected.bundleSha256, readerBundleSha256: expected.readerBundleSha256, preloadSha256: expected.preloadSha256,
    helperInputs: ["scripts/image-decoder-proof/native-helper.ts", "src/renderer/image-inspection/image-session.ts"], readerInputs: ["src/main/image-resource.ts", "src/shared/image-cleanup.ts"], remainingImageElements: 0, network: [],
    runtime: { electron: "42.10.0", node: "24.18.1", platform: "linux", processSandboxDisabled: true }, preferences: { ...expected.preferences },
    families: manifest.fixtures.map((fixture: any, index: number) => ({
      family: fixture.family, mime: fixture.mime, bytes: fixture.bytes, sha256: fixture.sha256, width: fixture.width, height: fixture.height,
      reader: { mime: fixture.mime, bytes: fixture.bytes, sha256: fixture.sha256 },
      positive: { settled: true, published: true, width: 8, height: 8, closed: true },
      beforeDecode: { closed: true, decodeCalls: 0, urlCreates: 0, publications: 0 },
      pendingClose: { decodeStarted: true, pendingAtClose: true, decodeSettled: true, closeSettled: true, srcAttributeRemoved: true, publications: 0, outcome: "rejected" },
      urls: { created: 2, revoked: 2, unique: true, freshRevokedDecodeRejected: true }, sourceUnchanged: true,
      events: ledger(fixture.family, index),
    })),
    controls: {
      corruptPNG: { ...manifest.corruptPNG, headerAdmitted: true, rejected: true, recovered: true, closed: true,
        events: [
          { seq: 1, name: "readStart", id: "6".repeat(64), path: "corrupt.png" },
          { seq: 2, name: "readSettled", id: "6".repeat(64) },
          { seq: 3, name: "urlCreate", id: "6".repeat(64), url: "blob:corrupt" },
          { seq: 4, name: "decodeStart", id: "6".repeat(64), url: "blob:corrupt" },
          { seq: 5, name: "decodeSettled", id: "6".repeat(64), url: "blob:corrupt", outcome: "rejected" },
          { seq: 6, name: "urlRevoke", id: "6".repeat(64), url: "blob:corrupt" },
          { seq: 7, name: "readStart", id: "7".repeat(64), path: "recovery.png" },
          { seq: 8, name: "readSettled", id: "7".repeat(64) },
          { seq: 9, name: "urlCreate", id: "7".repeat(64), url: "blob:recovery" },
          { seq: 10, name: "decodeStart", id: "7".repeat(64), url: "blob:recovery" },
          { seq: 11, name: "decodeSettled", id: "7".repeat(64), url: "blob:recovery", outcome: "fulfilled" },
          { seq: 12, name: "publish", id: "7".repeat(64), url: "blob:recovery" },
          { seq: 13, name: "closeStart", id: "7".repeat(64) },
          { seq: 14, name: "urlRevoke", id: "7".repeat(64), url: "blob:recovery" },
          { seq: 15, name: "closeSettled", id: "7".repeat(64) },
        ] },
      latest: { readPaths: ["A.png", "C.png"], aSettledBeforeCRead: true, obsoletePublications: 0, closed: true, urlsRevokedOnce: true,
        events: [
          { seq: 1, name: "readStart", path: "A.png", id: "d".repeat(64) },
          { seq: 2, name: "readSettled", id: "d".repeat(64) },
          { seq: 3, name: "urlCreate", id: "d".repeat(64), url: "blob:latest-A" },
          { seq: 4, name: "decodeStart", id: "d".repeat(64), url: "blob:latest-A" },
          { seq: 5, name: "urlRevoke", id: "d".repeat(64), url: "blob:latest-A" },
          { seq: 6, name: "cancel", id: "d".repeat(64) },
          { seq: 7, name: "cancelSettled", id: "d".repeat(64) },
          { seq: 8, name: "decodeSettled", id: "d".repeat(64), url: "blob:latest-A", outcome: "rejected" },
          { seq: 9, name: "readStart", path: "C.png", id: "e".repeat(64) },
          { seq: 10, name: "readSettled", id: "e".repeat(64) },
          { seq: 11, name: "urlCreate", id: "e".repeat(64), url: "blob:latest-C" },
          { seq: 12, name: "decodeStart", id: "e".repeat(64), url: "blob:latest-C" },
          { seq: 13, name: "decodeSettled", id: "e".repeat(64), url: "blob:latest-C", outcome: "fulfilled" },
          { seq: 14, name: "publish", id: "e".repeat(64), url: "blob:latest-C" },
          { seq: 15, name: "closeStart", id: "e".repeat(64) },
          { seq: 16, name: "urlRevoke", id: "e".repeat(64), url: "blob:latest-C" },
          { seq: 17, name: "closeSettled", id: "e".repeat(64) },
        ] },
    },
  };
  for (const control of [report.controls.corruptPNG, report.controls.latest]) {
    const all = control.events;
    for (let index = 0; index < all.length; index++) if (all[index].name === "urlRevoke") {
      const event = all[index]; all.splice(index, 0, ...["hide", "clear", "release"].map(name => ({ seq: 0, name, id: event.id }))); index += 3;
    }
    all.forEach((event, index) => { event.seq = index + 1; });
    for (const event of all as any[]) {
      if (event.name === "clear") { event.srcAttribute = null; event.currentSrc = ""; }
      if (event.name === "publish" || event.name === "decodeSettled" && event.outcome === "fulfilled") {
        event.width = 8; event.height = 8; event.currentSrc = event.url;
        if (event.name === "publish") event.connected = true;
      }
    }
  }
  return { expected, report };
}

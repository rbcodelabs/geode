/** Synthetic validator/wrapper fixtures only; never native execution evidence. */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { IMAGE_DECODER_SOURCE_PATHS } = require("../../../scripts/check-image-decoder-report.cjs");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = fs.readFileSync("tests/fixtures/image-decoder/manifest.json");
const manifest = JSON.parse(manifestBytes.toString());
function request(events: any[], id: string, path: string, mode: "positive" | "pending" | "before" | "corrupt", scenario?: string, probe = false) {
  const url = "blob:synthetic-" + id;
  const emit = (name: string, extra = {}) => events.push({ seq: events.length + 1, id, path, ...(scenario ? { scenario } : {}), name, ...extra });
  const cleanup = () => {
    emit("decoder-source-cleared", { url, srcAttribute: null });
    emit("decoder-listeners-released", { url }); emit("decoder-reference-released", { url });
  };
  const presentation = (present: boolean) => {
    emit("hide", { presentationPresent: present });
    if (present) emit("decoder-source-cleared", { url, srcAttribute: null });
    emit("clear", { presentationPresent: present, srcAttribute: null, currentSrc: "" });
  };
  emit("readStart");
  if (mode === "before") {
    emit("closeStart"); presentation(false); emit("release", { decoderPresent: false }); emit("cancel"); emit("cancelSettled", { decoderPresent: false });
    emit("readSettled"); emit("closeSettled"); return;
  }
  emit("readSettled"); emit("urlCreate", { url }); emit("decodeStart", { url, srcAttribute: url, connected: false });
  if (mode === "positive" || mode === "corrupt") {
    emit("decodeSettled", mode === "positive" ? { url, outcome: "fulfilled", width: 8, height: 8, currentSrc: url } : { url, outcome: "rejected", errorName: "EncodingError" });
  }
  if (mode === "positive") emit("publish", { url, width: 8, height: 8, currentSrc: url, connected: true });
  if (scenario || mode === "positive") emit("closeStart");
  presentation(mode === "positive");
  if (mode === "pending") emit("decoder-source-retained", { url, srcAttribute: url, connected: false, settled: false });
  else if (mode === "positive") { emit("decoder-listeners-released", { url }); emit("decoder-reference-released", { url }); }
  else cleanup();
  emit("release", { decoderPresent: true }); emit("urlRevoke", { url });
  if (mode === "pending") {
    emit("cancel"); emit("decodeSettled", { url, outcome: "rejected", errorName: "EncodingError" }); cleanup();
    emit("cancelSettled", { decoderPresent: true, cleanupUncertain: false });
  }
  if (scenario || mode === "positive") emit("closeSettled");
  if (probe) emit("revokedProbeRejected", { url });
}
function ledger(path: string, index: number) {
  const events: any[] = [];
  for (const [at, scenario] of ["positive", "beforeDecode", "pendingClose"].entries()) {
    const id = (index * 10 + at + 1).toString(16).padStart(64, "0");
    request(events, id, path, scenario === "positive" ? "positive" : scenario === "beforeDecode" ? "before" : "pending", scenario, scenario === "positive");
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
  const corruptEvents: any[] = [], latestEvents: any[] = [];
  request(corruptEvents, "6".repeat(64), "corrupt.png", "corrupt");
  request(corruptEvents, "7".repeat(64), "recovery.png", "positive");
  request(latestEvents, "d".repeat(64), "A.png", "pending");
  request(latestEvents, "e".repeat(64), "C.png", "positive");
  const report = { schema: 2, completed: true, failure: null, commit: expected.commit, runId: expected.runId,
    fixtureManifestSha256: expected.fixtureManifestSha256, sourceHashes: { ...expected.sourceHashes }, bundleSha256: expected.bundleSha256, readerBundleSha256: expected.readerBundleSha256, preloadSha256: expected.preloadSha256,
    helperInputs: ["scripts/image-decoder-proof/native-helper.ts", "src/renderer/image-inspection/image-session.ts"], readerInputs: ["src/main/image-resource.ts", "src/shared/image-cleanup.ts"], remainingImageElements: 0, network: [],
    runtime: { electron: "42.10.0", node: "24.18.1", platform: "linux", processSandboxDisabled: true }, preferences: { ...expected.preferences },
    families: manifest.fixtures.map((fixture: any, index: number) => ({
      family: fixture.family, mime: fixture.mime, bytes: fixture.bytes, sha256: fixture.sha256, width: fixture.width, height: fixture.height,
      reader: { mime: fixture.mime, bytes: fixture.bytes, sha256: fixture.sha256 },
      positive: { settled: true, published: true, width: 8, height: 8, closed: true },
      beforeDecode: { closed: true, decodeCalls: 0, urlCreates: 0, publications: 0 },
      pendingClose: { decodeStarted: true, pendingAtClose: true, decodeSettled: true, closeSettled: true, presentationSourceRemoved: true,
        decoderSourceRetainedWhilePending: true, decoderSourceRemovedAfterSettlement: true, decoderDetached: true, publications: 0, outcome: "rejected" },
      urls: { created: 2, revoked: 2, unique: true, freshRevokedDecodeRejected: true }, sourceUnchanged: true,
      events: ledger(fixture.path, index),
    })),
    controls: {
      corruptPNG: { ...manifest.corruptPNG, headerAdmitted: true, rejected: true, recovered: true, closed: true, events: corruptEvents },
      latest: { readPaths: ["A.png", "C.png"], aSettledBeforeCRead: true, obsoletePublications: 0, closed: true, urlsRevokedOnce: true, events: latestEvents },
    },
  };
  return { expected, report };
}

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { rasterHeaderMime } from "../../src/main/image-resource";
const require = createRequire(import.meta.url);
const { validateImageDecoderReport } = require("../../scripts/check-image-decoder-report.cjs");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = fs.readFileSync("tests/fixtures/image-decoder/manifest.json");
const manifest = JSON.parse(manifestBytes.toString());
import { validDecoderReport as valid } from "./helpers/image-decoder-report-fixture";
it("accepts an explicitly synthetic complete validator fixture, not native execution evidence", () => {
  const { expected, report } = valid(); expect(() => validateImageDecoderReport(report, expected)).not.toThrow();
});
const failures: [string, (report: any) => void][] = [
  ["failure", r => { r.failure = "native failure"; }], ["missing terminal marker", r => { delete r.completed; }],
  ["wrong commit", r => { r.commit = "f".repeat(40); }], ["wrong run", r => { r.runId = "different"; }],
  ["wrong manifest", r => { r.fixtureManifestSha256 = "0".repeat(64); }], ["source inventory", r => { r.sourceHashes.extra = "0".repeat(64); }],
  ["bundle", r => { r.bundleSha256 = "0".repeat(64); }], ["preload", r => { delete r.preloadSha256; }],
  ["runtime version", r => { r.runtime.electron = "1.0.0"; }], ["runtime platform", r => { r.runtime.platform = "darwin"; }],
  ["security preferences", r => { r.preferences.webSecurity = false; }], ["missing family", r => { r.families.pop(); }],
  ["duplicate family", r => { r.families[5] = r.families[0]; }], ["unknown family", r => { r.families[5].family = "svg"; }],
  ["encoded hash", r => { r.families[0].sha256 = "0".repeat(64); }], ["encoded MIME", r => { r.families[0].mime = "text/html"; }],
  ["encoded bytes", r => { r.families[0].bytes++; }], ["fixture dimensions", r => { r.families[0].width++; }],
  ["reader full bytes", r => { r.families[0].reader.bytes--; }], ["reader MIME", r => { r.families[0].reader.mime = "image/jpeg"; }],
  ["decode positive", r => { r.families[0].positive.settled = false; }], ["decoded dimensions", r => { r.families[0].positive.height++; }],
  ["decode before admission", r => { r.families[0].beforeDecode.decodeCalls = 1; }], ["URL before admission", r => { r.families[0].beforeDecode.urlCreates = 1; }],
  ["pending observation", r => { r.families[0].pendingClose.pendingAtClose = false; }], ["unsettled decode", r => { r.families[0].pendingClose.decodeSettled = false; }],
  ["fictional close", r => { r.families[0].pendingClose.closeSettled = false; }], ["late publication", r => { r.families[0].pendingClose.publications = 1; }],
  ["retained source", r => { r.families[0].pendingClose.srcAttributeRemoved = false; }], ["unknown settlement", r => { r.families[0].pendingClose.outcome = "timeout"; }],
  ["unrevoked URL", r => { r.families[0].urls.revoked--; }], ["duplicate URL", r => { r.families[0].urls.unique = false; }],
  ["revocation positive missing", r => { r.families[0].urls.freshRevokedDecodeRejected = false; }], ["changed file", r => { r.families[0].sourceUnchanged = false; }],
  ["corrupt control", r => { r.controls.corruptPNG.rejected = false; }], ["recovery control", r => { r.controls.corruptPNG.recovered = false; }],
  ["B admitted", r => { r.controls.latest.readPaths.splice(1, 0, "B.png"); }], ["C before settlement", r => { r.controls.latest.aSettledBeforeCRead = false; }],
  ["obsolete latest publication", r => { r.controls.latest.obsoletePublications = 1; }],
  ["wrong cancel ID", r => { r.families[0].events.find((e: any) => e.name === "cancel").id = "f".repeat(64); }],
  ["duplicate URL revocation ledger", r => { const e = r.families[0].events; e.push({ ...e.find((v: any) => v.name === "urlRevoke"), seq: e.length + 1 }); }],
  ["borrowed URL ownership", r => { r.families[0].events.find((e: any) => e.name === "urlRevoke").url = "blob:borrowed"; }],
  ["close before actual decode settlement", r => { const e = r.families[0].events; const a = e.findIndex((v: any) => v.scenario === "pendingClose" && v.name === "closeSettled"); const b = e.findIndex((v: any) => v.scenario === "pendingClose" && v.name === "decodeSettled"); [e[a], e[b]] = [e[b], e[a]]; e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["C read before actual A settlement ledger", r => { const e = r.controls.latest.events; const a = e.findIndex((v: any) => v.name === "readStart" && v.path === "C.png"); const b = e.findIndex((v: any) => v.name === "decodeSettled"); [e[a], e[b]] = [e[b], e[a]]; e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["non64hex actual request ID", r => { r.families[0].events[0].id = "short"; }],
  ["missing native event ledger", r => { delete r.families[0].events; }],
  ["corrupt recovery before native rejection", r => { const e = r.controls.corruptPNG.events; const a = e.findIndex((v: any) => v.name === "decodeSettled"); const b = e.findIndex((v: any) => v.name === "readStart" && v.path === "recovery.png"); [e[a], e[b]] = [e[b], e[a]]; e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["A URL retirement after C admission", r => { const e = r.controls.latest.events; const at = e.findIndex((v: any) => v.name === "urlRevoke"); const [revoke] = e.splice(at, 1); e.splice(e.findIndex((v: any) => v.name === "readStart" && v.path === "C.png") + 1, 0, revoke); e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["A presentation release absent before C", r => { const e = r.controls.latest.events; e.splice(e.findIndex((v: any) => v.name === "release"), 1); e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["actual reader bundle hash", r => { r.readerBundleSha256 = "0".repeat(64); }],
  ["unexpected helper dependency", r => { r.helperInputs.push("src/renderer/image-inspection/parser-worker.ts"); }],
  ["unexpected reader dependency", r => { r.readerInputs.push("src/main/app.ts"); }],
  ["retained native image", r => { r.remainingImageElements = 1; }],
  ["external network attempt", r => { r.network.push({ url: "https://example.invalid" }); }],
  ["retained actual src despite cleanup summary", r => { r.families[0].events.find((e: any) => e.name === "clear").srcAttribute = "blob:retained"; }],
  ["release before actual clear", r => { const e = r.families[0].events; const a = e.findIndex((v: any) => v.name === "clear"), b = e.findIndex((v: any) => v.name === "release"); [e[a], e[b]] = [e[b], e[a]]; e.forEach((v: any, i: number) => { v.seq = i + 1; }); }],
  ["native decode dimensions contradict positive summary", r => { r.families[0].events.find((e: any) => e.name === "decodeSettled").width = 99; }],
  ["native publication dimensions contradict positive summary", r => { r.families[0].events.find((e: any) => e.name === "publish").height = 99; }],
  ["native decoded currentSrc contradicts URL owner", r => { r.families[0].events.find((e: any) => e.name === "decodeSettled").currentSrc = "blob:borrowed"; }],
  ["native published currentSrc contradicts URL owner", r => { r.families[0].events.find((e: any) => e.name === "publish").currentSrc = "blob:borrowed"; }],
  ["detached native publication", r => { r.families[0].events.find((e: any) => e.name === "publish").connected = false; }],
];
it.each(failures)("rejects %s before an outer runner may claim success", (_name, mutate) => {
  const { expected, report } = valid(); mutate(report); expect(() => validateImageDecoderReport(report, expected)).toThrow();
});
it("pins six generated full-byte header-family fixtures separately from actual native decode", () => {
  expect(manifest.fixtures.map((f: any) => f.family)).toEqual(["png", "jpeg", "gif", "webp", "bmp", "avif"]);
  expect(hash(fs.readFileSync(manifest.generator.source))).toBe(manifest.generator.sourceSha256);
  for (const row of manifest.fixtures) {
    const bytes = fs.readFileSync(row.path); expect(bytes.length).toBe(row.bytes); expect(hash(bytes)).toBe(row.sha256);
    expect(rasterHeaderMime(bytes, row.family)).toBe(row.mime); expect([row.width, row.height]).toEqual([8, 8]);
  }
});

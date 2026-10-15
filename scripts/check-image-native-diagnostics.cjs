const MATRIX = [{ id: "visible", hide: false, removeSrc: false, detach: false, revoke: false },
  ...Array.from({ length: 8 }, (_, mask) => ({ id: `hidden-${mask}`, hide: true, removeSrc: !!(mask & 1), detach: !!(mask & 2), revoke: !!(mask & 4) }))];
function validate(report, expected) {
  const a = require("node:assert/strict");
  a.equal(report.kind, "raw-native-observation-only"); a.equal(report.settlementAccepted, false);
  a.equal(report.completed, true); a.equal(report.failure, null);
  for (const key of ["commit", "runId", "fixtureSha256", "preloadSha256"]) a.equal(report[key], expected[key], key);
  a.deepEqual(report.sourceHashes, expected.sourceHashes); a.equal(report.cases.length, 9);
  a.equal(report.runtime.electron, expected.electron); a.equal(report.runtime.platform, expected.platform);
  a.equal(report.runtime.processSandboxDisabled, true); a.equal(typeof report.runtime.chrome, "string"); a.equal(typeof report.runtime.node, "string");
  a.deepEqual(report.network, []);
  const urls = new Set();
  for (let i = 0; i < MATRIX.length; i++) {
    const row = report.cases[i], op = MATRIX[i]; a.equal(row.id, op.id); a.deepEqual(row.operations, op);
    a.equal(row.admissionPending, true); a.equal(row.windowDestroyed, true);
    a.equal(row.hidden, op.hide); a.equal(row.connected, !op.detach);
    if (op.removeSrc) a.equal(row.srcAttribute, null); else a.match(row.srcAttribute, /^blob:/);
    a.ok(["fulfilled", "rejected", "still-pending"].includes(row.outcome));
    a.ok(Array.isArray(row.events) && row.events.length > 1);
    row.events.forEach((event, n) => a.equal(event.seq, n + 1));
    a.equal(row.events.filter(e => e.name === "decode-call").length, 1);
    a.equal(row.events.filter(e => e.name === "observation-boundary").length, 1);
    a.equal(row.events.filter(e => e.name === "native-settled").length, row.outcome === "still-pending" ? 0 : 1);
    const url = row.events[0].url; a.match(url, /^blob:/); a.equal(urls.has(url), false); urls.add(url);
    if (!op.removeSrc) a.equal(row.srcAttribute, url);
    const operations = ["hide", "remove-src", "detach", "revoke"].filter((_, n) => [op.hide, op.removeSrc, op.detach, op.revoke][n]);
    a.deepEqual(row.events.map(e => e.name), ["decode-call", "admission", ...operations, ...(row.outcome === "still-pending" ? [] : ["native-settled"]), "observation-boundary"]);
    a.equal(row.events[1].admissionPending, row.admissionPending);
    a.equal(row.events.at(-1).outcome, row.outcome);
    if (op.revoke) a.equal(row.events.find(e => e.name === "revoke").url, url);
    if (row.outcome !== "still-pending") {
      const settled = row.events.find(e => e.name === "native-settled"); a.equal(settled.outcome, row.outcome); a.equal(settled.url, url);
      if (row.outcome === "fulfilled") { a.equal(settled.width, row.width); a.equal(settled.height, row.height); }
      else { a.equal(typeof row.errorName, "string"); a.equal(settled.errorName, row.errorName); }
    }
    if (row.outcome === "fulfilled") { a.equal(row.width, 8); a.equal(row.height, 8); }
    if (i === 0) a.equal(row.outcome, "fulfilled", "Visible natural decode positive must actually fulfill.");
  }
}
module.exports = { MATRIX, validate };

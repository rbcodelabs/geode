/** Separate raw API diagnosis. Completed observations do not satisfy session settlement. */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { MATRIX, validate } = require("./check-image-native-diagnostics.cjs");
const root = path.resolve(__dirname, ".."), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SOURCES = ["scripts/run-image-native-diagnostics.cjs", "scripts/check-image-native-diagnostics.cjs", "tests/e2e/image-native-diagnostics.spec.ts", "scripts/large-vault-runner-lib.mjs"];
const commit = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceHashes = () => Object.fromEntries(SOURCES.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const fixture = () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/image-decoder/manifest.json")));
  const png = manifest.fixtures.find(row => row.family === "png"), bytes = fs.readFileSync(path.join(root, png.path));
  assert.equal(bytes.length, png.bytes); assert.equal(hash(bytes), png.sha256); return { png, bytes };
};
// Serialized into each fresh window; only actual browser APIs and synthetic bytes.
async function observe(operations, bytes) {
  const events = [], emit = (name, fields = {}) => {
    const event = { seq: events.length + 1, name, ...fields }; events.push(event);
    console.info("RAW_IMAGE_DIAGNOSTIC " + JSON.stringify({ id: operations.id, ...event }));
  };
  const target = document.createElement("img"), url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "image/png" }));
  document.body.appendChild(target); target.src = url;
  let outcome = "still-pending", width, height, errorName;
  emit("decode-call", { url });
  const native = target.decode();
  const observed = native.then(() => { outcome = "fulfilled"; width = target.naturalWidth; height = target.naturalHeight; emit("native-settled", { url, outcome, width, height }); },
    error => { outcome = "rejected"; errorName = error.name; emit("native-settled", { url, outcome, errorName }); });
  // Retain the actual element and native promise until exact window destruction.
  globalThis.rawImageDiagnostic = { target, native, observed, url };
  await Promise.resolve();
  const admissionPending = outcome === "still-pending";
  emit("admission", { admissionPending });
  if (operations.hide) { target.hidden = true; emit("hide"); }
  if (operations.removeSrc) { target.removeAttribute("src"); emit("remove-src"); }
  if (operations.detach) { target.remove(); emit("detach"); }
  if (operations.revoke) { URL.revokeObjectURL(url); emit("revoke", { url }); }
  // An observation timer never resolves/rejects the native promise.
  await new Promise(resolve => setTimeout(resolve, 2000));
  emit("observation-boundary", { outcome });
  return { id: operations.id, operations, admissionPending, outcome, width, height, errorName, events,
    srcAttribute: target.getAttribute("src"), currentSrc: target.currentSrc, connected: target.isConnected, hidden: target.hidden };
}
if (!process.versions.electron) {
  try {
    assert.ok(process.argv[2], "Fresh owned terminal path required.");
    const runId = crypto.randomUUID(), output = path.join(root, "test-results/image-native-diagnostics", runId);
    fs.mkdirSync(output, { recursive: true });
    const { png, bytes } = fixture(), expected = { commit: commit(), runId, fixtureSha256: png.sha256,
      preloadSha256: hash(fs.readFileSync(path.join(root, "dist/preload.js"))), sourceHashes: sourceHashes(), electron: require("electron/package.json").version, platform: process.platform };
    fs.writeFileSync(path.join(output, "synthetic.png"), bytes);
    fs.copyFileSync(path.join(root, "dist/preload.js"), path.join(output, "actual-preload.js"));
    for (const file of SOURCES) { const destination = path.join(output, "sources", file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(root, file), destination); }
    execFileSync(require("electron"), ["--no-sandbox", __filename], { cwd: root, stdio: "inherit", env: { ...process.env, IMAGE_DIAGNOSTIC_OUTPUT: output, IMAGE_DIAGNOSTIC_RUN: runId } });
    const reportBytes = fs.readFileSync(path.join(output, "report.json")), report = JSON.parse(reportBytes); validate(report, expected);
    const terminal = { status: "ok", diagnosticComplete: true, settlementAccepted: false, commit: expected.commit, runId,
      report: path.relative(root, path.join(output, "report.json")), reportSha256: hash(reportBytes) };
    fs.writeFileSync(process.argv[2], JSON.stringify(terminal, null, 2), { flag: "wx" });
  } catch (error) { console.error(error); process.exitCode = 1; }
} else {
  const { app, BrowserWindow, session } = require("electron"), output = process.env.IMAGE_DIAGNOSTIC_OUTPUT;
  assert.ok(output && process.env.IMAGE_DIAGNOSTIC_RUN);
  let diagnosticSequence = 0;
  const record = (kind, details) => fs.appendFileSync(path.join(output, "events.jsonl"), JSON.stringify({ seq: ++diagnosticSequence, kind, ...details }) + "\n");
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const { png, bytes } = fixture(), report = { kind: "raw-native-observation-only", settlementAccepted: false, completed: false, failure: null, cases: [],
      commit: commit(), runId: process.env.IMAGE_DIAGNOSTIC_RUN, fixtureSha256: png.sha256, sourceHashes: sourceHashes(),
      preloadSha256: hash(fs.readFileSync(path.join(root, "dist/preload.js"))),
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, processSandboxDisabled: app.commandLine.hasSwitch("no-sandbox") } };
    let window;
    try {
      const network = []; session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, done) => { network.push(details.url); done({ cancel: true }); });
      const parent = path.join(output, "parent.html"); fs.writeFileSync(parent, "<!doctype html><title>Raw native diagnostic only</title>");
      for (const operations of MATRIX) {
        record("case-start", { id: operations.id });
        const preferences = { backgroundThrottling: false, preload: path.join(root, "dist/preload.js"), contextIsolation: false, nodeIntegration: true, sandbox: false,
          nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: true };
        window = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: preferences });
        window.webContents.on("console-message", details => record("page-console", { id: operations.id, message: details.message }));
        window.webContents.on("preload-error", (_event, _file, error) => record("preload-error", { id: operations.id, message: error.message }));
        window.webContents.on("render-process-gone", (_event, details) => record("renderer-gone", { id: operations.id, ...details }));
        await window.loadFile(parent); window.focus();
        const actual = window.webContents.getLastWebPreferences();
        for (const key of ["contextIsolation", "nodeIntegration", "sandbox", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "webSecurity"]) assert.equal(actual[key], preferences[key]);
        const row = await window.webContents.executeJavaScript(`(${observe.toString()})(${JSON.stringify(operations)},${JSON.stringify([...bytes])})`);
        row.preferences = Object.fromEntries(["contextIsolation", "nodeIntegration", "sandbox", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "webSecurity"].map(key => [key, actual[key]]));
        window.destroy(); row.windowDestroyed = window.isDestroyed(); window = undefined;
        report.cases.push(row); record("case-observed", row);
        fs.writeFileSync(path.join(output, "partial.json"), JSON.stringify(report, null, 2));
      }
      report.network = network; assert.equal(network.length, 0); report.completed = true;
    } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; }
    finally { if (window && !window.isDestroyed()) window.destroy(); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" }); app.exit(report.failure ? 1 : 0); }
  }).catch(error => { console.error(error); app.exit(1); });
}

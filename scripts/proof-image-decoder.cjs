/** Standalone synthetic native-API harness; no product channel or App registration. */
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { IMAGE_DECODER_SOURCE_PATHS } = require("./check-image-decoder-report.cjs");
const root = path.resolve(__dirname, ".."), output = process.env.GEODE_IMAGE_DECODER_OUTPUT, runId = process.env.GEODE_IMAGE_DECODER_RUN_ID;
assert.ok(output && runId, "Owned runner output and fresh run are required.");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
let diagnosticSequence = 0;
const diagnostic = (kind, details) => fs.appendFileSync(path.join(output, "diagnostics.jsonl"), JSON.stringify({ seq: ++diagnosticSequence, at: Date.now(), kind, ...details }) + "\n");
diagnostic("main-stage", { name: "entry" });
// The harness owns the entire multi-case lifecycle until its explicit final exit.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  let window, failure = null, completed = false, result;
  const report = { schema: 2, runId, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    runtime: { electron: process.versions.electron, node: process.versions.node, platform: process.platform, processSandboxDisabled: app.commandLine.hasSwitch("no-sandbox") } };
  try {
    diagnostic("main-stage", { name: "ready" });
    const manifestPath = path.join(root, "tests/fixtures/image-decoder/manifest.json"), manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    report.fixtureManifestSha256 = hash(manifestBytes);
    const readerBundle = path.join(output, "actual-reader.cjs"), helper = path.join(output, "native-helper.js");
    const readerBuild = require("esbuild").buildSync({ absWorkingDir: root, entryPoints: ["src/main/image-resource.ts"], outfile: readerBundle, bundle: true, platform: "node", format: "cjs", metafile: true, logLevel: "silent" });
    const build = require("esbuild").buildSync({ absWorkingDir: root, entryPoints: ["scripts/image-decoder-proof/native-helper.ts"], outfile: helper, bundle: true, platform: "browser", format: "iife", globalName: "ImageDecoderProof", metafile: true, logLevel: "silent" });
    report.bundleSha256 = hash(fs.readFileSync(helper)); report.readerBundleSha256 = hash(fs.readFileSync(readerBundle));
    report.helperInputs = Object.keys(build.metafile.inputs).sort();
    report.readerInputs = Object.keys(readerBuild.metafile.inputs).sort();
    const reader = require(readerBundle), fixtureRoot = path.join(root, "tests/fixtures/image-decoder");
    const load = async row => {
      diagnostic("main-stage", { name: "reader-before", path: row.path });
      const actual = await reader.readAuthorizedImage({ root: fixtureRoot, expectedRoot: fixtureRoot, path: path.basename(row.path), current: () => true });
      diagnostic("main-stage", { name: "reader-after", path: row.path });
      const bytes = Buffer.from(actual.bytes);
      assert.equal(actual.mime, row.mime); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
      return { ...row, bytes: [...bytes], reader: { mime: actual.mime, bytes: bytes.length, sha256: hash(bytes) } };
    };
    const fixtures = []; for (const row of manifest.fixtures) fixtures.push(await load(row));
    const corrupt = await load(manifest.corruptPNG);
    const preferences = { backgroundThrottling: false, preload: path.join(root, "dist/preload.js"), contextIsolation: false, nodeIntegration: true,
      sandbox: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: true };
    report.preloadSha256 = hash(fs.readFileSync(preferences.preload));
    const network = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, done) => { network.push({ type: details.resourceType, url: details.url }); done({ cancel: true }); });
    const parent = path.join(output, "native-parent.html");
    fs.writeFileSync(parent, '<!doctype html><meta charset="utf-8"><title>Synthetic raster API proof</title><script src="native-helper.js"></script>');
    window = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: preferences });
    window.webContents.on("console-message", details => diagnostic("page-console", { level: details.level, message: details.message, sourceId: details.sourceId, line: details.lineNumber }));
    window.webContents.on("preload-error", (_event, preloadPath, error) => diagnostic("preload-error", { preloadPath, message: error.message, stack: error.stack }));
    window.webContents.on("render-process-gone", (_event, details) => diagnostic("renderer-gone", details));
    diagnostic("main-stage", { name: "load-before" });
    await window.loadFile(parent); window.focus(); diagnostic("main-stage", { name: "load-after" });
    const actual = window.webContents.getLastWebPreferences();
    report.preferences = Object.fromEntries(["contextIsolation", "nodeIntegration", "sandbox", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "webSecurity"].map(key => [key, actual[key]]));
    for (const key of Object.keys(report.preferences)) assert.equal(actual[key], preferences[key], key);
    diagnostic("main-stage", { name: "helper-before" });
    result = await window.webContents.executeJavaScript(`ImageDecoderProof.run(${JSON.stringify(fixtures)},${JSON.stringify(corrupt)})`);
    diagnostic("main-stage", { name: "helper-after" });
    for (const row of [...manifest.fixtures, manifest.corruptPNG]) {
      assert.equal(hash(fs.readFileSync(path.join(root, row.path))), row.sha256, "Source fixture unchanged.");
    }
    for (const row of result.families) row.sourceUnchanged = true;
    report.remainingImageElements = await window.webContents.executeJavaScript("document.images.length"); assert.equal(report.remainingImageElements, 0);
    report.network = network; assert.equal(network.length, 0, "No external request from synthetic proof.");
    Object.assign(report, result); completed = true;
  } catch (error) { failure = { name: error?.name || "Error", message: error?.message || String(error), stack: error?.stack || "" }; diagnostic("main-failure", failure); }
  finally {
    report.sourceHashes = Object.fromEntries(IMAGE_DECODER_SOURCE_PATHS.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    report.completed = completed; report.failure = failure;
    report.limits = "Synthetic prepared-byte capability after actual Node reader proof, not product IPC. Tiny static native API events only; pending Promise is not active expensive native decoding, OS/GC settlement or memory release. No UI/App/epoch/Lightbox enablement.";
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    if (window && !window.isDestroyed()) window.destroy();
    if (failure) console.error(JSON.stringify(failure));
    app.exit(failure ? 1 : 0);
  }
}).catch(error => { console.error(error); app.exit(1); });

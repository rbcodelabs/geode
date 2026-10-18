/** Must run under the existing owned-process E2E harness, not as a detached stage. */
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { validateImageDecoderReport, IMAGE_DECODER_SOURCE_PATHS } = require("./check-image-decoder-report.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const root = path.resolve(__dirname, ".."), base = path.join(root, "test-results/image-decoder-proof");
try {
  assert.ok(process.argv[2], "Fresh E2E terminal output is required.");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), runId = crypto.randomUUID(), directory = path.join(base, runId);
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(directory);
  const manifestBytes = fs.readFileSync(path.join(root, "tests/fixtures/image-decoder/manifest.json")), manifest = JSON.parse(manifestBytes);
  const expected = { commit, runId, fixtures: manifest.fixtures, corruptPNG: manifest.corruptPNG, fixtureManifestSha256: hash(manifestBytes),
    sourceHashes: Object.fromEntries(IMAGE_DECODER_SOURCE_PATHS.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
    preloadSha256: hash(fs.readFileSync(path.join(root, "dist/preload.js"))), electron: require("electron/package.json").version,
    platform: process.platform, processSandboxDisabled: true,
    preferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true } };
  // Preserve exact synthetic input bytes even when the native child fails.
  for (const row of [...manifest.fixtures, manifest.corruptPNG]) {
    const data = fs.readFileSync(path.join(root, row.path)); assert.equal(data.length, row.bytes); assert.equal(hash(data), row.sha256);
    fs.copyFileSync(path.join(root, row.path), path.join(directory, path.basename(row.path)));
  }
  fs.copyFileSync(path.join(root, "tests/fixtures/image-decoder/manifest.json"), path.join(directory, "fixture-manifest.json"));
  fs.copyFileSync(path.join(root, "dist/preload.js"), path.join(directory, "actual-preload.js"));
  assert.equal(hash(fs.readFileSync(path.join(directory, "actual-preload.js"))), expected.preloadSha256);
  // Canonical require resolves Electron's existing lazy installation when needed.
  execFileSync(require("electron"), ["--no-sandbox", path.join(__dirname, "proof-image-decoder.cjs")], { cwd: root, stdio: "inherit",
    env: { ...process.env, GEODE_IMAGE_DECODER_OUTPUT: directory, GEODE_IMAGE_DECODER_RUN_ID: runId } });
  const reportFile = path.join(directory, "report.json"), bytes = fs.readFileSync(reportFile), report = JSON.parse(bytes);
  expected.bundleSha256 = hash(fs.readFileSync(path.join(directory, "native-helper.js")));
  expected.readerBundleSha256 = hash(fs.readFileSync(path.join(directory, "actual-reader.cjs")));
  validateImageDecoderReport(report, expected);
  for (const row of [...manifest.fixtures, manifest.corruptPNG]) {
    const data = fs.readFileSync(path.join(root, row.path)); assert.equal(data.length, row.bytes); assert.equal(hash(data), row.sha256);
  }
  const validation = { status: "ok", validated: true, commit, runId, report: path.relative(base, reportFile), reportSha256: hash(bytes), fixtureManifestSha256: expected.fixtureManifestSha256 };
  fs.writeFileSync(path.join(directory, "validation.json"), JSON.stringify(validation, null, 2), { flag: "wx" });
  fs.writeFileSync(process.argv[2], JSON.stringify(validation, null, 2), { flag: "wx" });
  console.log(JSON.stringify(validation));
} catch (error) { console.error(error.stack || error); process.exitCode = 1; }

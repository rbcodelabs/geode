/** Test-only Electron proof. Run after npm run build; never imported by the app. */
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const badMode = process.argv.includes('--bad-wasm') || process.argv.includes('--blocked-wasm');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'geode-pdf-isolation-proof-')));
protocol.registerSchemesAsPrivileged([{ scheme: 'geode-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
function bundle(options) { return esbuild.buildSync({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent', ...options }).outputFiles[0].text; }

async function hostProof(fixtures, helperUrl, badMode) {
  const helper = await import(helperUrl);
  const parentRealm = { require: typeof require, geode: typeof geode };
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const init = { kind: 'geode-pdf-init', version: 1, build: '6.4.299', nonce, generation: 1 };
  const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts allow-same-origin'; frame.src = 'geode-pdf://viewer/index.html';
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('frame timeout')), 10000); frame.onload = () => { clearTimeout(timer); resolve(); }; document.body.append(frame); });
  async function ignored(packet) {
    const channel = new MessageChannel(); let reply = false; channel.port1.onmessage = () => { reply = true; };
    frame.contentWindow.postMessage(packet, 'geode-pdf://viewer', [channel.port2]);
    await new Promise(resolve => setTimeout(resolve, 100)); channel.port1.close(); return !reply;
  }
  const rejects = [];
  for (const packet of [{ ...init, version: 2 }, { ...init, build: 'old' }, { ...init, nonce: 'short' }, { ...init, url: 'file:///not-allowed' }]) rejects.push(await ignored(packet));
  // Real MessagePorts exercise the same host readiness validator against forgery.
  for (const packet of [{ ...init, kind: 'geode-pdf-ready', nonce: 'b'.repeat(64), realm: Object.fromEntries(helper.PDF_FRAME_NODE_KEYS.map(key => [key, 'undefined'])) }, { ...init, kind: 'geode-pdf-ready', generation: 2, realm: Object.fromEntries(helper.PDF_FRAME_NODE_KEYS.map(key => [key, 'undefined'])) }]) {
    const channel = new MessageChannel(); const ready = helper.waitForPdfFrameReady(channel.port1, init, () => true); channel.port2.postMessage(packet);
    try { await ready; rejects.push(false); } catch { rejects.push(true); } finally { channel.port2.close(); }
  }
  const stale = new MessageChannel(); let current = true;
  const staleReady = helper.waitForPdfFrameReady(stale.port1, init, () => current); current = false;
  stale.port2.postMessage({ ...init, kind: 'geode-pdf-ready', realm: Object.fromEntries(helper.PDF_FRAME_NODE_KEYS.map(key => [key, 'undefined'])) });
  try { await staleReady; rejects.push(false); } catch { rejects.push(true); } finally { stale.port2.close(); }
  const owned = new MessageChannel(), foreign = new MessageChannel(), abort = new AbortController();
  const ownedReady = helper.waitForPdfFrameReady(owned.port1, init, () => true, abort.signal);
  foreign.port2.postMessage({ ...init, kind: 'geode-pdf-ready', realm: Object.fromEntries(helper.PDF_FRAME_NODE_KEYS.map(key => [key, 'undefined'])) });
  setTimeout(() => abort.abort(),50);
  try { await ownedReady; rejects.push(false); } catch (error) { rejects.push(error.name === 'AbortError'); } finally { owned.port2.close(); foreign.port1.close(); foreign.port2.close(); }
  const channel = new MessageChannel(); const ready = helper.waitForPdfFrameReady(channel.port1, init, () => true);
  frame.contentWindow.postMessage(init, 'geode-pdf://viewer', [channel.port2]); await ready;
  rejects.push(await ignored(init)); // A second parent init cannot replace the accepted port.
  let next;
  channel.port1.onmessage = event => next?.(event.data);
  async function receive(send) {
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('PDF proof response timeout')), 20000); next = data => { clearTimeout(timer); next = undefined; resolve(data); }; send(); });
  }
  // Invalid state/extra capabilities cannot enter the accepted byte channel.
  for (const invalid of [{ kind: 'load', version: 1, generation: 0, bytes: new ArrayBuffer(8), page: 1, label: 'stale' }, { kind: 'load', version: 1, generation: 1, bytes: new ArrayBuffer(8), page: 1, label: 'extra', url: 'https://example.invalid' }]) {
    let replied = false; next = () => { replied = true; }; channel.port1.postMessage(invalid); await new Promise(resolve => setTimeout(resolve,100)); next = undefined; rejects.push(!replied);
  }
  const results = []; let last;
  for (const fixture of fixtures) {
    const bytes = Uint8Array.from(atob(fixture.base64), char => char.charCodeAt(0)).buffer;
    last = await receive(() => channel.port1.postMessage({ kind: 'load', version: 1, generation: 1, bytes, page: fixture.name === 'FieldGuide.pdf' ? 2 : 1, label: fixture.name }, [bytes]));
    if (last.kind === 'error') break; results.push(last.result);
  }
  const disposed = await receive(() => channel.port1.postMessage({ kind: 'dispose', version: 1, generation: 1 }));
  channel.port1.close(); frame.remove();
  return { parentRealm, rejects, disposed, ...last, results };
}

app.whenReady().then(async () => {
  const served = [], consoleMessages = []; let connections = 0, hits = 0;
  const server = http.createServer((_request, response) => { hits++; response.end('UNEXPECTED'); });
  server.on('connection', () => connections++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const protocolModule = bundle({ entryPoints: ['src/main/pdf-protocol.ts'], platform: 'node', format: 'cjs' });
  const protocolFile = path.join(root, 'dist/pdf-proof-protocol.cjs'); fs.writeFileSync(protocolFile, protocolModule);
  const { createPdfProtocolHandler } = require(protocolFile);
  let worker = bundle({ stdin: { contents: 'import { nativeProbe } from "./scripts/pdf-isolation-native-probe.mjs"; postMessage({kind:"native-worker-proof",nativeProbe:await nativeProbe()});', resolveDir: root }, define: { __PDF_PROOF_PORT__: String(port) } }) + '\n' + fs.readFileSync(path.join(root, 'dist/pdf-worker.mjs'), 'utf8');
  if (process.argv.includes('--bad-wasm')) worker = worker.replace(/("qcms_bg.wasm": ")[^"]+"/, '$1AAAA"');
  const viewer = bundle({ entryPoints: ['scripts/pdf-isolation-proof-viewer.mjs'], define: { process: 'undefined', __PDF_PROOF_PORT__: String(port) } });
  fs.writeFileSync(path.join(root, 'dist/pdf-proof-host-handshake.mjs'), bundle({ entryPoints: ['src/renderer/pdf/handshake.ts'] }));
  const handle = createPdfProtocolHandler({
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./viewer.css"><script type="module" src="./viewer.mjs"></script></head><body></body></html>',
    'viewer.mjs': viewer, 'worker.mjs': worker,
    'viewer.css': 'body{font-family:sans-serif}.textLayer{position:relative;line-height:1;white-space:pre}.textLayer span{position:absolute;transform-origin:0 0;color:transparent}'
  });
  protocol.handle('geode-pdf', request => {
    served.push(request.url); const response = handle(request);
    if (request.url === 'geode-pdf://viewer/worker.mjs' && process.argv.includes('--blocked-wasm')) response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy').replace(" 'wasm-unsafe-eval'", ''));
    return response;
  });
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root,'dist/preload.js'), contextIsolation: false, nodeIntegration: true, sandbox: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: true } });
  win.webContents.on('console-message', event => consoleMessages.push(event.message));
  const parentFile = path.join(root, 'dist/pdf-frame-proof.html');
  fs.writeFileSync(parentFile, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-eval\'; frame-src geode-pdf://viewer/index.html"><body>Trusted parent</body>');
  await win.loadFile(parentFile);
  const fixtures = ['FieldGuide.pdf', 'CMYK.pdf', 'JPX.pdf', 'JBIG2.pdf', 'CMap.pdf'].map(name => ({ name, base64: fs.readFileSync(path.join(root,'tests/fixtures/pdf',name)).toString('base64') }));
  let result, assertionFailure;
  try { result = await win.webContents.executeJavaScript(`(${hostProof.toString()})(${JSON.stringify(fixtures)},${JSON.stringify(pathToFileURL(path.join(root,'dist/pdf-proof-host-handshake.mjs')).href)},${badMode})`); }
  catch (error) { assertionFailure = String(error); }
  try {
    assert.ok(result); assert.equal(result.parentRealm.require, 'function'); assert.equal(result.parentRealm.geode, 'object');
    assert.equal(connections, 0); assert.equal(hits, 0); assert.ok(result.rejects.every(Boolean)); assert.equal(result.disposed.kind, 'disposed'); assert.equal(result.accepted, 1);
    const frame = result.frameProbe;
    assert.equal(frame.parentDOM, true); assert.equal(frame.parentNode, 'blocked'); assert.equal(frame.wasm,false); assert.equal(frame.subworker,false);
    assert.equal(frame.nativeWindowForgery.sourceWasParent,false); assert.equal(frame.nativeWindowForgery.origin,'geode-pdf://viewer'); assert.equal(frame.nativeWindowForgery.reply,false);
    assert.ok(served.every(url => ['index.html','viewer.mjs','worker.mjs','viewer.css'].some(name => url === 'geode-pdf://viewer/'+name)));
    for (const key of ['process','require','geode','electron','ipcRenderer','Buffer']) assert.equal(frame.realm[key], 'undefined', key);
    for (const key of ['eval','fetch','import','xhr','wss']) assert.equal(frame[key], true, key);
    if (badMode) { assert.equal(result.kind, 'error'); assert.match(result.message, /CompileError|WebAssembly/); }
    else {
      assert.equal(result.kind, 'proof-fixture'); const workerProof = result.packets.find(packet => packet.kind === 'native-worker-proof').nativeProbe;
      for (const key of ['process','require','geode','electron','ipcRenderer','Buffer','window','document']) assert.equal(workerProof.realm[key], 'undefined', key);
      for (const key of ['eval','fetch','import','xhr','wss','subworker','wasm']) assert.equal(workerProof[key], true, key);
      assert.equal(result.results.length, 5); for (const fixture of result.results) assert.ok(fixture.pixels > 50, fixture.name);
      assert.equal(result.results[0].pages, 3); assert.match(result.results[0].text,/Synthetic page 2 of 3/); assert.match(result.results[0].selected,/Synthetic page 2 of 3/); assert.equal(result.results[4].text,'AB');
      const close = (actual, expected, tolerance) => actual.slice(0,3).every((value,index) => Math.abs(value-expected[index]) <= tolerance);
      assert.ok(close(result.results[2].samples[0],[245,203,82],3)); assert.ok(close(result.results[2].samples[1],[24,118,86],3));
      assert.ok(close(result.results[3].samples[0],[0,0,0],0)); assert.ok(close(result.results[3].samples[1],[255,255,255],0));
      // Independent Pillow/LittleCMS conversion of CMYK(51,204,77,0)
      // through the pinned CGATS001 profile yields RGB(201,87,126).
      assert.ok(close(result.results[1].samples[2],[201,87,126],3));
    }
  } catch (error) { assertionFailure ||= String(error); }
  const captures = fs.mkdtempSync(path.join(os.tmpdir(),'geode-pdf-isolation-captures-'));
  for (const fixture of result?.results ?? []) if (fixture.png) { const filename = path.join(captures,fixture.name+'.png'); fs.writeFileSync(filename,Buffer.from(fixture.png.split(',')[1],'base64')); delete fixture.png; fixture.capture = filename; }
  const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const hashes = Object.fromEntries(['scripts/proof-pdf-isolation.cjs','scripts/pdf-isolation-proof-viewer.mjs','scripts/pdf-isolation-native-probe.mjs','dist/pdf-worker.mjs','dist/pdf-proof-host-handshake.mjs','dist/preload.js'].map(name=>[name,hash(path.join(root,name))]));
  const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  console.log(JSON.stringify({ electron: process.versions.electron, commit, hashes, assertionFailure, result, served, connections, hits, consoleMessages }, null, 2));
  server.close(); app.exit(assertionFailure ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });

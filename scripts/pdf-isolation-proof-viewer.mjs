import { getDocument, PDFWorker, TextLayer } from "../src/renderer/pdf/display-entry";
import { createPdfFrameInitializer, pdfFrameRealm } from "../src/renderer/pdf/handshake";
import { isPdfHostMessage } from "../src/shared/pdf-viewer-protocol";
import { nativeProbe } from "./pdf-isolation-native-probe.mjs";

const frameProbePromise = nativeProbe().then(result => {
  try { parent.document.body; result.parentDOM = false; } catch { result.parentDOM = true; }
  try { result.parentNode = typeof parent.require; } catch { result.parentNode = "blocked"; }
  return result;
});
let accepted = 0, worker, engine;
const packets = [];
const initialize = createPdfFrameInitializer(parent, async ({ init, port }) => {
  accepted++;
  port.postMessage({ ...init, kind: "geode-pdf-ready", realm: pdfFrameRealm(globalThis) });
  port.addEventListener("message", async event => {
    if (!isPdfHostMessage(event.data) || event.data.generation !== init.generation) return;
    if (event.data.kind === "dispose") { worker?.terminate(); engine?.destroy(); port.postMessage({ kind: "disposed", version: 1, generation: init.generation }); return; }
    try {
      if (!worker) {
        worker = new Worker("geode-pdf://viewer/worker.mjs", { type: "module" });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("worker timeout")), 8000);
          worker.onmessage = event => { packets.push(event.data); if (event.data.kind === "geode-pdf-worker-ready") { clearTimeout(timer); worker.onmessage = null; resolve(); } };
          worker.onerror = event => { clearTimeout(timer); reject(Error(event.message || "worker error")); };
        });
        engine = new PDFWorker({ port: worker });
      }
      const task = getDocument({ data: new Uint8Array(event.data.bytes), worker: engine, enableXfa: false, useSystemFonts: false, stopAtErrors: true, useWorkerFetch: true, cMapUrl: "geode-pdf-asset:/cMapUrl/", standardFontDataUrl: "geode-pdf-asset:/standardFontDataUrl/", wasmUrl: "geode-pdf-asset:/wasmUrl/", iccUrl: "geode-pdf-asset:/icc/", maxImageSize: 8000000 });
      const doc = await task.promise, page = await doc.getPage(event.data.page), viewport = page.getViewport({ scale: 0.5 });
      const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height; document.body.append(canvas);
      const context = canvas.getContext("2d"); await page.render({ canvas, canvasContext: context, viewport }).promise;
      const textContent = await page.getTextContent(), text = textContent.items.map(item => item.str).join(" ");
      const layer = document.createElement("div"); layer.className = "textLayer"; document.body.append(layer);
      await new TextLayer({ textContentSource: textContent, container: layer, viewport }).render();
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(layer); selection.removeAllRanges(); selection.addRange(range);
      const selected = selection.toString(); selection.removeAllRanges();
      const rgba = context.getImageData(0,0,canvas.width,canvas.height).data; let pixels = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 245 || rgba[i+1] < 245 || rgba[i+2] < 245) pixels++;
      const sample = (x,y) => Array.from(context.getImageData(x,y,1,1).data);
      const result = { name: event.data.label, pages: doc.numPages, pixels, text, selected, samples: [sample(48,84),sample(80,84),sample(50,70)], png: canvas.toDataURL("image/png") };
      await task.destroy();
      port.postMessage({ kind: "proof-fixture", result, frameProbe: { ...await frameProbePromise, nativeWindowForgery: await nativeForgery }, packets, accepted });
    } catch (error) { port.postMessage({ kind: "error", message: String(error), frameProbe: { ...await frameProbePromise, nativeWindowForgery: await nativeForgery }, packets, accepted }); }
  });
  port.start();
});
addEventListener("message", initialize);

// A real window message from the viewer's own non-null origin is not its parent.
// Unit tests isolate the source/origin predicates separately; this browser probe
// exercises their combined rejection before legitimate parent initialization.
const nativeForgery = new Promise(resolve => {
  const channel = new MessageChannel(); let reply = false, observed;
  channel.port1.onmessage = () => { reply = true; };
  const observe = event => { if (event.source === self && event.data?.kind === "geode-pdf-init") observed = { sourceWasParent: event.source === parent, origin: event.origin }; };
  addEventListener("message", observe);
  self.postMessage({ kind: "geode-pdf-init", version: 1, build: "6.4.299", generation: 1, nonce: "c".repeat(64) }, location.origin, [channel.port2]);
  setTimeout(() => { channel.port1.close(); removeEventListener("message", observe); resolve({ ...observed, reply }); },100);
});

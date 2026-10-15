import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker, RenderTask, TextLayer } from "pdfjs-dist";
import { PDF_LIMITS, pdfRenderScale, validatePdfPage } from "../../shared/pdf";
import { verifyPdfWorker } from "./verified-worker";
import { PDF_VIEWER_ORIGIN } from "../../shared/pdf-viewer-protocol";
type PdfApi = typeof import("./display-entry");
function cancelled(): Error { const error = new Error("PDF operation cancelled."); error.name = "AbortError"; return error; }
function bounded<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve,reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort",abort); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("PDF operation timed out. Retry this document.")); },milliseconds);
    signal?.addEventListener("abort",abort,{once:true});
    promise.then(value => { cleanup(); resolve(value); },error => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}
/** Read-only engine owned entirely by the isolated viewer document. */
export class PdfSession {
  private readonly abort = new AbortController();
  private worker: Worker | undefined;
  private engine: PDFWorker | undefined;
  private loading: PDFDocumentLoadingTask | undefined;
  private document: PDFDocumentProxy | undefined;
  private renderTask: RenderTask | undefined;
  private text: TextLayer | undefined;
  private textPromise: Promise<void> | undefined;
  private generation = 0;
  private closing: Promise<void> | undefined;
  constructor(private readonly api: PdfApi, private readonly createWorker: () => Worker = () => new Worker(`${PDF_VIEWER_ORIGIN}/worker.mjs`,{type:"module"})) {}
  get count(): number { return this.document?.numPages ?? 0; }
  async load(bytes: Uint8Array<ArrayBuffer>, page: number): Promise<void> {
    if (this.loading || this.closing || bytes.byteLength > PDF_LIMITS.bytes) throw new Error("PDF document is unavailable or exceeds its byte limit.");
    try {
      this.worker = this.createWorker(); await verifyPdfWorker(this.worker,this.api.version,this.abort.signal);
      if (this.abort.signal.aborted) throw cancelled();
      this.engine = this.api.PDFWorker.create({port:this.worker});
      if (this.engine.port !== this.worker) throw new Error("PDF worker port identity changed.");
      this.loading = this.api.getDocument({data:bytes,worker:this.engine,enableXfa:false,useSystemFonts:false,stopAtErrors:true,useWorkerFetch:true,cMapUrl:"geode-pdf-asset:/cMapUrl/",standardFontDataUrl:"geode-pdf-asset:/standardFontDataUrl/",wasmUrl:"geode-pdf-asset:/wasmUrl/",iccUrl:"geode-pdf-asset:/icc/",maxImageSize:PDF_LIMITS.pixels,canvasMaxAreaInBytes:PDF_LIMITS.pixels*4});
      this.document = await bounded(this.loading.promise,15000,this.abort.signal);
      validatePdfPage(page,this.document.numPages);
    } catch (error) { await this.close(); throw error; }
  }
  async render(page: number, canvas: HTMLCanvasElement, layer: HTMLElement, zoom: number | "fit", availableWidth: number): Promise<{page:number;count:number;zoom:number}> {
    if (!this.document || this.closing) throw new Error("PDF document is not loaded.");
    validatePdfPage(page,this.document.numPages);
    const generation = ++this.generation;
    const previousRender = this.renderTask?.promise, previousText = this.textPromise;
    this.renderTask?.cancel(); this.text?.cancel();
    const check = () => { if (this.abort.signal.aborted || this.generation !== generation) throw cancelled(); };
    // PDF.js retains the canvas until cancellation settles. A newer request
    // must also let the preceding text layer finish retiring before reuse.
    await bounded(Promise.allSettled([previousRender,previousText]),1500,this.abort.signal); check();
    const pdfPage = await bounded(this.document.getPage(page),15000,this.abort.signal); check();
    const natural = pdfPage.getViewport({scale:1});
    const scale = pdfRenderScale(natural.width,natural.height,zoom === "fit" ? Math.max(120,availableWidth)/natural.width : zoom);
    const viewport = pdfPage.getViewport({scale}), context = canvas.getContext("2d");
    if (!context) throw new Error("PDF canvas is unavailable.");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    layer.replaceChildren(); layer.style.setProperty("--scale-factor",String(scale));
    layer.style.setProperty("--total-scale-factor",String(scale*(pdfPage.userUnit ?? 1)));
    layer.style.setProperty("--scale-round-x","1px"); layer.style.setProperty("--scale-round-y","1px");
    this.renderTask = pdfPage.render({canvas,canvasContext:context,viewport});
    await bounded(this.renderTask.promise,15000,this.abort.signal); check();
    const content = await bounded(pdfPage.getTextContent(),15000,this.abort.signal); check();
    this.text = new this.api.TextLayer({textContentSource:content,container:layer,viewport});
    this.textPromise = this.text.render();
    await bounded(this.textPromise,15000,this.abort.signal); check();
    return {page,count:this.document.numPages,zoom:scale};
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.abort.abort(); this.generation++; this.renderTask?.cancel(); this.text?.cancel();
    this.closing = (async () => {
      // Read-only fallback: a wedged decoder cannot block owner teardown. The
      // real worker is always terminated after this bounded graceful attempt.
      try { if (this.loading) await bounded(this.loading.destroy(),1500); } catch { /* hard termination below completes the boundary */ }
      finally { try { this.engine?.destroy(); } finally { this.worker?.terminate(); this.document = undefined; } }
    })();
    return this.closing;
  }
}

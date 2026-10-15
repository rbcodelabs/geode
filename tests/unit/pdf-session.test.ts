import { expect, it, vi } from "vitest";
const api = await import("../../src/renderer/pdf/session").catch(() => ({})) as typeof import("../../src/renderer/pdf/session");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return { promise, resolve }; }
function fixture() {
  const realm = Object.fromEntries(["process","require","geode","electron","ipcRenderer","Buffer","window","document"].map(key => [key,"undefined"]));
  class WorkerDouble extends EventTarget { terminate = vi.fn(); constructor() { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message",{data:{kind:"geode-pdf-worker-ready",version:"6.4.299",realm}}))); } }
  const worker = new WorkerDouble(), engineDestroy = vi.fn(), destroy = vi.fn(async()=>{}), renderCancel = vi.fn();
  const page = { getViewport: ({scale}:any) => ({width:200*scale,height:100*scale}), render: vi.fn(() => ({promise:Promise.resolve(),cancel:renderCancel})), getTextContent: vi.fn(async()=>({items:[]})) };
  const doc = {numPages:3,getPage:vi.fn(async()=>page)}, loading = {promise:Promise.resolve(doc),destroy};
  const getDocument = vi.fn(()=>loading), runtime = {version:"6.4.299",getDocument,PDFWorker:class { port: unknown; constructor({port}:any) { this.port=port; } static create(params:any) { return new this(params); } destroy = engineDestroy; },TextLayer:class {render=async()=>{};cancel=vi.fn();}};
  return {worker,runtime,doc,page,destroy,engineDestroy,renderCancel,getDocument};
}
it("loads bytes only through an explicit verified worker and disables unsupported execution/network defaults", async()=>{
  expect(api.PdfSession).toBeTypeOf("function"); const f=fixture(),session=new api.PdfSession(f.runtime as any,()=>f.worker as any);
  await session.load(new TextEncoder().encode("%PDF-1.7"),2); const options=f.getDocument.mock.calls[0][0] as any;
  expect(options.worker).toBeDefined();expect(options.enableXfa).toBe(false);expect(options.useSystemFonts).toBe(false);expect(options.stopAtErrors).toBe(true);expect(options.useWorkerFetch).toBe(true);expect(options.wasmUrl).toBe("geode-pdf-asset:/wasmUrl/");
  await session.close();expect(f.destroy).toHaveBeenCalledOnce();expect(f.engineDestroy).toHaveBeenCalledOnce();expect(f.worker.terminate).toHaveBeenCalledOnce();
});
it("rejects a late page/render after a newer request without publishing it", async()=>{
  expect(api.PdfSession).toBeTypeOf("function"); const f=fixture(),session=new api.PdfSession(f.runtime as any,()=>f.worker as any);await session.load(new Uint8Array(8),1);
  const stale=deferred<any>();f.doc.getPage.mockImplementationOnce(()=>stale.promise);
  const canvas={getContext:()=>({}),style:{}} as any,layer={replaceChildren:vi.fn(),style:{setProperty:vi.fn()}} as any;
  const first=session.render(1,canvas,layer,1,500), rejected=expect(first).rejects.toMatchObject({name:"AbortError"});
  const second=session.render(2,canvas,layer,1,500);stale.resolve(f.page);await rejected;await second;expect(f.page.render).toHaveBeenCalledOnce();await session.close();
});
it("settles close exactly once and terminates the real worker after failed loading", async()=>{
  expect(api.PdfSession).toBeTypeOf("function");const f=fixture();f.getDocument.mockReturnValueOnce({promise:Promise.reject(Error("bad PDF")),destroy:f.destroy});
  const session=new api.PdfSession(f.runtime as any,()=>f.worker as any);await expect(session.load(new Uint8Array(8),1)).rejects.toThrow(/bad PDF/);
  await Promise.all([session.close(),session.close()]);expect(f.worker.terminate).toHaveBeenCalledOnce();expect(f.destroy).toHaveBeenCalledOnce();
});
it("waits for prior canvas cancellation to settle before starting the next render",async()=>{
 expect(api.PdfSession).toBeTypeOf("function");const f=fixture(),session=new api.PdfSession(f.runtime as any,()=>f.worker as any);await session.load(new Uint8Array(8),1);
 const drawing=deferred<void>();f.page.render.mockReturnValueOnce({promise:drawing.promise,cancel:f.renderCancel});const canvas={getContext:()=>({}),style:{}} as any,layer={replaceChildren:vi.fn(),style:{setProperty:vi.fn()}} as any;
 const first=session.render(1,canvas,layer,1,500),obsolete=expect(first).rejects.toMatchObject({name:"AbortError"});await vi.waitFor(()=>expect(f.page.render).toHaveBeenCalledTimes(1));
 const second=session.render(2,canvas,layer,1.25,500);await Promise.resolve();await Promise.resolve();expect(f.page.render).toHaveBeenCalledTimes(1);
 drawing.resolve();await obsolete;await second;expect(f.renderCancel).toHaveBeenCalled();expect(f.page.render).toHaveBeenCalledTimes(2);await session.close();
});

it("does not publish stale text extraction after a newer page has rendered",async()=>{
 const f=fixture(),session=new api.PdfSession(f.runtime as any,()=>f.worker as any);await session.load(new Uint8Array(8),1);
 const extraction=deferred<any>();f.page.getTextContent.mockImplementationOnce(()=>extraction.promise);
 const canvas={getContext:()=>({}),style:{}} as any,layer={replaceChildren:vi.fn(),style:{setProperty:vi.fn()}} as any;
 const first=session.render(1,canvas,layer,1,500),obsolete=expect(first).rejects.toMatchObject({name:"AbortError"});await vi.waitFor(()=>expect(f.page.getTextContent).toHaveBeenCalledTimes(1));
 await session.render(3,canvas,layer,1,500);const count=layer.replaceChildren.mock.calls.length;extraction.resolve({items:[]});await obsolete;expect(layer.replaceChildren).toHaveBeenCalledTimes(count);await session.close();
});
it("retires an unresolved text layer before replacing its DOM",async()=>{
 const f=fixture(),textDone=deferred<void>(),textCancel=vi.fn(),started=vi.fn();let layers=0;
 f.runtime.TextLayer=class{render(){started();return layers++===0?textDone.promise:Promise.resolve();}cancel=textCancel;};
 const session=new api.PdfSession(f.runtime as any,()=>f.worker as any);await session.load(new Uint8Array(8),1);
 const canvas={getContext:()=>({}),style:{}} as any,layer={replaceChildren:vi.fn(),style:{setProperty:vi.fn()}} as any;
 const first=session.render(1,canvas,layer,1,500),obsolete=expect(first).rejects.toMatchObject({name:"AbortError"});await vi.waitFor(()=>expect(started).toHaveBeenCalledOnce());
 const second=session.render(2,canvas,layer,1,500);await Promise.resolve();await Promise.resolve();expect(layer.replaceChildren).toHaveBeenCalledOnce();expect(textCancel).toHaveBeenCalled();
 textDone.resolve();await obsolete;await second;expect(layer.replaceChildren).toHaveBeenCalledTimes(2);await session.close();
});

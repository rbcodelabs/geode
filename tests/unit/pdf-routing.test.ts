import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
vi.mock("../../src/renderer/views/pdf-view",()=>({PdfView:class{viewType="pdf";setFile=vi.fn(async()=>{});onClose=vi.fn(async()=>{});}}));
it("routes PDF app opening through the native file-backed path",async()=>{
 const app=Object.create(App.prototype) as any,leaf={};app.workspace={findLeafForFile:()=>null,getLeaf:()=>leaf};app.openFileInLeaf=vi.fn(async()=>{});app.notify=vi.fn();const file={path:"Guide.pdf",extension:"pdf"};
 await app.openFile(file,false);expect(app.openFileInLeaf).toHaveBeenCalledWith(leaf,file);expect(app.notify).not.toHaveBeenCalled();
});
it("creates a PDF view instead of reading PDF bytes as Markdown",async()=>{
 const app=Object.create(App.prototype) as any,leaf={view:null,setView:vi.fn(async()=>{})};await app.mountDocumentInLeaf(leaf,{path:"Guide.pdf",extension:"pdf"},false);expect(leaf.setView.mock.calls[0][0].viewType).toBe("pdf");
});
it("waits for root-owned PDF disposal before closing the vault",async()=>{
 const {pdfDocumentCapacity}=await import("../../src/renderer/pdf/capacity");const app=Object.create(App.prototype) as any,events:string[]=[];let release!:()=>void;
 pdfDocumentCapacity(app).acquire(()=>new Promise<void>(done=>{events.push("pdf");release=done;}));
 Object.assign(app,{clearReconcileState:vi.fn(),reconcileGeneration:0,sync:{cancel:vi.fn(async()=>{})},hostDisposers:new Set(),reconcileInFlight:null,saveLayoutTimer:null,teardownLaunchSequence:vi.fn(),vault:{close:vi.fn(async()=>{events.push("vault")})},metadataCache:{dispose:vi.fn()},workspace:{dispose:vi.fn()}});
 const closing=app.dispose();await vi.waitFor(()=>expect(events).toEqual(["pdf"]));release();await closing;expect(events).toEqual(["pdf","vault"]);expect(pdfDocumentCapacity(app).size).toBe(0);
});

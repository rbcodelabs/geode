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
it("restores malformed persisted PDF pages to the first page",async()=>{
 const {Workspace}=await import("../../src/renderer/workspace");for(const page of [-1,1.5,NaN,1001,"3"]){const view={setFile:vi.fn(async()=>{}),onClose:vi.fn(async()=>{})},workspace=Object.create(Workspace.prototype) as any,file={path:"Guide.pdf"},leaf={setView:vi.fn(async()=>{})};workspace.app={vault:{getFileByPath:()=>file},createPdfView:()=>view};await workspace.restoreLeafView(leaf,{type:"pdf",file:"Guide.pdf",state:{page}});expect(view.setFile).toHaveBeenCalledWith(file,1);expect(leaf.setView).toHaveBeenCalledWith(view);}
});
it("closes an unpublished PDF view when restoration initialization rejects",async()=>{
 const {Workspace}=await import("../../src/renderer/workspace");const view={setFile:vi.fn(async()=>{throw Error("refused")}),onClose:vi.fn(async()=>{})},workspace=Object.create(Workspace.prototype) as any,leaf={setView:vi.fn(async()=>{})};workspace.app={vault:{getFileByPath:()=>({path:"Guide.pdf"})},createPdfView:()=>view};await expect(workspace.restoreLeafView(leaf,{type:"pdf",file:"Guide.pdf"})).rejects.toThrow("refused");expect(view.onClose).toHaveBeenCalledOnce();expect(leaf.setView).not.toHaveBeenCalled();
});

import { afterEach, expect, it, vi } from "vitest";
import { FakeDocument, settle } from "../helpers/fake-dom";
import { Events } from "../../src/renderer/events";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { pdfDocumentCapacity } from "../../src/renderer/pdf/capacity";
const api=await import("../../src/renderer/pdf/frame").catch(()=>({})) as typeof import("../../src/renderer/pdf/frame");
afterEach(()=>vi.unstubAllGlobals());
function fixture(read=vi.fn(async()=>new TextEncoder().encode("%PDF-1.7").buffer)) {
 const doc=new FakeDocument(),create=doc.createElement.bind(doc);vi.spyOn(doc,"createElement").mockImplementation(name=>{const el=create(name);(el as any).style={};return el;});vi.stubGlobal("document",doc);
 const app={workspace:new Events(),isDarkMode:vi.fn(()=>false),host:{pdfResources:{read,cancel:vi.fn(async()=>{})}},vault:{root:"/vault"}},owner=new RenderOwnership().create({});return {doc,app,owner};
}
it("denies the fifth PDF before bytes or iframe creation and allows explicit retry after release",async()=>{
 expect(api.PdfFrame).toBeTypeOf("function");const f=fixture(),capacity=pdfDocumentCapacity(f.app),leases=Array.from({length:4},()=>capacity.acquire(async()=>{})!);
 const frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1});await frame.open();expect(f.app.host.pdfResources.read).not.toHaveBeenCalled();expect(f.doc.createElement).not.toHaveBeenCalledWith("iframe");expect(frame.containerEl.textContent).toMatch(/four|capacity/i);
 await leases[0].close();await frame.close();await capacity.closeAll();await f.owner.close();
});
it("cancels pending native reads but retains the document lease until actual settlement",async()=>{
 expect(api.PdfFrame).toBeTypeOf("function");let resolve!:(bytes:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(done=>resolve=done),f=fixture(vi.fn(()=>pending));
 const frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1}),opening=frame.open();await settle();expect(pdfDocumentCapacity(f.app).size).toBe(1);
 const closing=frame.close();await settle();expect(f.app.host.pdfResources.cancel).toHaveBeenCalledOnce();expect(pdfDocumentCapacity(f.app).size).toBe(1);
 resolve(new TextEncoder().encode("%PDF-1.7").buffer);await opening;await closing;expect(pdfDocumentCapacity(f.app).size).toBe(0);expect(f.doc.createElement).not.toHaveBeenCalledWith("iframe");await f.owner.close();
});
it("shows an unsupported host without falling back to arbitrary binary reads",async()=>{
 expect(api.PdfFrame).toBeTypeOf("function");const f=fixture();delete(f.app.host as any).pdfResources;
 const frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1});await frame.open();expect(frame.containerEl.textContent).toMatch(/unsupported|desktop/i);await frame.close();await f.owner.close();
});
it("mounts with an exact-origin private port, accepts current state, and disposes its original generation once",async()=>{
 expect(api.PdfFrame).toBeTypeOf("function");const f=fixture(),create=(name:string)=>FakeDocument.prototype.createElement.call(f.doc,name),dispose=vi.fn(),loads=vi.fn(),appearance=vi.fn();let childPort:MessagePort|undefined;
 vi.mocked(f.doc.createElement).mockImplementation(name=>{
  const el=create(name) as any;el.style={};
  if(name==="iframe"){
   el.contentWindow={postMessage:(init:any,origin:string,ports:MessagePort[])=>{
    expect(origin).toBe("geode-pdf://viewer");childPort=ports[0];childPort.onmessage=event=>{
     if(event.data.kind==="appearance")appearance(event.data);
     if(event.data.kind==="load"){loads(event.data);childPort!.postMessage({kind:"state",version:1,generation:init.generation,page:2,count:3,zoom:1});}
     if(event.data.kind==="dispose"){dispose(event.data);childPort!.postMessage({kind:"disposed",version:1,generation:event.data.generation});childPort!.close();}
    };
    childPort.postMessage({...init,kind:"geode-pdf-ready",realm:Object.fromEntries(["process","require","geode","electron","ipcRenderer","Buffer"].map(key=>[key,"undefined"]))});
   }};
   Object.defineProperty(el,"src",{set:()=>queueMicrotask(()=>el.dispatch("load"))});
  }return el;
 });
 const changed=vi.fn(),frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1,onPage:changed});await frame.open();
 await vi.waitFor(()=>expect(changed).toHaveBeenCalledWith(2));expect(loads).toHaveBeenCalledOnce();expect(frame.page).toBe(2);
 f.app.isDarkMode.mockReturnValue(true);f.app.workspace.trigger("css-change");await vi.waitFor(()=>expect(appearance).toHaveBeenCalledWith({kind:"appearance",version:1,generation:1,theme:"dark"}));expect(f.app.host.pdfResources.read).toHaveBeenCalledOnce();
 expect(()=>frame.navigate(99)).toThrow(/page/i);expect(frame.page).toBe(2);
 frame.navigate(3);expect(frame.page).toBe(2);
 await f.owner.freezeAndDrain();childPort!.postMessage({kind:"state",version:1,generation:1,page:3,count:3,zoom:1});await new Promise(done=>setTimeout(done,15));expect(frame.page).toBe(2);
 f.owner.resume();childPort!.postMessage({kind:"state",version:1,generation:1,page:1,count:3,zoom:1});await vi.waitFor(()=>expect(frame.page).toBe(1));
 childPort!.postMessage({kind:"state",version:1,generation:99,page:3,count:3,zoom:1});await new Promise(done=>setTimeout(done,15));expect(frame.page).toBe(1);
 childPort!.postMessage({kind:"error",version:1,generation:1,message:"Synthetic render failure"});await vi.waitFor(()=>expect(frame.containerEl.textContent).toContain("Synthetic render failure"));
 await frame.close();expect(dispose).toHaveBeenCalledOnce();expect(dispose.mock.calls[0][0].generation).toBe(1);expect(pdfDocumentCapacity(f.app).size).toBe(0);childPort?.close();await f.owner.close();
});
it("restarts only ownership-interrupted initialization after the owned read settles",async()=>{
 let resolve!:(bytes:ArrayBuffer)=>void;const read=vi.fn(()=>new Promise<ArrayBuffer>(done=>resolve=done)),f=fixture(read),frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1});
 const opening=frame.open();await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());const holding=f.owner.freezeAndDrain();resolve(new TextEncoder().encode("%PDF-1.7").buffer);await opening;await holding;expect(f.doc.createElement).not.toHaveBeenCalledWith("iframe");expect(pdfDocumentCapacity(f.app).size).toBe(1);
 f.owner.resume();await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(2));expect(pdfDocumentCapacity(f.app).size).toBe(1);const closing=frame.close();resolve(new TextEncoder().encode("%PDF-1.7").buffer);await closing;expect(f.doc.createElement).not.toHaveBeenCalledWith("iframe");expect(pdfDocumentCapacity(f.app).size).toBe(0);await f.owner.close();
});
it("does not automatically retry failed documents when ownership resumes",async()=>{
 const read=vi.fn(async()=>{throw Error("synthetic corrupt read")}),f=fixture(read),frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1});await frame.open();expect(frame.containerEl.textContent).toContain("synthetic corrupt read");await f.owner.freezeAndDrain();f.owner.resume();await settle();expect(read).toHaveBeenCalledOnce();await frame.close();expect(pdfDocumentCapacity(f.app).size).toBe(0);await f.owner.close();
});
it("retires an undecoded frame before restarting after an ownership hold",async()=>{
 const f=fixture(),create=(name:string)=>FakeDocument.prototype.createElement.call(f.doc,name);let loads=0,acknowledge:(()=>void)|undefined,firstPort:MessagePort|undefined;
 vi.mocked(f.doc.createElement).mockImplementation(name=>{const el=create(name) as any;el.style={};if(name==="iframe"){el.contentWindow={postMessage:(init:any,_origin:string,ports:MessagePort[])=>{const child=ports[0];firstPort??=child;child.onmessage=event=>{if(event.data.kind==="load"){loads++;if(loads===2)child.postMessage({kind:"state",version:1,generation:init.generation,page:1,count:3,zoom:1});}if(event.data.kind==="dispose"){const finish=()=>{child.postMessage({kind:"disposed",version:1,generation:init.generation});child.close();};if(loads===1)acknowledge=finish;else finish();}};child.postMessage({...init,kind:"geode-pdf-ready",realm:Object.fromEntries(["process","require","geode","electron","ipcRenderer","Buffer"].map(key=>[key,"undefined"]))});}};Object.defineProperty(el,"src",{set:()=>queueMicrotask(()=>el.dispatch("load"))});}return el;});
 const changed=vi.fn(),frame=new api.PdfFrame(f.app as any,f.owner,{path:"Guide.pdf",label:"Guide.pdf",page:1,onPage:changed});await frame.open();await vi.waitFor(()=>expect(loads).toBe(1));await f.owner.freezeAndDrain();firstPort!.postMessage({kind:"state",version:1,generation:1,page:2,count:3,zoom:1});await new Promise(done=>setTimeout(done,15));expect(changed).not.toHaveBeenCalled();f.owner.resume();
 await vi.waitFor(()=>expect(acknowledge).toBeTypeOf("function"));expect(f.app.host.pdfResources.read).toHaveBeenCalledOnce();expect(pdfDocumentCapacity(f.app).size).toBe(1);acknowledge!();await vi.waitFor(()=>expect(changed).toHaveBeenCalledWith(1));expect(f.app.host.pdfResources.read).toHaveBeenCalledTimes(2);expect(pdfDocumentCapacity(f.app).size).toBe(1);await frame.close();await f.owner.close();
});

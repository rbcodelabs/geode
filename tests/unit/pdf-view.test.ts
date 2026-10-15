import {afterEach,expect,it,vi} from "vitest";
import {FakeDocument} from "../helpers/fake-dom";
const frames=vi.hoisted(()=>[] as any[]);
vi.mock("../../src/renderer/workspace",()=>({buildViewHeaderNavButtons:()=>document.createElement("div")}));
vi.mock("../../src/renderer/pdf/frame",()=>({PdfFrame:class{containerEl=document.createElement("div");page=1;open=vi.fn(async()=>{});close=vi.fn(async()=>{});navigate=vi.fn();constructor(_app:any,_owner:any,readonly options:any){frames.push(this);}}}));
import {PdfView} from "../../src/renderer/views/pdf-view";
afterEach(()=>{vi.unstubAllGlobals();frames.length=0;});
function fixture(){const doc=new FakeDocument(),create=doc.createElement.bind(doc);vi.spyOn(doc,"createElement").mockImplementation(name=>{const el=create(name);(el as any).style={};return el;});vi.stubGlobal("document",doc);const handlers=new Map<string,Function>(),app={vault:{root:"/vault",on:vi.fn((event:string,callback:Function)=>{handlers.set(event,callback);return vi.fn();})},workspace:{trigger:vi.fn()},notify:vi.fn()};const view=new PdfView(app as any);return {app,view,handlers,file:{path:"Guide.pdf",name:"Guide.pdf",basename:"Guide",extension:"pdf"} as any};}
it("prepares the detached tab without loading a frame, then starts it only in onOpen",async()=>{
 const f=fixture();await f.view.setFile(f.file);expect(frames[0].open).not.toHaveBeenCalled();await f.view.onOpen();expect(frames[0].open).toHaveBeenCalledOnce();await f.view.setFile(f.file);expect(frames[1].open).toHaveBeenCalledOnce();await f.view.onClose();
});
it("observes external reload refusal without discarding the current PDF",async()=>{
 const f=fixture();await f.view.setFile(f.file);await f.view.onOpen();await f.view.renderOwner.freezeAndDrain();f.handlers.get("modify")!(f.file);await vi.waitFor(()=>expect(f.app.notify).toHaveBeenCalledWith(expect.stringContaining("reload")));expect(f.view.getFile()).toBe(f.file);f.view.renderOwner.resume();expect(frames[0].options.current()).toBe(true);await f.view.onClose();
});
it("observes failed delete cleanup and keeps a visible failure",async()=>{
 const f=fixture();await f.view.setFile(f.file);frames[0].close.mockRejectedValueOnce(Error("synthetic close failure"));f.handlers.get("delete")!(f.file);await vi.waitFor(()=>expect(f.app.notify).toHaveBeenCalledWith(expect.stringContaining("close")));expect(f.view.containerEl.textContent).toContain("Could not close");await f.view.onClose();
});
it("rejects invalid initial pages before creating a frame or starting resources",async()=>{
 const f=fixture();for(const page of [-1,0,1.5,1001])await expect(f.view.setFile(f.file,page)).rejects.toThrow(/page/);expect(frames).toHaveLength(0);await f.view.onClose();
});
it("never starts a prepared frame after its tab has closed",async()=>{
 const f=fixture();await f.view.setFile(f.file);await f.view.onClose();await f.view.onOpen();expect(frames[0].open).not.toHaveBeenCalled();expect(frames[0].close).toHaveBeenCalled();
});

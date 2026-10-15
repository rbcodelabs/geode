import * as api from "./display-entry";
import { PdfSession } from "./session";
import { createPdfFrameInitializer, PDF_FRAME_NODE_KEYS, pdfFrameRealm } from "./handshake";
import { isPdfHostMessage, type PdfViewerMessage } from "../../shared/pdf-viewer-protocol";
const realm = pdfFrameRealm(globalThis);
if (PDF_FRAME_NODE_KEYS.some(key=>realm[key]!=="undefined")) throw new Error("PDF viewer requires an isolated document.");
const element = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const previous=element<HTMLButtonElement>("previous"),next=element<HTMLButtonElement>("next"),pageInput=element<HTMLInputElement>("page"),count=element("count"),zoomInput=element<HTMLSelectElement>("zoom"),fit=element<HTMLButtonElement>("fit"),status=element("status"),viewport=element("viewport"),sheet=element("sheet"),canvas=element<HTMLCanvasElement>("canvas"),text=element("text");
let session:PdfSession|undefined,port:MessagePort|undefined,generation=0,page=1,zoom:number|"fit"="fit",disposed=false,loaded=false,renderGeneration=0;
const send=(message:PdfViewerMessage)=>{if(!disposed)port?.postMessage(message);};
function controls(enabled:boolean):void { previous.disabled=!enabled||page<=1;next.disabled=!enabled||page>=(session?.count??0);for(const control of [pageInput,zoomInput,fit])control.disabled=!enabled;pageInput.value=String(page);count.textContent=session?.count?`/ ${session.count}`:"/ —"; }
function errorMessage(error:unknown):string { const message=error instanceof Error?error.message:String(error);return message.slice(0,400); }
async function render():Promise<void> {
  if(!session?.count||disposed)return;const current=++renderGeneration;controls(true);viewport.setAttribute("aria-busy","true");status.hidden=false;status.className="";status.textContent="Rendering page…";
  try { const state=await session.render(page,canvas,text,zoom,Math.max(120,viewport.clientWidth-(innerWidth<=340?16:32)));if(disposed||current!==renderGeneration)return;sheet.hidden=false;status.hidden=true;viewport.setAttribute("aria-busy","false");text.setAttribute("aria-label",`PDF text, page ${page}`);send({kind:"state",version:1,generation,...state}); }
  catch(error) { if(disposed||current!==renderGeneration||(error instanceof Error&&error.name==="AbortError"))return;sheet.hidden=true;status.hidden=false;status.className="error";status.textContent=errorMessage(error);send({kind:"error",version:1,generation,message:errorMessage(error)}); }
}
function navigate(value:number):void { if(!session||!Number.isSafeInteger(value)||value<1||value>session.count){pageInput.setAttribute("aria-invalid","true");status.hidden=false;status.className="error";status.textContent=`Choose a page from 1 to ${session?.count??1}.`;return;}pageInput.removeAttribute("aria-invalid");page=value;viewport.scrollTop=0;void render(); }
previous.addEventListener("click",()=>navigate(page-1));next.addEventListener("click",()=>navigate(page+1));pageInput.addEventListener("change",()=>navigate(Number(pageInput.value)));pageInput.addEventListener("keydown",event=>{if(event.key==="Enter")navigate(Number(pageInput.value));});zoomInput.addEventListener("change",()=>{zoom=zoomInput.value==="fit"?"fit":Number(zoomInput.value);void render();});fit.addEventListener("click",()=>{zoom="fit";zoomInput.value="fit";void render();});
let resizeTimer:ReturnType<typeof setTimeout>|undefined;
const resize=new ResizeObserver(()=>{if(zoom!=="fit"||!loaded)return;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>void render(),120);});resize.observe(viewport);
addEventListener("message",createPdfFrameInitializer(parent,({init,port:accepted})=>{
  port=accepted;generation=init.generation;port.postMessage({...init,kind:"geode-pdf-ready",realm});
  port.addEventListener("message",async event=>{
    if(!isPdfHostMessage(event.data)||event.data.generation!==generation||disposed)return;
    if(event.data.kind==="dispose") { disposed=true;renderGeneration++;resize.disconnect();clearTimeout(resizeTimer);try{await session?.close();}finally{port?.postMessage({kind:"disposed",version:1,generation});port?.close();}return; }
    if(event.data.kind==="navigate"){if(session?.count)navigate(event.data.page);else page=event.data.page;return;}
    if(loaded)return;loaded=true;page=event.data.page;document.title=event.data.label;document.documentElement.dataset.theme=event.data.theme??"light";session=new PdfSession(api);
    try{await session.load(new Uint8Array(event.data.bytes),page);if(!disposed)await render();}
    catch(error){if(disposed)return;status.className="error";status.textContent=errorMessage(error);send({kind:"error",version:1,generation,message:errorMessage(error)});}
  });port.start();
}));
addEventListener("pagehide",()=>{disposed=true;resize.disconnect();clearTimeout(resizeTimer);void session?.close();port?.close();});

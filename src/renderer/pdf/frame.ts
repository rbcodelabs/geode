import type { HostServices } from "../host/contracts";
import { RenderScope, type RenderToken } from "../workspaces/render-ownership";
import { pdfDocumentCapacity, type PdfDocumentLease } from "./capacity";
import { PDF_VIEWER_BUILD, waitForPdfFrameReady, type PdfFrameInit } from "./handshake";
import { isPdfViewerMessage, PDF_VIEWER_ORIGIN, PDF_VIEWER_URL } from "../../shared/pdf-viewer-protocol";
import { PDF_LIMITS } from "../../shared/pdf";
interface PdfFrameApp { host:Pick<HostServices,"pdfResources">;vault:{root:string};isDarkMode?():boolean }
export interface PdfFrameOptions { path:string;label:string;page:number;height?:number;current?():boolean;onPage?(page:number):void }
function nonce():string { return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,"0")).join(""); }
function cancelled():Error { const error=new Error("PDF loading cancelled.");error.name="AbortError";return error; }
/** Host owns only authorization, a fixed iframe, and its private bounded port. */
export class PdfFrame {
  readonly containerEl:HTMLElement;
  readonly renderOwner:RenderScope;
  private readonly status:HTMLElement;
  private readonly retry:HTMLButtonElement;
  private readonly root:string;
  private lease:PdfDocumentLease|undefined;
  private iframe:HTMLIFrameElement|undefined;
  private port:MessagePort|undefined;
  private abort:AbortController|undefined;
  private pendingRead:Promise<ArrayBuffer>|undefined;
  private readId:string|undefined;
  private cancelSent=false;
  private cleanup:Promise<void>|undefined;
  private closed=false;
  private generation=0;
  private transportGeneration=0;
  private currentPage=1;
  private requestedPage:number;
  private pageCount:number|undefined;
  constructor(private readonly app:PdfFrameApp,parent:RenderScope,private readonly options:PdfFrameOptions) {
    this.renderOwner=parent.child({close:()=>this.closeNative()});this.root=app.vault.root;this.requestedPage=options.page;
    this.containerEl=document.createElement("div");this.containerEl.className="pdf-frame";
    Object.assign(this.containerEl.style,{position:"relative",height:options.height?`${options.height}px`:"100%",minHeight:"120px",width:"100%",flex:"1",overflow:"hidden"});
    this.status=document.createElement("div");this.status.className="pdf-frame-status";this.status.setAttribute("role","status");Object.assign(this.status.style,{position:"absolute",inset:"0",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:"12px",padding:"16px",textAlign:"center",background:"var(--background-primary)"});
    this.retry=document.createElement("button");this.retry.type="button";this.retry.textContent="Retry PDF";this.retry.hidden=true;this.retry.addEventListener("click",()=>void this.open());
    this.containerEl.append(this.status);this.show("Loading PDF…",false);
  }
  get page():number {return this.currentPage;}
  navigate(page:number):void {if(!Number.isSafeInteger(page)||page<1||page>(this.pageCount??PDF_LIMITS.pages))throw new Error("Unsupported PDF page.");this.requestedPage=page;this.port?.postMessage({kind:"navigate",version:1,generation:this.transportGeneration,page});}
  private show(message:string,error:boolean):void {this.status.hidden=false;this.status.style.display="flex";this.status.setAttribute("role",error?"alert":"status");this.status.textContent=message.slice(0,400);this.retry.hidden=!error;this.retry.disabled=false;this.status.append(this.retry);}
  private valid(token?:RenderToken):boolean {return !this.closed&&this.app.vault.root===this.root&&(this.options.current?.()??true)&&(token?.current()??true);}
  private cancelRead():void {
    if(!this.pendingRead||!this.readId||this.cancelSent)return;this.cancelSent=true;
    // Completion/root change can win the cancellation race. Actual read
    // settlement and generation checks still govern release/publication.
    void this.app.host.pdfResources?.cancel(this.root,this.readId).catch(()=>{});
  }
  async open():Promise<void> {
    if(this.closed)return;
    const generation=++this.generation;this.retry.disabled=true;this.show("Loading PDF…",false);
    try {await this.renderOwner.run(async token=>{
      try {
        const resources=this.app.host.pdfResources;
        if(!resources){this.show("PDF viewing is unsupported on this host. Use the desktop app.",false);return;}
        if(!this.lease)this.lease=pdfDocumentCapacity(this.app).acquire(()=>this.disposeTransport());
        if(!this.lease){this.show("Up to four PDFs can be open at once. Close another PDF, then retry.",true);return;}
        await this.disposeTransport();token.check();if(!this.valid(token)||generation!==this.generation)return;
        this.abort=new AbortController();this.cancelSent=false;const id=nonce();this.readId=id;
        const read=resources.read(this.root,this.options.path,id);this.pendingRead=read;
        void read.then(()=>{if(this.pendingRead===read)this.pendingRead=undefined;},()=>{if(this.pendingRead===read)this.pendingRead=undefined;});
        const bytes=await this.untilCancelled(read,15000);token.check();if(!this.valid(token)||generation!==this.generation)return;
        if(bytes.byteLength<5||bytes.byteLength>PDF_LIMITS.bytes)throw new Error("PDF exceeds the supported byte limit or is empty.");
        await this.mount(bytes,generation,token);
      }catch(error){if(this.valid(token)&&generation===this.generation){this.show(error instanceof Error?error.message:String(error),true);this.cancelRead();void this.disposeTransport();}}
    });}catch(error){if(this.valid())this.show(error instanceof Error?error.message:String(error),true);}
  }
  private untilCancelled<T>(promise:Promise<T>,milliseconds:number):Promise<T> {
    const signal=this.abort?.signal;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);};
      const abort=()=>{cleanup();reject(cancelled());};
      const timer=setTimeout(()=>{cleanup();this.cancelRead();reject(new Error("PDF loading timed out. Retry this document."));},milliseconds);
      signal?.addEventListener("abort",abort,{once:true});promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});if(signal?.aborted)abort();
    });
  }
  private async mount(bytes:ArrayBuffer,generation:number,token:RenderToken):Promise<void> {
    const frame=document.createElement("iframe");this.iframe=frame;this.transportGeneration=generation;frame.className="pdf-viewer-frame";frame.title=this.options.label.slice(0,160);frame.setAttribute("sandbox","allow-scripts allow-same-origin");frame.setAttribute("allow","camera 'none'; microphone 'none'; geolocation 'none'");Object.assign(frame.style,{border:"0",width:"100%",height:"100%",display:"block",visibility:"hidden"});
    const channel=new MessageChannel();this.port=channel.port1;
    const init:PdfFrameInit={kind:"geode-pdf-init",version:1,build:PDF_VIEWER_BUILD,generation,nonce:nonce()};let loads=0;
    const ready=new Promise<void>((resolve,reject)=>{
      frame.addEventListener("load",()=>{
        if(!this.valid(token)||generation!==this.generation||this.iframe!==frame)return;
        if(loads++){this.show("PDF viewer reloaded. Retry this document.",true);void this.disposeTransport();return;}
        const pending=waitForPdfFrameReady(channel.port1,init,()=>this.valid(token)&&generation===this.generation,this.abort?.signal);
        frame.contentWindow?.postMessage(init,PDF_VIEWER_ORIGIN,[channel.port2]);void pending.then(resolve,reject);
      });frame.addEventListener("error",()=>reject(new Error("PDF viewer could not start. Retry this document.")));
    });
    channel.port1.addEventListener("message",event=>{
      if(!this.valid(token)||generation!==this.generation||this.iframe!==frame||!isPdfViewerMessage(event.data)||event.data.generation!==generation)return;
      if(event.data.kind==="state"){this.status.hidden=true;this.status.style.display="none";frame.style.visibility="visible";this.pageCount=event.data.count;this.currentPage=event.data.page;this.requestedPage=this.currentPage;this.options.onPage?.(this.currentPage);}
      if(event.data.kind==="error"){if(this.pageCount===undefined){this.currentPage=1;this.requestedPage=1;this.options.onPage?.(1);}this.show(event.data.message,true);void this.disposeTransport();}
    });channel.port1.start();frame.src=PDF_VIEWER_URL;this.containerEl.append(frame);
    await this.untilCancelled(ready,8000);token.check();if(!this.valid(token)||generation!==this.generation)return;
    channel.port1.postMessage({kind:"load",version:1,generation,bytes,page:this.requestedPage,height:this.options.height,label:this.options.label.slice(0,160),theme:this.app.isDarkMode?.()?"dark":"light"},[bytes]);
  }
  close():Promise<void> {this.closed=true;this.generation++;this.abort?.abort();this.cancelRead();return this.renderOwner.close();}
  private async closeNative():Promise<void> {this.closed=true;this.generation++;this.abort?.abort();this.cancelRead();if(this.lease)await this.lease.close();else await this.disposeTransport();this.containerEl.remove();}
  private disposeTransport():Promise<void> {
    if(this.cleanup)return this.cleanup;
    this.abort?.abort();this.cancelRead();const frame=this.iframe,port=this.port,generation=this.transportGeneration;this.iframe=undefined;this.port=undefined;
    this.cleanup=(async()=>{
      // Do not release a lease while an owned native read is still alive.
      if(this.pendingRead)await this.pendingRead.catch(()=>{});
      if(port&&frame)await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);port.removeEventListener("message",ack);resolve();};
        const ack=(event:MessageEvent)=>{if(isPdfViewerMessage(event.data)&&event.data.kind==="disposed"&&event.data.generation===generation)finish();};
        const timer=setTimeout(finish,1800);port.addEventListener("message",ack);try{port.postMessage({kind:"dispose",version:1,generation});}catch{finish();}
      });
      port?.close();frame?.remove();
    })().finally(()=>{this.cleanup=undefined;});return this.cleanup;
  }
}

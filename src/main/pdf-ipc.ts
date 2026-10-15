import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { readAuthorizedPdf } from "./pdf-resource";
interface PdfReadAuthority { root: string; identity: object; current(): boolean }
interface ActiveRead { authority: PdfReadAuthority; frame: Electron.WebFrameMain; cancelled: boolean }
function request(value: unknown, reading: boolean): Record<string,string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid PDF read request.");
  const input = value as Record<string,unknown>, keys=reading?["root","path","id"]:["root","id"];
  if (Object.keys(input).some(key=>!keys.includes(key)) || keys.some(key=>typeof input[key]!=="string") || (input.root as string).length>4096 || (reading&&(input.path as string).length>4096) || !/^[a-f0-9]{64}$/.test(input.id as string)) throw new Error("Invalid PDF read request.");
  return input as Record<string,string>;
}
function mainFrame(event:IpcMainInvokeEvent):Electron.WebFrameMain {
  if(event.sender.isDestroyed()||!event.senderFrame||event.senderFrame!==event.sender.mainFrame)throw new Error("PDF reads require the current main application frame.");return event.senderFrame;
}
/** Only active IDs exist: max four per sender, no completed-ID or cancellation queue. */
export function registerPdfReadIpc(ipc:Pick<IpcMain,"handle">,authorityFor:(event:IpcMainInvokeEvent)=>PdfReadAuthority,read:typeof readAuthorizedPdf=readAuthorizedPdf):void {
  const senders=new WeakMap<object,Map<string,ActiveRead>>();
  ipc.handle("vault-read-pdf",async(event:IpcMainInvokeEvent,value:unknown)=>{
    const frame=mainFrame(event),input=request(value,true),authority=authorityFor(event),sender=event.sender;
    if(input.root!==authority.root||!authority.current())throw new Error("PDF vault session changed.");
    let active=senders.get(sender);if(!active){active=new Map();senders.set(sender,active);}
    if(active.has(input.id))throw new Error("PDF read ID is already active.");
    if(active.size>=4)throw new Error("PDF reads are busy. Retry after another PDF finishes loading.");
    const entry:ActiveRead={authority,frame,cancelled:false};active.set(input.id,entry);
    const current=()=>!entry.cancelled&&!sender.isDestroyed()&&sender.mainFrame===frame&&authority.current();
    const check=()=>{if(!current())throw new Error("PDF read cancelled or vault session changed.");};
    try { await Promise.resolve();check();const bytes=await read({root:authority.root,expectedRoot:input.root,path:input.path,current});check();return bytes; }
    finally { active.delete(input.id);if(!active.size)senders.delete(sender); }
  });
  ipc.handle("vault-cancel-pdf-read",async(event:IpcMainInvokeEvent,value:unknown)=>{
    const frame=mainFrame(event),input=request(value,false),authority=authorityFor(event),entry=senders.get(event.sender)?.get(input.id);
    if(!entry||entry.cancelled||entry.frame!==frame||entry.authority.root!==input.root||authority.root!==input.root||entry.authority.identity!==authority.identity||!entry.authority.current()||!authority.current())throw new Error("PDF read ID is not active in this vault session or was already cancelled.");
    entry.cancelled=true;
  });
}

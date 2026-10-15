import { expect,it,vi } from "vitest";
import { ImageParserTransport } from "../../src/renderer/image-inspection/parser-transport";
import { BUILD } from "../../src/renderer/image-inspection/parser-protocol";
function browser(){
 const frame=new EventTarget() as EventTarget & {removed:boolean;contentWindow:{postMessage:ReturnType<typeof vi.fn>};setAttribute:ReturnType<typeof vi.fn>;remove:()=>void;style:object;tabIndex:number;src:string};
 let port:MessagePort|undefined;let init:Record<string,unknown>|undefined;
 Object.assign(frame,{removed:false,style:{},setAttribute:vi.fn(),remove:()=>{frame.removed=true;},contentWindow:{postMessage:vi.fn((value:Record<string,unknown>,_origin:string,ports:MessagePort[])=>{init=value;port=ports[0];port.start();})}});
 const doc={createElement:()=>frame,body:{append:vi.fn()}} as unknown as Document;
 const messages:Record<string,unknown>[]=[];
 return {doc,frame,messages,get init(){return init!;},get port(){return port!;},load(){frame.dispatchEvent(new Event("load"));port!.onmessage=event=>messages.push(event.data);},reply(value:object){port!.postMessage({...init,...value});},async ready(){this.load();this.reply({kind:"ready"});await vi.waitFor(()=>expect(init?.build).toBe(BUILD));}};
}
it("closes the actual transport during an incomplete broker handshake without waiting for readiness",async()=>{
 const b=browser(),transport=new ImageParserTransport(b.doc);
 const parse=transport.parse(""),rejected=expect(parse).rejects.toMatchObject({name:"AbortError"});
 b.load();expect(b.init.kind).toBe("initialize");const closed=transport.close();
 expect(b.frame.removed).toBe(true);await closed;await rejected;
 await expect(transport.parse("")).rejects.toThrow(/unavailable|closed/i);await transport.close();
});
it("settles cancellation only after the owned broker acknowledges local worker release",async()=>{
 const b=browser(),transport=new ImageParserTransport(b.doc),controller=new AbortController();
 const parsed=transport.parse("",controller.signal),rejected=expect(parsed).rejects.toMatchObject({name:"AbortError"});
 await b.ready();await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="parse")).toBe(true));
 const request=b.messages.find(message=>message.kind==="parse")!.request;
 b.reply({kind:"worker-ready",request});controller.abort();let settled=false;void parsed.catch(()=>{settled=true;});
 await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="cancel")).toBe(true));expect(settled).toBe(false);
 b.reply({kind:"cancelled",request,released:true});await rejected;
 const close=transport.close();await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="close")).toBe(true));b.reply({kind:"closed"});await close;expect(b.frame.removed).toBe(true);
});
it("rejects malformed owned-port replies and disables the transport instead of publishing",async()=>{
 const b=browser(),transport=new ImageParserTransport(b.doc);
 const parse=transport.parse(""),rejected=expect(parse).rejects.toThrow(/protocol/i);
 await b.ready();await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="parse")).toBe(true));
 b.reply({kind:"parsed",request:1,payload:{},unexpected:true});await rejected;expect(b.frame.removed).toBe(true);
 await expect(transport.parse("")).rejects.toThrow(/unavailable|closed/i);await expect(transport.close()).rejects.toThrow(/protocol/i);
});
it("does not publish a late parsed result after cancellation has started",async()=>{
 const b=browser(),transport=new ImageParserTransport(b.doc),controller=new AbortController();
 const parsed=transport.parse("",controller.signal),rejected=expect(parsed).rejects.toMatchObject({name:"AbortError"});await b.ready();
 await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="parse")).toBe(true));controller.abort();
 b.reply({kind:"parsed",request:1,payload:{version:1,sourceUnits:0,candidates:new Uint32Array(),definitions:new Uint32Array(),issues:new Uint32Array()}});
 b.reply({kind:"cancelled",request:1,released:true});await rejected;
 const close=transport.close();await vi.waitFor(()=>expect(b.messages.some(message=>message.kind==="close")).toBe(true));b.reply({kind:"closed"});await close;
});

import { expect,it,vi } from "vitest";
import { installParserBroker } from "../../src/renderer/image-inspection/parser-broker";
import { BUILD } from "../../src/renderer/image-inspection/parser-protocol";
function broker(){
 const parent={},scope=new EventTarget() as Window;Object.defineProperty(scope,"parent",{value:parent});
 const workers:{onmessage:((event:MessageEvent)=>void)|null;onerror:((event:Event)=>void)|null;onmessageerror:((event:Event)=>void)|null;postMessage:ReturnType<typeof vi.fn>;terminate:ReturnType<typeof vi.fn>}[]=[];
 installParserBroker(scope,()=>{const worker={onmessage:null,onerror:null,onmessageerror:null,postMessage:vi.fn(),terminate:vi.fn()};workers.push(worker);return worker as unknown as Worker;});
 const session={version:1 as const,build:BUILD,epoch:3,nonce:"a".repeat(64)};
 function initialize(value:object={kind:"initialize",...session},source:unknown=parent,origin="null"){
  const channel=new MessageChannel(),messages:Record<string,unknown>[]=[];channel.port1.onmessage=event=>messages.push(event.data);channel.port1.start();
  const event=new Event("message");Object.assign(event,{data:value,source,origin,ports:[channel.port2]});scope.dispatchEvent(event);
  return {channel,messages,send(value:object){channel.port1.postMessage({...session,...value});}};
 }
 return {scope,parent,session,workers,initialize};
}
it("accepts initialization only once from its actual file parent and the exact protocol identity",async()=>{
 const b=broker();const foreign=[b.initialize(undefined,{},"null"),b.initialize(undefined,b.parent,"https://synthetic.invalid"),b.initialize({kind:"initialize",...b.session,build:"old"}),b.initialize({kind:"initialize",...b.session,nonce:"short"})];
 const owned=b.initialize();await vi.waitFor(()=>expect(owned.messages).toHaveLength(1));expect(owned.messages[0].kind).toBe("ready");
 const duplicate=b.initialize();owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));
 for(const rejected of [...foreign,duplicate]){expect(rejected.messages).toHaveLength(0);rejected.channel.port1.close();rejected.channel.port2.close();}expect(b.workers).toHaveLength(0);owned.channel.port1.close();
});
it("terminates and detaches the active worker before cancellation ACK and permits a fresh worker only afterward",async()=>{
 const b=broker(),owned=b.initialize();await vi.waitFor(()=>expect(owned.messages[0]?.kind).toBe("ready"));
 owned.send({kind:"parse",request:1,source:""});await vi.waitFor(()=>expect(b.workers).toHaveLength(1));const old=b.workers[0],late=old.onmessage!;
 old.onmessage!({data:{kind:"worker-ready",version:1,build:BUILD}} as MessageEvent);expect(old.postMessage).toHaveBeenCalledTimes(1);
 owned.send({kind:"cancel",request:1});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="cancelled")).toBe(true));
 expect(old.terminate).toHaveBeenCalledTimes(1);expect(old.onmessage).toBeNull();expect(old.onerror).toBeNull();expect(old.onmessageerror).toBeNull();
 late({data:{kind:"parsed",...b.session,request:1,payload:{}}} as MessageEvent);expect(owned.messages.some(value=>value.kind==="parsed")).toBe(false);
 owned.send({kind:"parse",request:2,source:""});await vi.waitFor(()=>expect(b.workers).toHaveLength(2));owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));expect(b.workers[1].terminate).toHaveBeenCalledTimes(1);owned.channel.port1.close();
});
it("does not grant a foreign port work or allow malformed owned requests to create workers",async()=>{
 const b=broker(),owned=b.initialize();await vi.waitFor(()=>expect(owned.messages[0]?.kind).toBe("ready"));const foreign=b.initialize();
 foreign.send({kind:"parse",request:9,source:""});foreign.send({kind:"cancel",request:1});
 for(const value of [{kind:"parse",request:1,source:"",nonce:"b".repeat(64)},{kind:"parse",request:1,source:"",epoch:4},{kind:"parse",request:1,source:"",extra:true}])owned.send(value);
 // The ordered owned close reply is a positive liveness barrier after those requests.
 owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));expect(b.workers).toHaveLength(0);expect(foreign.messages).toHaveLength(0);foreign.channel.port1.close();foreign.channel.port2.close();owned.channel.port1.close();
});
it("keeps boot readiness private until a matching request-source admission arrives",async()=>{
 const b=broker(),owned=b.initialize();await vi.waitFor(()=>expect(owned.messages[0]?.kind).toBe("ready"));owned.send({kind:"parse",request:1,source:""});await vi.waitFor(()=>expect(b.workers).toHaveLength(1));
 b.workers[0].onmessage!({data:{kind:"worker-ready",version:1,build:BUILD}} as MessageEvent);expect(b.workers[0].postMessage).toHaveBeenCalledTimes(1);
 owned.send({kind:"cancel",request:1});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="cancelled")).toBe(true));expect(owned.messages.some(value=>value.kind==="worker-ready")).toBe(false);
 owned.send({kind:"parse",request:2,source:""});await vi.waitFor(()=>expect(b.workers).toHaveLength(2));b.workers[1].onmessage!({data:{kind:"worker-ready",version:1,build:BUILD}} as MessageEvent);
 b.workers[1].onmessage!({data:{kind:"worker-ready",...b.session,request:2}} as MessageEvent);await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="worker-ready"&&value.request===2)).toBe(true));
 owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));owned.channel.port1.close();
});
it.each(["wrong-session","wrong-request","duplicate-start","parsed-before-start","invalid-result","error"] as const)("terminates and disables the broker epoch after %s without automatic retry",async mode=>{
 const b=broker(),owned=b.initialize();await vi.waitFor(()=>expect(owned.messages[0]?.kind).toBe("ready"));owned.send({kind:"parse",request:1,source:""});await vi.waitFor(()=>expect(b.workers).toHaveLength(1));const worker=b.workers[0];
 worker.onmessage!({data:{kind:"worker-ready",version:1,build:BUILD}} as MessageEvent);
 const start={kind:"worker-ready",...b.session,request:1},payload={version:1,sourceUnits:0,candidates:new Uint32Array(),definitions:new Uint32Array(),issues:new Uint32Array()};
 if(mode==="duplicate-start"||mode==="invalid-result")worker.onmessage!({data:start} as MessageEvent);
 if(mode==="error")worker.onerror!(new Event("error"));
 else worker.onmessage!({data:mode==="wrong-session"?{...start,nonce:"b".repeat(64)}:mode==="wrong-request"?{...start,request:2}:mode==="duplicate-start"?start:{kind:"parsed",...b.session,request:1,payload:mode==="invalid-result"?{}:payload}} as MessageEvent);
 await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="failed"&&value.request===1)).toBe(true));expect(worker.terminate).toHaveBeenCalledTimes(1);expect(worker.onmessage).toBeNull();
 owned.send({kind:"parse",request:2,source:""});owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));expect(b.workers).toHaveLength(1);owned.channel.port1.close();
});
it("preserves the first active request when busy and transfers its valid packed buffers",async()=>{
 const b=broker(),owned=b.initialize();await vi.waitFor(()=>expect(owned.messages[0]?.kind).toBe("ready"));owned.send({kind:"parse",request:1,source:"![[Photo.png]]"});await vi.waitFor(()=>expect(b.workers).toHaveLength(1));const worker=b.workers[0];
 worker.onmessage!({data:{kind:"worker-ready",version:1,build:BUILD}} as MessageEvent);
 const busyObserved=new Promise<void>(resolve=>{owned.channel.port2.addEventListener("message",function observe(event){if(event.data.request===2){owned.channel.port2.removeEventListener("message",observe);resolve();}});});
 owned.send({kind:"parse",request:2,source:""});await busyObserved;expect(b.workers).toHaveLength(1);expect(worker.terminate).not.toHaveBeenCalled();
 worker.onmessage!({data:{kind:"worker-ready",...b.session,request:1}} as MessageEvent);
 const payload={version:1,sourceUnits:14,candidates:new Uint32Array([0,14,3,12,3,12,0xffffffff,0xffffffff,0xffffffff,1,0,0]),definitions:new Uint32Array(),issues:new Uint32Array()};
 worker.onmessage!({data:{kind:"parsed",...b.session,request:1,payload}} as MessageEvent);
 await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="parsed")).toBe(true));
 const result=owned.messages.find(value=>value.kind==="parsed")!;expect(result.request).toBe(1);expect((result.payload as typeof payload).candidates).toHaveLength(12);expect(payload.candidates.buffer.byteLength).toBe(0);expect(worker.terminate).toHaveBeenCalledTimes(1);
 owned.send({kind:"close"});await vi.waitFor(()=>expect(owned.messages.some(value=>value.kind==="closed")).toBe(true));owned.channel.port1.close();
});

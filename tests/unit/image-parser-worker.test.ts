import { expect,it,vi } from "vitest";
import { installParserWorker } from "../../src/renderer/image-inspection/parser-worker";
import * as analysis from "../../src/renderer/image-inspection/parse-source";
import { BUILD } from "../../src/renderer/image-inspection/parser-protocol";
function worker(){const scope={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage:vi.fn()};installParserWorker(scope);return scope;}
const request={kind:"parse",version:1,build:BUILD,epoch:9,nonce:"a".repeat(64),request:4,source:"![[Photo.png]]"};
it("parses complete authored source into transferable packed spans with the exact accepted session",()=>{
 const scope=worker();expect(scope.postMessage.mock.calls[0][0]).toEqual({kind:"worker-ready",version:1,build:BUILD});scope.onmessage!({data:request} as MessageEvent);
 const [reply,transfer]=scope.postMessage.mock.calls[2];const {source:_source,...identity}=request;expect(reply).toMatchObject({...identity,kind:"parsed"});expect(reply).not.toHaveProperty("source");
 expect(reply.payload.sourceUnits).toBe(14);expect(Array.from(reply.payload.candidates)).toEqual([0,14,3,12,3,12,0xffffffff,0xffffffff,0xffffffff,1,0,0]);
 expect(transfer).toEqual([reply.payload.candidates.buffer,reply.payload.definitions.buffer,reply.payload.issues.buffer]);
 scope.onmessage!({data:{...request,request:5}} as MessageEvent);expect(scope.postMessage).toHaveBeenCalledTimes(3);
});
it("does not consume its one admitted parse for malformed source or identity",()=>{
 const scope=worker();for(const value of [{...request,nonce:"short"},{...request,source:"x".repeat(300001)},{...request,source:"\r"},{...request,url:"file:///synthetic"}])scope.onmessage!({data:value} as MessageEvent);
 expect(scope.postMessage).toHaveBeenCalledTimes(1);scope.onmessage!({data:request} as MessageEvent);expect(scope.postMessage).toHaveBeenCalledTimes(3);
});

it("announces the actual validated request before entering complete-source extraction",()=>{
 const scope=worker(),extract=analysis.extractPackedImageSource;let announced=false;
 const spy=vi.spyOn(analysis,"extractPackedImageSource").mockImplementation(source=>{announced=scope.postMessage.mock.calls.some(([value])=>value.kind==="worker-ready"&&value.request===request.request&&value.nonce===request.nonce&&value.epoch===request.epoch);return extract(source);});
 try{scope.onmessage!({data:request} as MessageEvent);expect(announced).toBe(true);expect(spy).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}
});

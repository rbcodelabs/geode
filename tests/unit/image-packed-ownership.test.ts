import { expect, it } from "vitest";
import { fixture } from "./helpers/image-source-fixture";
const api = await import("../../src/renderer/image-inspection/async-source").catch(() => ({})) as any;
const NONE=0xffffffff;
const source="![[Portrait]] ![[Portrait]]";
const candidates=new Uint32Array([0,13,3,11,3,11,NONE,NONE,NONE,1,0,0,14,27,17,25,17,25,NONE,NONE,NONE,1,0,0]);
function context() {
  const f=fixture(source); let epoch={};
  const originalEpoch=epoch;
  return {...f, context:{...f.context,resolutionEpoch:originalEpoch,currentResolutionEpoch:()=>epoch}, changeIndex:()=>{epoch={};}};
}
const transport={parse:async()=>({version:1,sourceUnits:source.length,candidates,definitions:new Uint32Array(),issues:new Uint32Array()})};
it("rejects a closer alias introduced during a batch even if the old image stays indexed",async()=>{
  expect(api.projectPackedOwnedImages).toBeTypeOf("function");
  const f=context(); let target=f.image, calls=0;
  f.context.resolve=()=>{calls++;return target;};
  const result=await api.projectPackedOwnedImages(f.context,transport,{batchSize:1,yieldControl:async()=>{target=f.other;f.changeIndex();}});
  expect(f.indexed.get(f.image.path)).toBe(f.image);
  expect(result).toEqual({status:"unsupported",reason:"stale-owner"});
  expect(calls).toBe(1);
});
it("rejects owner, target rename, root and snapshot mutations during a batch",async()=>{
  for(const mutation of ["owner","target","root","snapshot"]){
    const f=context();f.context.resolve=()=>f.image;
    const result=await api.projectPackedOwnedImages(f.context,transport,{batchSize:1,yieldControl:async()=>{
      if(mutation==="owner")f.indexed.delete(f.owner.path);
      if(mutation==="target")f.image.path="Pictures/Renamed.png";
      if(mutation==="root")f.changeRoot();
      if(mutation==="snapshot")f.changeSnapshot();
    }});
    expect(result).toEqual({status:"unsupported",reason:"stale-owner"});
  }
});
it("rejects absent or invalid epoch tokens before invoking the transport",async()=>{
  for(const token of [undefined,null,1,"constant"]){
    const f=context();let parsed=0;
    const result=await api.projectPackedOwnedImages({...f.context,resolutionEpoch:token,currentResolutionEpoch:()=>token},{parse:async()=>{parsed++;return transport.parse();}});
    expect(result).toEqual({status:"unsupported",reason:"stale-owner"});expect(parsed).toBe(0);
  }
});
it("invalidates an already published projection after a resolver-affecting epoch change",async()=>{
  const f=context();f.context.resolve=()=>f.image;
  const result=await api.projectPackedOwnedImages(f.context,transport);
  expect(result.status).toBe("ready");
  expect(api.isImageProjectionCurrent(result,source)).toBe(true);
  f.changeIndex();
  expect(api.isImageProjectionCurrent(result,source)).toBe(false);
});
it("rejects stale owner/vault/epoch and invalid epoch getters before transport",async()=>{
  for(const mutation of ["owner","vault","epoch","missing-getter","invalid-getter"]){
    const f=context();let parsed=0;
    if(mutation==="owner")f.indexed.delete(f.owner.path);
    if(mutation==="vault")f.changeVault();
    if(mutation==="epoch")f.changeIndex();
    if(mutation==="missing-getter")(f.context as any).currentResolutionEpoch=undefined;
    if(mutation==="invalid-getter")(f.context as any).currentResolutionEpoch="not callable";
    const result=await api.projectPackedOwnedImages(f.context,{parse:async()=>{parsed++;return transport.parse();}});
    expect(result).toEqual({status:"unsupported",reason:"stale-owner"});expect(parsed).toBe(0);
  }
});
it("rejects an index or source revision changed while transport is pending before resolution",async()=>{
  for(const mutation of ["epoch","snapshot"]){
    const f=context();let calls=0;f.context.resolve=()=>{calls++;return f.image;};
    let complete!:(value:unknown)=>void;
    const pending=api.projectPackedOwnedImages(f.context,{parse:()=>new Promise(resolve=>{complete=resolve;})});
    if(mutation==="epoch")f.changeIndex();else f.changeSnapshot();
    complete(await transport.parse());
    expect(await pending).toEqual({status:"unsupported",reason:"stale-owner"});expect(calls).toBe(0);
  }
});

import {expect,it} from "vitest";
import {projectPackedOwnedImages} from "../../src/renderer/image-inspection/async-source";
import {extractPackedImageSource} from "../../src/renderer/image-inspection/parse-source";
import {prepareOwnedImageReading} from "../../src/renderer/image-inspection/reading-bindings";
import {projectOwnedImages as baselineProjection} from "./helpers/image-source-sync-baseline";
import {fixture} from "./helpers/image-source-fixture";
class Marker {
 readonly tagName="IMG";readonly attrs=new Map<string,string>();
 constructor(token:string){this.attrs.set("data-geode-image-occurrence",token);}
 getAttribute(name:string){return this.attrs.get(name)??null;}removeAttribute(name:string){this.attrs.delete(name);}
}
async function setup(){
 const f=fixture("![[Photo.png]]");let epoch={},target=f.image;
 const context={...f.context,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch,resolve:()=>target};
 const projection=await projectPackedOwnedImages(context,{parse:async source=>extractPackedImageSource(source)});
 if(projection.status!=="ready")throw Error("Expected a complete async projection.");
 return {...f,context,projection,addCloserAlias(){target={path:"Notes/Photo.png",extension:"png"};f.indexed.set(target.path,target);epoch={};}};
}
it("authorizes actual asynchronous projections for exact Reading materialization, binding and lookup",async()=>{
 const f=await setup(),prepared=prepareOwnedImageReading(f.projection,f.context.source);
 const token=prepared.source.match(/data-geode-image-occurrence="([a-f0-9]+)"/)![1],node=new Marker(token);
 expect(prepared.materialize(prepared.source,f.context.source)).toContain("<img ");expect(prepared.bind([node],f.context.source)).toBe(true);expect(prepared.lookup(node,f.context.source)).toBe(f.projection.occurrences[0]);expect(node.attrs.size).toBe(0);
});
it("rejects forged and frozen synchronous-baseline projections instead of trying a second authority map",async()=>{
 const f=await setup();expect(()=>prepareOwnedImageReading({...f.projection},f.context.source)).toThrow(/stale/i);
 const old=baselineProjection(f.context);if(old.status!=="ready")throw Error("Expected complete baseline.");expect(()=>prepareOwnedImageReading(old,f.context.source)).toThrow(/stale/i);
});
it("invalidates Reading authority when a closer alias appears even though the old target remains indexed",async()=>{
 const f=await setup(),prepared=prepareOwnedImageReading(f.projection,f.context.source);prepared.materialize(prepared.source,f.context.source);
 const token=prepared.source.match(/data-geode-image-occurrence="([a-f0-9]+)"/)![1],node=new Marker(token);expect(prepared.bind([node],f.context.source)).toBe(true);
 f.addCloserAlias();expect(f.indexed.get(f.image.path)).toBe(f.image);expect(prepared.lookup(node,f.context.source)).toBeNull();expect(()=>prepareOwnedImageReading(f.projection,f.context.source)).toThrow(/stale/i);
});

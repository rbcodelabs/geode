import { expect,it } from "vitest";
import { projectOwnedImages } from "../../src/renderer/image-inspection/source";
import { fixture } from "./helpers/image-source-fixture";
const api=await import("../../src/renderer/image-inspection/parse-source").catch(()=>({})) as any;
const NONE=0xffffffff;
it("preserves linked/reference spans and shares the selected definition and title",()=>{
  expect(api.extractPackedImageSource).toBeTypeOf("function");
  const source='[![cap][ID]](Next.md) ![cap][id]\n\n[id]: Photo.png "Title"';
  const baseline=projectOwnedImages(fixture(source).context);
  expect(baseline.status).toBe("ready");
  if(baseline.status === "ready")expect(baseline.occurrences).toHaveLength(2);
  const packed=api.extractPackedImageSource(source);
  expect(packed.candidates.length).toBe(24);expect(packed.definitions.length).toBe(6);
  const a=packed.candidates,d=packed.definitions;
  expect(source.slice(a[0],a[1])).toBe("![cap][ID]");expect(source.slice(a[12],a[13])).toBe("![cap][id]");
  expect([a[8],a[20]]).toEqual([0,0]);expect([a[9],a[21]]).toEqual([12,4]);
  expect([a[4],a[5],a[16],a[17]]).toEqual([NONE,NONE,NONE,NONE]);
  expect(source.slice(d[2],d[3])).toBe("Photo.png");expect(source.slice(d[4],d[5])).toBe("Title");
});
it("matches original supported grammar and host resolution across authored image forms",async()=>{
  const {projectPackedOwnedImages}=await import("../../src/renderer/image-inspection/async-source");
  const cases=[
    '🗺 ![[Photo.png| caption ]] ![one](Photo.png "title") [![two][ID]](Next.md) ![two][ID]\n\n[id]: Other.jpg "definition title"',
    '![  A   B ] ![A B][] ![alt][ a\n b ]\n\n[a b]: Photo.png\n[A B]: Other.jpg',
    '---\nimage: ![[Photo.png]]\n---\n`![[Photo.png]]`\n\n~~~\n![x](Photo.png)\n~~~\n\n    ![[Photo.png]]\n\n%% ![[Photo.png]] %%\n\n<div>\n![x](Photo.png)\n</div>\n\n<span>![x](Photo.png)</span>\n\n![[OtherNote.md]]\n\n![[Photo.png]]',
    '![[Missing.png]] ![x](https://example.invalid/a.png) ![x](data:image/png,x) ![[/Photo.png]] ![[../Photo.png]] ![[@ext/root/Photo.png]] ![[Art.svg]]',
    '\\![[Photo.png]] ![escaped\\]caption](Photo.png) ![angle](<Photo.png>) ![[Photo.png#section]]',
  ];
  for(const source of cases){
    const f=fixture(source),epoch={};
    const original=projectOwnedImages(f.context);
    const packed=await projectPackedOwnedImages({...f.context,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch},{parse:async source=>api.extractPackedImageSource(source)});
    expect(packed.status).toBe(original.status);
    if(original.status!=="ready"||packed.status!=="ready")throw Error("expected complete projection");
    const values=(items:typeof original.occurrences)=>items.map(({key,...value})=>value);
    expect(values(packed.occurrences)).toEqual(values(original.occurrences));
    expect(packed.issues.map(({from,to,reason})=>[from,to,reason])).toEqual(original.issues.map(({from,to,reason})=>[from,to,reason]));
  }
});
it("shares a long selected destination without multiplying packed payload or host decoding work",async()=>{
  const {projectPackedOwnedImages}=await import("../../src/renderer/image-inspection/async-source");
  const source='![x][id] '.repeat(1000)+'\n\n[id]: '+ 'a'.repeat(10000)+'.png "shared title"';
  const packed=api.extractPackedImageSource(source);
  expect(packed.candidates.length).toBe(12000);expect(packed.definitions.length).toBe(6);
  expect(packed.candidates.byteLength+packed.definitions.byteLength+packed.issues.byteLength).toBe(48024);
  const f=fixture(source),epoch={};let calls=0;f.context.resolve=()=>{calls++;return f.image;};
  const result=await projectPackedOwnedImages({...f.context,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch},{parse:async()=>packed});
  expect(result.status).toBe("ready");if(result.status==="ready"){expect(result.occurrences).toHaveLength(1000);expect(result.occurrences[999].title).toBe("shared title");}
  expect(calls).toBe(1);
});
it("preserves per-occurrence resolver errors without caching a transient error as authority",async()=>{
  const {projectPackedOwnedImages}=await import("../../src/renderer/image-inspection/async-source");
  const source='![[Portrait]] ![[Portrait]]',f=fixture(source),epoch={};let calls=0;
  f.context.resolve=()=>{if(++calls===1)throw Error("synthetic resolver failure");return f.image;};
  const result=await projectPackedOwnedImages({...f.context,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch},{parse:async()=>api.extractPackedImageSource(source)});
  expect(result.status).toBe("ready");if(result.status==="ready")expect(result.occurrences.map(item=>item.status)).toEqual(["error","ready"]);
});

import { describe, expect, it } from "vitest";
const api = await import("../../src/renderer/image-inspection/packed").catch(() => ({})) as any;
const NONE = 0xffffffff;
const source = "![x](A.png)";
const row = [0, source.length, 2, 3, 5, 10, NONE, NONE, NONE, 2, 0, 0];
function payload(values = row) { return { version: 1, sourceUnits: source.length, candidates: new Uint32Array(values), definitions: new Uint32Array(), issues: new Uint32Array() }; }
describe("packed image descriptor contract", () => {
  it("validates whole original UTF16 spans and empty input", () => {
    expect(api.validatePackedImages).toBeTypeOf("function");
    expect(api.validatePackedImages(source, payload()).candidates).toEqual(new Uint32Array(row));
    expect(api.validatePackedImages("", { ...payload([]), sourceUnits: 0 }).candidates.length).toBe(0);
  });
  it("rejects malformed shape, row widths, actual buffer views and excessive tables", () => {
    const offset = new Uint32Array(new ArrayBuffer(52), 4);
    for (const value of [null, { ...payload(), extra: true }, { ...payload(), version: 2 }, { ...payload(), sourceUnits: 0 }, { ...payload(), candidates: new Uint32Array(13) }, { ...payload(), candidates: offset }, { ...payload(), candidates: new Uint32Array((source.length + 1) * 12) }]) expect(() => api.validatePackedImages(source, value)).toThrow();
  });
  it("rejects mixed sentinels, ranges, flags, reserved words, overlaps and missing definitions", () => {
    const mutate = (index: number, value: number) => { const copy = [...row]; copy[index] = value; return payload(copy); };
    for (const value of [mutate(1, source.length+1), mutate(2, 20), mutate(6, 0), mutate(8, 0), mutate(9, 0), mutate(9, 3), mutate(9, 32), mutate(10, 1), payload([...row, ...row])]) expect(() => api.validatePackedImages(source, value)).toThrow();
  });
  it("accepts one selected definition shared by repeated reference candidates", () => {
    const text = "![x][r] ![y][r]\n[r]: A.png";
    const definition = text.indexOf("[r]:"), target = text.indexOf("A.png");
    const candidate = (from: number) => [from, from+7, from+2, from+3, NONE, NONE, NONE, NONE, 0, 4, 0, 0];
    const packed = { version:1, sourceUnits:text.length, candidates:new Uint32Array([...candidate(0),...candidate(8)]), definitions:new Uint32Array([definition+1,definition+2,target,target+5,NONE,NONE]), issues:new Uint32Array() };
    expect(api.validatePackedImages(text,packed).definitions.length).toBe(6);
    expect(() => api.validatePackedImages(text,{...packed, definitions:new Uint32Array([...packed.definitions,...packed.definitions])})).toThrow();
  });
  it("rejects over-ceiling and CRLF sources before accepting any descriptor", () => {
    expect(() => api.validatePackedImages("x".repeat(300001),payload())).toThrow();
    expect(() => api.validatePackedImages("\r\n",payload())).toThrow();
  });
});
it("accepts linked syntax flags but rejects nontransferable or detached buffers",()=>{
  const linked=payload([...row.slice(0,9),10,0,0]);
  expect(api.validatePackedImages(source,linked).candidates[9]).toBe(10);
  const shared=new Uint32Array(new SharedArrayBuffer(48));
  expect(()=>api.validatePackedImages(source,{...payload(),candidates:shared})).toThrow();
  const detached=new Uint32Array(row);structuredClone(detached.buffer,{transfer:[detached.buffer]});
  expect(()=>api.validatePackedImages(source,{...payload(),candidates:detached})).toThrow();
});
it("rejects malformed issue widths, unknown reasons and out-of-source ranges",()=>{
  for(const issues of [new Uint32Array([0,1]),new Uint32Array([0,1,99]),new Uint32Array([0,source.length+1,1])])expect(()=>api.validatePackedImages(source,{...payload(),issues})).toThrow();
});
it("rejects invalid definition spans and duplicate selected definitions",()=>{
  const text="![x][r] ![y][r]\n[r]: A.png";const d=text.indexOf("[r]:"),t=text.indexOf("A.png");
  const candidate=(from:number,index:number)=>[from,from+7,from+2,from+3,NONE,NONE,NONE,NONE,index,4,0,0];
  const definition=[d+1,d+2,t,t+5,NONE,NONE];
  const packed={version:1,sourceUnits:text.length,candidates:new Uint32Array([...candidate(0,0),...candidate(8,0)]),definitions:new Uint32Array(definition),issues:new Uint32Array()};
  for(const values of [[d+1,d+2,t,text.length+1,NONE,NONE],[d+1,d+2,t,t+5,0,NONE]])expect(()=>api.validatePackedImages(text,{...packed,definitions:new Uint32Array(values)})).toThrow();
  expect(()=>api.validatePackedImages(text,{...packed,candidates:new Uint32Array([...candidate(0,0),...candidate(8,1)]),definitions:new Uint32Array([...definition,...definition])})).toThrow();
});

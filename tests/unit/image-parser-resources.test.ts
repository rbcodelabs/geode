import { expect,it } from "vitest";
import { createParserResourceHandler,BROKER_CSP,WORKER_CSP } from "../../src/renderer/image-inspection/parser-resources";
const resources={"index.html":"<!doctype html><script type=module src=./broker.mjs></script>","broker.mjs":"export {};","worker.mjs":"export {};"};
it("serves only three exact fixed GET resources with restrictive response policies",async()=>{
 for(const policy of [BROKER_CSP,WORKER_CSP]){expect(policy).toContain("connect-src 'none'");expect(policy).toContain("script-src 'self'");expect(policy).not.toMatch(/unsafe-eval|unsafe-inline|blob:|https:/);}
 expect(WORKER_CSP).toContain("worker-src 'none'");
 const handle=createParserResourceHandler(resources);
 for(const [name,body] of Object.entries(resources)){
  const response=handle({method:"GET",url:`geode-image-parser://broker/${name}`});expect(response.status).toBe(200);expect(await response.text()).toBe(body);
  expect(response.headers.get("Content-Security-Policy")).toBe(name==="worker.mjs"?WORKER_CSP:BROKER_CSP);expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Type")).toBe(name.endsWith(".mjs")?"application/javascript; charset=utf-8":"text/html; charset=utf-8");
 }
 for(const [method,url] of [["POST","geode-image-parser://broker/worker.mjs"],["GET","geode-image-parser://broker/worker.mjs?source=synthetic"],["GET","geode-image-parser://other/worker.mjs"],["GET","file:///synthetic"],["GET","geode-image-parser://broker/../worker.mjs"],["GET","geode-image-parser://broker/vault.md"]])expect(handle({method,url}).status).toBe(404);
});
it("rejects extra or missing resource inventory rather than exposing a dynamic file handler",()=>{
 expect(()=>createParserResourceHandler({...resources,"extra.mjs":""})).toThrow(/inventory/i);
 expect(()=>createParserResourceHandler({"index.html":""} as typeof resources)).toThrow(/inventory/i);
});

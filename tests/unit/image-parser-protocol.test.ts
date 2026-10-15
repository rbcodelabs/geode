import { expect,it } from "vitest";
import { BUILD,isParserInit,isParserRequest,isParserReply } from "../../src/renderer/image-inspection/parser-protocol";
const session={version:1 as const,build:BUILD,epoch:7,nonce:"a".repeat(64)};
it("admits only exact session initialization without host capabilities",()=>{
 const init={kind:"initialize",...session};expect(isParserInit(init)).toBe(true);
 for(const value of [{...init,epoch:0},{...init,nonce:"x"},{...init,build:"old"},{...init,owner:{}},{...init,url:"file:///synthetic"}])expect(isParserInit(value)).toBe(false);
});
it("validates complete LF source and exact session identity before admitting requests",()=>{
 const parse={kind:"parse",...session,request:1,source:"[".repeat(150000)+"]".repeat(150000)};
 expect(isParserRequest(parse,session)).toBe(true);expect(isParserRequest({kind:"cancel",...session,request:1},session)).toBe(true);expect(isParserRequest({kind:"close",...session},session)).toBe(true);
 for(const value of [{...parse,source:"x".repeat(300001)},{...parse,source:"\r\n"},{...parse,epoch:8},{...parse,nonce:"b".repeat(64)},{...parse,build:"old"},{...parse,request:0},{...parse,callback:"synthetic"},{kind:"cancel",...session,request:1,source:""}])expect(isParserRequest(value,session)).toBe(false);
});
it("rejects unowned or malformed replies and requires a truthful local-release acknowledgement",()=>{
 const ready={kind:"ready",...session};expect(isParserReply(ready,session)).toBe(true);
 const cancelled={kind:"cancelled",...session,request:1,released:true};expect(isParserReply(cancelled,session)).toBe(true);
 expect(isParserReply({kind:"parsed",...session,request:1,payload:{}},session)).toBe(true);
 expect(isParserReply({kind:"failed",...session,request:1,code:"worker-error"},session)).toBe(true);
 for(const value of [{...ready,epoch:8},{...ready,nonce:"b".repeat(64)},{...ready,unexpected:true},{...cancelled,released:false},{...cancelled,request:NaN},{kind:"failed",...session,request:1,code:"private-source-details"}])expect(isParserReply(value,session)).toBe(false);
});

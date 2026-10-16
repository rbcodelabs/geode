/** Historical stock comparison executes in the owned native-proof aggregate, not a 5s unit. */
import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
it("pins the exact four historical complete stock comparison fixtures",()=>{
 const sizes=[10000,20000,40000,80000];
 const expected=["bb0fe1604ba08f14daa9daf72e5db17b282e6e357c43d7b85b56f2d68334fedb", "88b516df742a232dad9132d8e5173704287f890c30624fd29fb22abfe7b58e37", "31851d9adc33c98514a91d64e61ee176ed51d1663ba05f5c31b1043c6f2e2cd4", "aa911e8c389fd9c733a49d0cd30938ff9bd3ab68e7cf17fa635cc45973dca7a8"];
 sizes.forEach((size,index)=>{const source="[".repeat(size/2)+"]".repeat(size/2);expect(source.length).toBe(size);expect(hash(source)).toBe(expected[index]);});
});
it("preserves the complete historical comparison loop after explicit report-only normalization",()=>{
 const original=readFileSync("docs/design/image-parser-authority-migration.md","utf8").split("## Original characterization source")[1].match(/```typescript\n([\s\S]*?)```/)![1];
 expect(hash(original)).toBe("3a8adaecb06c7533b9fb83e3f722804a9e51f3b65a1864d6441547df4f50898d");
 const oldLoop=original.slice(original.indexOf('  const { parser }'),original.lastIndexOf('\n});'));
 const entry=readFileSync("scripts/image-parser-stock-characterization.ts","utf8");
 const normalized=entry.slice(entry.indexOf('  const { parser }'),entry.indexOf('\n  return rows;'))
  .replace(/    const observation = (.*);\n    console.log\(JSON.stringify\(observation\)\);/,'    console.log(JSON.stringify($1));')
  .replace('    assert.equal(projection.status,"ready");','    expect(projection.status).toBe("ready");')
  .replace(/\n    assert.equal\(projection.source,source\);\n    rows.push\([^\n]*\);/,'');
 expect(normalized).toBe(oldLoop);expect(hash(normalized)).toBe("e11fc4debe357a1e3fc3a2bf082df76a347ab973bef5bb1d2acd6b66db96ad40");
});

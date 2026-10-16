import {expect,it} from "vitest";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {completeImageSourceCases} from "./helpers/image-source-ceiling-fixtures";
import fingerprints from "./helpers/image-source-ceiling-fingerprints.json";
it("retains the exact six original full-source fixtures and occurrence oracles",()=>{
 const cases=completeImageSourceCases();expect(Object.keys(cases)).toEqual(Object.keys(fingerprints));
 for(const [name,source] of Object.entries(cases)){const expected=fingerprints[name as keyof typeof fingerprints];expect(source.length).toBe(expected.units);expect(createHash("sha256").update(source).digest("hex")).toBe(expected.sha256);expect(expected.occurrences).toBe(name==="denseImages"?20000:["ordinaryWhitespace","prose"].includes(name)?1:0);}
});
it("preserves the frozen sync baseline implementation with only module-specifier import adjustments",()=>{
 const baseline=readFileSync(new URL("./helpers/image-source-sync-baseline.ts",import.meta.url),"utf8");
 const normalized=baseline.replaceAll('"../../../src/wiki/','"../../wiki/').replaceAll('"../../../src/renderer/comments/model"','"../comments/model"');
 expect(createHash("sha256").update(normalized).digest("hex")).toBe("cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335");
});

import { expect,it } from "vitest";
import { decodeMarkdownDestination } from "../../src/wiki/markdown-destination";
import { decodeMarkdownDestination as originalExport } from "../../src/wiki/markdown-references";
it("retains the existing decoding export identity and semantics",()=>{
  expect(originalExport).toBe(decodeMarkdownDestination);
  for(const [source,expected] of [['<Photo.png>','Photo.png'],['Photo%20One.png','Photo One.png'],['Photo\\(One\\).png','Photo(One).png'],['a%2Fb.png','a%2Fb.png'],['bad%XX.png','bad%XX.png']])expect(decodeMarkdownDestination(source)).toBe(expected);
});
it("preserves authored label punctuation and literal percent sequences in existing metadata",async()=>{
  const {parseMetadata}=await import("../../src/wiki/metadata");
  const metadata=parseMetadata('[a\\*b](Note.md) [100%20pure](Other.md)');
  expect(metadata.links.map(link=>link.displayText)).toEqual(['a*b','100%20pure']);
});

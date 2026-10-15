/** Worker-only complete-source analysis. This module grants no file authority. */
import type { SyntaxNode } from "@lezer/common";
import { maskMarkdownCode } from "../../wiki/code-mask";
import { FRONTMATTER_BLOCK_RE } from "../../wiki/constants";
import { metadataMarkdownParser, normalizeMarkdownReferenceLabel } from "../../wiki/markdown-references";
import { maskCommentMetadata } from "../comments/model";
import { ABSENT_SPAN as NONE, IMAGE_FLAGS, validatePackedImages, type PackedImageSource } from "./packed";
type Span = { from: number; to: number };
type Definition = readonly [number, number, number, number, number, number];
const blank = (value: string) => value.replace(/[^\n]/g, " ");
function ancestor(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return parent;
  return null;
}
function escaped(source: string, from: number): boolean {
  let start = from; while (start && source[start-1] === "\\") start--;
  return (from-start) % 2 === 1;
}
export function extractPackedImageSource(source: string): PackedImageSource {
  if (source.length > 300_000 || source.includes("\r")) throw new Error("Unsupported complete image source.");
  let masked = maskMarkdownCode(maskCommentMetadata(source));
  if (masked.startsWith("---\n")) {
    const frontmatter = FRONTMATTER_BLOCK_RE.exec(masked), end = frontmatter?.[0].length ?? masked.length;
    masked = blank(masked.slice(0,end)) + masked.slice(end);
  }
  const comments: string[] = []; let offset = 0;
  while (offset < masked.length) {
    const open = masked.indexOf("%%",offset); if (open < 0) break;
    if (escaped(masked,open)) { comments.push(masked.slice(offset,open+2));offset=open+2;continue; }
    let end = masked.indexOf("%%",open+2);
    while (end >= 0 && escaped(masked,end)) end = masked.indexOf("%%",end+2);
    end = end < 0 ? masked.length : end+2;
    comments.push(masked.slice(offset,open),blank(masked.slice(open,end)));offset=end;
  }
  comments.push(masked.slice(offset));masked=comments.join("");
  const tree = metadataMarkdownParser.parse(masked);
  const excluded: Span[] = [], definitions = new Map<string, Definition>();
  tree.iterate({ enter(ref) {
    const node=ref.node;
    if (["HTMLBlock","CommentBlock","ProcessingInstructionBlock","CodeBlock","FencedCode","InlineCode"].includes(node.name)) { excluded.push(node);return false; }
    if (node.name === "HTMLTag" && !ancestor(node,"Image")) excluded.push(ancestor(node,"Paragraph") ?? node);
    if (node.name === "LinkReference") {
      const label=node.getChild("LinkLabel"),url=node.getChild("URL"),title=node.getChild("LinkTitle");
      if (label && url) {
        const id=normalizeMarkdownReferenceLabel(masked.slice(label.from+1,label.to-1));
        if (!definitions.has(id)) definitions.set(id,[label.from+1,label.to-1,url.from,url.to,title?title.from+1:NONE,title?title.to-1:NONE]);
      }
    }
  }});
  excluded.sort((a,b)=>a.from-b.from || b.to-a.to);
  const intervals: Span[]=[];
  for (const span of excluded) {
    const last=intervals.at(-1);if(last && span.from<=last.to)last.to=Math.max(last.to,span.to);else intervals.push({from:span.from,to:span.to});
  }
  const omitted=(from:number,to:number)=>{
    let low=0,high=intervals.length;
    while(low<high){const middle=(low+high)>>>1;if(intervals[middle].to<=from)low=middle+1;else high=middle;}
    return low<intervals.length && intervals[low].from<to;
  };
  const rows: number[][]=[], selected: Definition[]=[];
  const selectedIndexes = new Map<Definition,number>();
  for(const match of masked.matchAll(/!\[\[([^\[\]\n]+)\]\]/g)) {
    const from=match.index,to=from+match[0].length;
    if(escaped(masked,from)||omitted(from,to))continue;
    const node=tree.resolveInner(from+2,1);let forbidden=false,linked=false;
    for(let parent:SyntaxNode|null=node;parent;parent=parent.parent){
      if(["URL","LinkTitle","LinkReference"].includes(parent.name)||(parent.name==="Image"&&(parent.from!==from||parent.to!==to)))forbidden=true;
      if(parent.name==="Link"&&parent.from<from&&parent.to>=to)linked=true;
    }
    if(forbidden)continue;
    const pipe=match[1].indexOf("|"),targetFrom=from+3,targetTo=pipe<0?to-2:targetFrom+pipe;
    rows.push([from,to,pipe<0?targetFrom:targetTo+1,to-2,targetFrom,targetTo,NONE,NONE,NONE,IMAGE_FLAGS.wiki|(linked?IMAGE_FLAGS.linked:0),0,0]);
  }
  tree.iterate({enter(ref){
    const node=ref.node;if(node.name!=="Image")return;
    if(omitted(node.from,node.to)||ancestor(node,"Image")||source.startsWith("![[",node.from))return false;
    const close=node.getChildren("LinkMark").find(mark=>masked.slice(mark.from,mark.to)==="]");if(!close)return false;
    const label=source.slice(node.from+2,close.from),url=node.getChild("URL"),reference=node.getChild("LinkLabel"),title=node.getChild("LinkTitle");
    const definition=reference?definitions.get(normalizeMarkdownReferenceLabel(masked.slice(reference.from+1,reference.to-1)||label)):definitions.get(normalizeMarkdownReferenceLabel(label));
    if(!url&&!definition)return false;
    let index=NONE;
    if(!url&&definition){const existing=selectedIndexes.get(definition);if(existing===undefined){index=selected.length;selected.push(definition);selectedIndexes.set(definition,index);}else index=existing;}
    rows.push([node.from,node.to,node.from+2,close.from,url?url.from:NONE,url?url.to:NONE,title?title.from+1:NONE,title?title.to-1:NONE,index,
      (url?IMAGE_FLAGS.direct:IMAGE_FLAGS.reference)|(ancestor(node,"Link")?IMAGE_FLAGS.linked:0),0,0]);
    return false;
  }});
  rows.sort((a,b)=>a[0]-b[0]);
  return validatePackedImages(source,{version:1,sourceUnits:source.length,candidates:new Uint32Array(rows.flat()),definitions:new Uint32Array(selected.flat()),issues:new Uint32Array()});
}

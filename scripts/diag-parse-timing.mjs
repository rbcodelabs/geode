// THROWAWAY diagnostic (not for merge): where does nestedDelimiters spend its time?
import {buildSync} from "esbuild";
import {createRequire} from "node:module";
const out="/tmp/diag-parse.cjs";
buildSync({entryPoints:["src/renderer/image-inspection/parse-source.ts"],bundle:true,platform:"node",format:"cjs",outfile:out,logLevel:"silent",packages:"external"});
buildSync({stdin:{contents:`export {maskMarkdownCode} from "./src/wiki/code-mask";export {maskCommentMetadata} from "./src/renderer/comments/model";export {metadataMarkdownParser} from "./src/wiki/markdown-references";export {extractPackedImageSource} from "./src/renderer/image-inspection/parse-source";`,resolveDir:process.cwd()},bundle:true,platform:"node",format:"cjs",outfile:"/tmp/diag-stages.cjs",logLevel:"silent",packages:"external"});
const api=createRequire(import.meta.url)("/tmp/diag-stages.cjs");
const t=(label,fn)=>{const s=performance.now();const v=fn();console.log(label.padEnd(44),(performance.now()-s).toFixed(0)+"ms");return v;};
for(const n of [20000,40000,80000,160000,300000]){
  const src="[".repeat(n/2)+"]".repeat(n/2);
  console.log("== nestedDelimiters size",n);
  const a=t("maskCommentMetadata",()=>api.maskCommentMetadata(src));
  const b=t("maskMarkdownCode",()=>api.maskMarkdownCode(a));
  t("metadataMarkdownParser.parse",()=>api.metadataMarkdownParser.parse(b));
  t("extractPackedImageSource (whole)",()=>api.extractPackedImageSource(src));
}

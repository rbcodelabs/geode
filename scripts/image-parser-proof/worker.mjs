/** Test-only stock configured-grammar execution. No extraction migration. */
import { metadataMarkdownParser } from '../../src/wiki/markdown-references';
import { isProofRequest, BUILD } from './protocol';
import { probeRealm } from './native-probe.mjs';
const proof = await probeRealm(true);
postMessage({kind:'worker-ready',build:BUILD,proof});
let epoch;
onmessage = event => {
  const value = event.data;
  if (!Number.isSafeInteger(value?.epoch) || value.epoch < 1) return;
  if (epoch === undefined) epoch = value.epoch;
  if (!isProofRequest(value,epoch) || value.kind !== 'parse') return;
  postMessage({kind:'parsing',epoch,request:value.request,units:value.source.length});
  const started = performance.now();
  const tree = metadataMarkdownParser.parse(value.source);
  let images = 0;
  tree.iterate({enter(node){if(node.name === 'Image')images++;}});
  postMessage({kind:'parsed',epoch,request:value.request,units:value.source.length,treeUnits:tree.length,images,milliseconds:performance.now()-started});
};

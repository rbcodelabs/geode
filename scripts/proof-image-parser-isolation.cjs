/** ADR0043 test-only runtime proof. No production scheme registration or UI hooks. */
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'test-results','image-parser-isolation-proof');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'geode-image-parser-proof-')));
protocol.registerSchemesAsPrivileged([{scheme:'geode-image-parser',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:false}}]);
function bundle(options) {return esbuild.buildSync({absWorkingDir:root,bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent',...options}).outputFiles[0].text;}
async function hostProof(helperURL,sentinelURL) {
  const helper=await import(helperURL);
  const ORIGIN = 'geode-image-parser://broker';
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
  const init = {kind:'initialize',version:1,build:'image-parser-proof-v1',epoch:1,nonce};
  const parentRealm = {require:typeof require,geode:typeof geode};
  const parentFileRead=await (await fetch(sentinelURL)).text();
  let ticks=0,clicks=0;
  const button=document.createElement('button');button.textContent='Responsive host control';button.style='position:fixed;left:0;top:0;width:200px;height:80px';button.onclick=()=>clicks++;document.body.append(button);
  const heartbeat=setInterval(()=>ticks++,20);
  const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin';frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');frame.style='position:absolute;width:1px;height:1px;pointer-events:none';frame.src=ORIGIN+'/index.html';
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('broker load timeout')),8000);frame.onload=()=>{clearTimeout(timer);resolve();};document.body.append(frame);});
  const ignored=async (packet,requests=[])=>{
    const channel=new MessageChannel();let replied=false;channel.port1.onmessage=()=>replied=true;
    frame.contentWindow.postMessage(packet,ORIGIN,[channel.port2]);
    for(const request of requests)channel.port1.postMessage(request);
    await new Promise(resolve=>setTimeout(resolve,60));channel.port1.close();return !replied;
  };
  const rejected=[];
  for(const packet of [{...init,build:'old'},{...init,epoch:0},{...init,nonce:'short'},{...init,url:'file:///not-allowed'},{...init,version:2}])rejected.push(await ignored(packet));
  const channel=new MessageChannel(),pending=new Map(),messages=[];
  const wait=(kind,request)=>new Promise((resolve,reject)=>{
    const key=kind+':'+(request??'');const timer=setTimeout(()=>{pending.delete(key);reject(Error('proof response timeout '+key));},35000);
    pending.set(key,value=>{clearTimeout(timer);pending.delete(key);resolve(value);});
  });
  channel.port1.onmessage=event=>{
    const value=event.data;
    if(value.version!==1||value.build!==init.build||value.nonce!==nonce||value.epoch!==1)throw Error('invalid broker identity');
    messages.push(value);pending.get(value.kind+':'+(value.request??''))?.(value);
  };
  const readyWait=wait('ready');frame.contentWindow.postMessage(init,ORIGIN,[channel.port2]);const ready=await readyWait;if(!helper.isProofReady(ready,init))throw Error("readiness identity failed");
  rejected.push(await ignored(init,[{kind:'parse',version:1,epoch:1,request:99,source:'![forged](Photo.png)'},{kind:'cancel',version:1,epoch:1,request:1}]));
  for(const forged of [{...ready,nonce:'b'.repeat(64)},{...ready,build:'old'},{...ready,epoch:2}])rejected.push(!helper.isProofReady(forged,init));
  const packet=(kind,request,source)=>({kind,version:1,epoch:1,request,...(source===undefined?{}:{source})});
  // Invalid packets cannot create a worker; readiness on a subsequent valid job
  // is the positive control. Native policy errors are tested separately.
  const beforeInvalid=messages.length;
  for(const invalid of [{...packet('parse',1,'x'),url:'file:///x'},packet('parse',1,'x'.repeat(300001)),packet('parse',1,'\r\n'),{...packet('parse',1,'x'),epoch:2}])channel.port1.postMessage(invalid);
  await new Promise(resolve=>setTimeout(resolve,80));rejected.push(messages.length===beforeInvalid);
  const source='['.repeat(150000)+']'.repeat(150000);
  const workerReady=wait('worker-ready',1),parsing=wait('parsing',1);channel.port1.postMessage(packet('parse',1,source));
  const worker=await workerReady;await parsing;
  const busyWait=wait('busy',3);channel.port1.postMessage(packet('parse',3,'ordinary'));const busy=await busyWait;
  const cancelStart=performance.now(),cancelWait=wait('cancelled',1);
  channel.port1.postMessage(packet('cancel',1));const cancelled=await cancelWait;
  const cancellationMs=performance.now()-cancelStart;

  const parsedWait=wait('parsed',2),worker2=wait('worker-ready',2),parsing2=wait('parsing',2);
  channel.port1.postMessage(packet('parse',2,source));await worker2;await parsing2;const completeStart={ticks,clicks};
  const complete=await parsedWait;
  // A terminated first worker cannot publish through the broker's detached
  // listeners/handle, even while a later complete parse is running.
  const obsolete=messages.filter(value=>value.kind==='parsed'&&value.request===1).length;
  clearInterval(heartbeat);channel.port1.close();frame.remove();button.remove();
  return {parentRealm,parentFileRead,rejected,broker:ready.proof,worker:worker.proof,busy,cancelled,cancellationMs,complete,hostTicks:ticks-completeStart.ticks,hostInputClicks:clicks-completeStart.clicks,obsolete,sourceUnits:source.length,frameTabIndex:frame.tabIndex};
}
app.whenReady().then(async()=>{
  let hits=0,connections=0;
  const served=[],consoleMessages=[];
  const server=http.createServer((_request,response)=>{hits++;response.end('UNEXPECTED');});server.on('connection',()=>connections++);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const sentinelFile=path.join(output,'synthetic-readable-sentinel.txt');fs.writeFileSync(sentinelFile,'synthetic-image-parser-sentinel');
  const sentinelURL=require('node:url').pathToFileURL(sentinelFile).href;
  const defs={__IMAGE_PROOF_PORT__:String(port),__IMAGE_PROOF_FILE__:JSON.stringify(sentinelURL)};
  const resources={
    'index.html':'<!doctype html><html><head><script type="module" src="./broker.mjs"></script></head><body></body></html>',
    'broker.mjs':bundle({entryPoints:['scripts/image-parser-proof/broker.mjs'],define:defs}),
    'worker.mjs':bundle({entryPoints:['scripts/image-parser-proof/worker.mjs'],define:defs}),
  };
  for(const [name,body] of Object.entries(resources))fs.writeFileSync(path.join(output,name),body);
  const protocolFile=path.join(output,'protocol.cjs');fs.writeFileSync(protocolFile,bundle({entryPoints:['scripts/image-parser-proof/protocol.ts'],platform:'node',format:'cjs'}));
  const {createProofProtocol,BROKER_CSP,WORKER_CSP}=require(protocolFile);const handle=createProofProtocol(resources);
  protocol.handle('geode-image-parser',request=>{const response=handle(request);served.push({url:request.url,method:request.method,status:response.status,csp:response.headers.get('Content-Security-Policy'),mime:response.headers.get('Content-Type'),nosniff:response.headers.get('X-Content-Type-Options')});return response;});
  const helperFile=path.join(output,'helper.mjs');fs.writeFileSync(helperFile,bundle({entryPoints:['scripts/image-parser-proof/protocol.ts']}));
  const preferences={backgroundThrottling:false,preload:path.join(root,'dist/preload.js'),contextIsolation:false,nodeIntegration:true,sandbox:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,webviewTag:true};
  const win=new BrowserWindow({show:true,width:900,height:600,webPreferences:preferences});
  win.webContents.on('console-message',event=>consoleMessages.push(event.message));
  const parentFile=path.join(output,'parent.html');fs.writeFileSync(parentFile,'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-eval\'; frame-src geode-image-parser://broker/index.html"><body>Trusted proof parent</body>');
  await win.loadFile(parentFile);win.focus();
  const input=setInterval(()=>{if(!win.isDestroyed()){win.webContents.sendInputEvent({type:'mouseDown',x:50,y:30,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:50,y:30,button:'left',clickCount:1});}},100);
  let result,failure;
  try {
    result=await win.webContents.executeJavaScript(`(${hostProof.toString()})(${JSON.stringify(require("node:url").pathToFileURL(helperFile).href)},${JSON.stringify(sentinelURL)})`);
    assert.equal(result.parentFileRead,'synthetic-image-parser-sentinel');assert.equal(result.parentRealm.require,'function');assert.equal(result.parentRealm.geode,'object');assert.ok(result.rejected.every(Boolean));
    for(const realm of [result.broker.realm,result.worker.realm])for(const [key,value] of Object.entries(realm))assert.equal(value,'undefined',key);
    for(const probe of [result.broker,result.worker])for(const key of ['eval','wasm','fetch','localFetch','import','xhr','wss'])assert.equal(probe[key],true,key);
    assert.equal(result.broker.initialization.parentOrigin,'null');assert.equal(result.broker.initialization.actualParent,true);assert.equal(result.broker.parentDOM,true);assert.equal(result.broker.parentNode,true);assert.equal(result.worker.descendant,true);
    assert.equal(hits,0);assert.equal(connections,0);assert.ok(consoleMessages.some(message=>message.includes('synthetic-readable-sentinel.txt')&&/Content Security Policy|connect-src/.test(message)),'actual sentinel-file CSP denial must be observed');assert.equal(result.sourceUnits,300000);assert.equal(result.complete.units,300000);assert.equal(result.complete.treeUnits,300000);assert.equal(result.complete.images,0);
    assert.equal(result.busy.request,3);assert.equal(result.cancelled.workerHandleReleased,true);assert.ok(result.cancellationMs<1000,`broker cancellation ${result.cancellationMs}ms`);assert.equal(result.obsolete,0);assert.ok(result.hostTicks>10);assert.ok(result.hostInputClicks>2);assert.equal(result.frameTabIndex,-1);
    assert.ok(served.length>=3);for(const entry of served){assert.ok(Object.keys(resources).some(name=>entry.url==='geode-image-parser://broker/'+name));assert.equal(entry.status,200);assert.equal(entry.nosniff,'nosniff');assert.equal(entry.mime,entry.url.endsWith('.mjs')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');assert.equal(entry.csp,entry.url.endsWith('worker.mjs')?WORKER_CSP:BROKER_CSP);}
  }catch(error){failure=String(error.stack||error);}
  finally{clearInterval(input);}
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const resourceHashes=Object.fromEntries(Object.entries(resources).map(([name,body])=>[name,crypto.createHash('sha256').update(body).digest('hex')]));
  const report={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),electron:process.versions.electron,preferences,resourceHashes,preloadHash:hash(path.join(root,'dist/preload.js')),result,served,hits,connections,consoleMessages,failure:failure||null,limits:'Test-only boundary. Worker terminate and handle/listener release do not prove OS process exit or memory reclamation. No production integration/extraction equivalence claim.'};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  win.destroy();await new Promise(resolve=>server.close(resolve));app.exit(failure?1:0);
}).catch(error=>{console.error(error);app.exit(1);});

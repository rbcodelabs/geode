/** ADR0043 private packed runtime proof. No production registration or UI hooks. */
const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url'),{execFileSync}=require('node:child_process'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),output=process.env.GEODE_IMAGE_PARSER_PROOF_OUTPUT||path.join(root,'test-results','image-parser-packed-proof');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'geode-image-packed-')));
// The standalone proof owns quitting; a gap between its windows must not autoquit.
app.on('window-all-closed',()=>{});
protocol.registerSchemesAsPrivileged([{scheme:'geode-image-parser',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:false}}]);
const hash=body=>crypto.createHash('sha256').update(body).digest('hex');
function build(options){return esbuild.buildSync({absWorkingDir:root,bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',metafile:true,logLevel:'silent',...options});}
function bundle(options){return build(options).outputFiles[0].text;}
async function prepareNativeRejectionFrames(){
 const frames=[];
 for(let i=0;i<2;i++){const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin';frame.tabIndex=-1;frame.name=i===0?'synthetic-foreign':'synthetic-target';frame.src='geode-image-parser://broker/index.html';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('negative fixture load deadline')),8000);frame.onload=()=>{clearTimeout(timer);resolve();};document.body.append(frame);});frames.push(frame);}
 const session={version:1,build:'image-parser-packed-v1',epoch:7,nonce:Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('')};
 window.__PACKED_NEGATIVE={frames,session,channels:[]};return session;
}
async function completeNativeRejections(){
 const {frames,session,channels}=window.__PACKED_NEGATIVE,target=frames[1].contentWindow,messages=[],pending=new Map();
 const wait=(kind,request)=>new Promise((resolve,reject)=>{const key=kind+':'+(request??''),timer=setTimeout(()=>reject(Error('negative positive-control deadline '+key)),8000);pending.set(key,value=>{clearTimeout(timer);pending.delete(key);resolve(value);});});
 const initialize=value=>{const channel=new MessageChannel();channels.push(channel);channel.port1.start();target.postMessage(value,'geode-image-parser://broker',[channel.port2]);return channel;};
 const foreign=[];
 for(const init of [{kind:'initialize',...session,build:'old'},{kind:'initialize',...session,epoch:0},{kind:'initialize',...session,nonce:'short'},{kind:'initialize',...session,extra:true}]){const channel=initialize(init);channel.port1.onmessage=event=>foreign.push(event.data);}
 const ready=wait('ready'),owned=initialize({kind:'initialize',...session});owned.port1.onmessage=event=>{messages.push(event.data);pending.get(event.data.kind+':'+(event.data.request??''))?.(event.data);};await ready;
 const duplicate=initialize({kind:'initialize',...session});duplicate.port1.onmessage=event=>foreign.push(event.data);duplicate.port1.postMessage({kind:'parse',...session,request:99,source:''});
 for(const bad of [{kind:'parse',...session,request:99,source:'',nonce:'b'.repeat(64)},{kind:'parse',...session,request:99,source:'',epoch:8},{kind:'parse',...session,request:99,source:'',extra:true},{kind:'parse',...session,request:99,source:'x'.repeat(300001)}])owned.port1.postMessage(bad);
 const result=wait('parsed',1);owned.port1.postMessage({kind:'parse',...session,request:1,source:'![[Photo.png]]'});const packed=await result;
 const closed=wait('closed');owned.port1.postMessage({kind:'close',...session});await closed;
 return {foreignResponses:foreign.length,ownedMessages:messages.map(value=>({kind:value.kind,request:value.request})),sourceUnits:packed.payload.sourceUnits,rows:packed.payload.candidates.length/12};
}
async function canonicalHost(helperURL){
 const api=await import(helperURL),NativeChannel=MessageChannel,channels=[],messages=[],waiting=new Map();
 let ticks=0,clicks=0,baseline,withholdReady=false,withheld;
 const button=document.createElement('button');button.textContent='Responsive packed-parser control';button.style='position:fixed;left:0;top:0;width:240px;height:80px';button.onclick=()=>clicks++;document.body.append(button);
 const heartbeat=setInterval(()=>ticks++,20);
 // Synthetic parent-only observation. The actual transport remains unmodified.
 window.MessageChannel=class extends NativeChannel{
  constructor(){super();channels.push(this);const port=this.port1,descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(port),'onmessage');if(!descriptor?.set)throw Error('missing native message handler accessor');
   Object.defineProperty(port,'onmessage',{configurable:true,set(handler){descriptor.set.call(port,handler?event=>{
    const value=event.data;messages.push({kind:value.kind,request:value.request,released:value.released,at:performance.now()});
    if(value.kind==='worker-ready')baseline={ticks,clicks,at:performance.now(),request:value.request};
    waiting.get(value.kind+':'+(value.request??''))?.(value);
    if(withholdReady&&value.kind==='ready'){withheld=value;return;}handler(event);
   }:null);}});
  }
 };
 const wait=(kind,request)=>new Promise((resolve,reject)=>{const key=kind+':'+(request??''),timer=setTimeout(()=>{waiting.delete(key);reject(Error('proof observation deadline '+key));},35000);waiting.set(key,value=>{clearTimeout(timer);waiting.delete(key);resolve(value);});});
 const owner={path:'Notes/Owner.md',extension:'md'},image={path:'Pictures/Photo.png',extension:'png'},vault={},epoch={},root='/synthetic';
 const indexed=new Map([[owner.path,owner],[image.path,image]]);
 const context=source=>{const snapshot={};return {source,owner,vault,root,snapshot,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch,currentVault:()=>vault,currentRoot:()=>root,currentSnapshot:()=>snapshot,fileByPath:path=>indexed.get(path)??null,resolve:target=>target==='Photo.png'?image:null};};
 let coordinator,startupTransport;
 try{
  // Receive a genuine broker reply over the actually transferred endpoint, but
  // deliberately withhold delivery to the host transport's readiness callback.
  withholdReady=true;startupTransport=new api.ImageParserTransport();const ready=wait('ready');const pending=startupTransport.parse('');const startupRejected=pending.then(()=>{throw Error('startup parse unexpectedly succeeded');},error=>{if(error.name!=='AbortError')throw error;return error.name;});
  await ready;const frame=document.querySelector('iframe');await startupTransport.close();const startup={receivedOwnedReady:!!withheld,rejection:await startupRejected,frameRemoved:!frame.isConnected};withholdReady=false;
  const transport=new api.ImageParserTransport();coordinator=new api.ImageParserCoordinator(()=>transport);
  const complete='['.repeat(150000)+']'.repeat(150000),firstReady=wait('worker-ready',1);
  const view={},first=coordinator.project(context(complete),view),firstCancelled=first.then(()=>{throw Error('obsolete first request published');},error=>{if(error.name!=='AbortError')throw error;return error.name;});
  await firstReady;const cancellationStart=performance.now();const second=coordinator.project(context(complete),view),secondCancelled=second.then(()=>{throw Error('obsolete pending request published');},error=>{if(error.name!=='AbortError')throw error;return error.name;});
  const latestReady=wait('worker-ready',2),latest=coordinator.project(context(complete),view);
  const firstError=await firstCancelled,secondError=await secondCancelled;const cancellationMs=performance.now()-cancellationStart;
  await latestReady;const measured=baseline;const projection=await latest;
  const full={status:projection.status,sourceUnits:projection.source.length,occurrences:projection.occurrences.length,issues:projection.issues.length,milliseconds:performance.now()-measured.at,hostTicks:ticks-measured.ticks,hostInputClicks:clicks-measured.clicks,firstError,secondError,cancellationMs,cancelAcknowledged:messages.some(message=>message.kind==='cancelled'&&message.request===1&&message.released===true),obsolete:messages.filter(message=>message.kind==='parsed'&&message.request===1).length};
  const ceilingCases=api.completeImageSourceCases(),characterization={};
  for(const name of ['nestedDelimiters',...Object.keys(ceilingCases).filter(name=>name!=='nestedDelimiters')]){
   const source=ceilingCases[name],started=performance.now(),candidate=name==='nestedDelimiters'?projection:await coordinator.project(context(source),view),parsed=performance.now();
   if(candidate.status!=='ready')throw Error('Unsupported complete characterization '+name);
   const prepared=api.prepareOwnedImageReading(candidate,source),html=prepared.materialize(prepared.source,source),markersMs=performance.now()-parsed;
   const sourceDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source))),byte=>byte.toString(16).padStart(2,'0')).join('');
   characterization[name]={status:candidate.status,sourceUnits:source.length,sourceEqual:candidate.source===source,sourceDigest,occurrences:candidate.occurrences.length,markerFree:!html.includes('<span data-geode-image-occurrence='),projectionMs:name==='nestedDelimiters'?full.milliseconds:parsed-started,markersMs};
  }
  const small='![label][photo]\n\n[photo]: Photo.png "title"',semantic=await coordinator.project(context(small),view);
  const result={startup,full,characterization,semantic:{status:semantic.status,source:semantic.source,occurrences:semantic.occurrences.map(item=>({from:item.from,to:item.to,label:item.label,title:item.title,target:item.target,resolvedPath:item.resolvedPath,status:item.status,keyObject:typeof item.key==='object'})),issues:semantic.issues.length},hostGraphParserFree:api.HOST_PARSER_FREE};
  await coordinator.closeOwner(view);try{await coordinator.project(context(''),view);throw Error('sealed view admitted');}catch(error){if(!/owner.*closed/i.test(error.message))throw error;}
  await coordinator.close();result.framesAfterClose=document.querySelectorAll('iframe').length;result.messages=messages;return result;
 }finally{await coordinator?.close();await startupTransport?.close();window.MessageChannel=NativeChannel;clearInterval(heartbeat);button.remove();}
}
async function probeHost(helperURL,sentinelURL){
 const api=await import(helperURL);const parentFileRead=await(await fetch(sentinelURL)).text();
 window.__IMAGE_PACKED_PROBES=new Promise(resolve=>{window.__IMAGE_PACKED_PROBES_RESOLVE=resolve;});
 const transport=new api.ImageParserTransport();
 try{const payload=await transport.parse('![[Photo.png]]');let timer;try{await Promise.race([window.__IMAGE_PACKED_PROBES,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('native diagnostic relay deadline')),8000);})]);}finally{clearTimeout(timer);}return {parentFileRead,parentRealm:{require:typeof require,geode:typeof geode},units:payload.sourceUnits,rows:payload.candidates.length/12};}
 finally{await transport.close();}
}
async function faultHost(helperURL){
 const api=await import(helperURL),owner={path:'Notes/Owner.md',extension:'md'},vault={},epoch={},snapshot={},view={};let factories=0,initial;
 const context={source:'',owner,vault,root:'/synthetic',snapshot,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch,currentSnapshot:()=>snapshot,currentVault:()=>vault,currentRoot:()=>'/synthetic',fileByPath:path=>path===owner.path?owner:null,resolve:()=>null};
 const coordinator=new api.ImageParserCoordinator(()=>{factories++;return new api.ImageParserTransport();});
 try{await coordinator.project(context,view);throw Error('fault fixture unexpectedly succeeded');}catch(error){initial=error;}
 let refusal,closeFailure,closeSameError;
 try{await coordinator.project(context,view);throw Error('failed epoch admitted another parse');}catch(error){refusal=error.message;}
 try{await coordinator.close();throw Error('failed cleanup unexpectedly reported success');}catch(error){closeFailure=error.message;closeSameError=error===initial;}
 return {first:initial.message,refusal,closeFailure,closeSameError,factories,framesAfterFailure:document.querySelectorAll('iframe').length};
}
app.whenReady().then(async()=>{
 const served=[],consoleMessages=[],modes={},resourceHashes={},effectivePreferences={},parentOrigins={};let hits=0,connections=0,failure,validated=false;
 const server=http.createServer((_req,res)=>{hits++;res.end('UNEXPECTED');});server.on('connection',()=>connections++);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const sentinel=path.join(output,'synthetic-readable-sentinel.txt');fs.writeFileSync(sentinel,'synthetic-packed-parser-sentinel');const sentinelURL=pathToFileURL(sentinel).href;
 const resourceFile=path.join(output,'resources.cjs');fs.writeFileSync(resourceFile,bundle({entryPoints:['src/renderer/image-inspection/parser-resources.ts'],platform:'node',format:'cjs'}));
 const {createParserResourceHandler,BROKER_DOCUMENT,BROKER_CSP,WORKER_CSP}=require(resourceFile);
 const canonical={'index.html':BROKER_DOCUMENT,'broker.mjs':bundle({entryPoints:['src/renderer/image-inspection/parser-broker-entry.ts']}),'worker.mjs':bundle({entryPoints:['src/renderer/image-inspection/parser-worker-entry.ts']})};
 const helperBuild=build({stdin:{contents:'export { ImageParserCoordinator } from "./src/renderer/image-inspection/parser-coordinator"; export { ImageParserTransport } from "./src/renderer/image-inspection/parser-transport"; export { prepareOwnedImageReading } from "./src/renderer/image-inspection/reading-bindings"; export { completeImageSourceCases } from "./tests/unit/helpers/image-source-ceiling-fixtures";',resolveDir:root,sourcefile:'synthetic-packed-proof-host.ts'}});
 const hostInputs=Object.keys(helperBuild.metafile.inputs);assert.ok(!hostInputs.some(file=>/@lezer|markdown-references|parse-source|parser-worker|sync-baseline/.test(file)),'host must not import the grammar');
 assert.ok(hostInputs.includes('src/renderer/image-inspection/source.ts'));assert.ok(hostInputs.includes('src/renderer/image-inspection/reading-bindings.ts'));
 const helper=path.join(output,'host.mjs');fs.writeFileSync(helper,helperBuild.outputFiles[0].text+'\nexport const HOST_PARSER_FREE=true;\n');
 const defs={__IMAGE_PROOF_PORT__:String(server.address().port),__IMAGE_PROOF_FILE__:JSON.stringify(sentinelURL)};
 const relayName='synthetic-packed-proof-'+crypto.randomBytes(16).toString('hex');
 const probeEntry=role=>bundle({entryPoints:[`scripts/image-parser-packed-proof/instrumented-${role}.ts`],define:{...defs,__PACKED_PROOF_CHANNEL__:JSON.stringify(relayName)}});
 const instrumented={'index.html':BROKER_DOCUMENT,'broker.mjs':probeEntry('broker'),'worker.mjs':probeEntry('worker')};
 const faultError={...canonical,'worker.mjs':"throw new Error('synthetic worker startup fault');"};
 const faultMalformed={...canonical,'worker.mjs':"postMessage({kind:'worker-ready',version:1,build:'image-parser-packed-v1'});onmessage=event=>{const {version,build,epoch,nonce,request}=event.data;postMessage({kind:'worker-ready',version,build,epoch,nonce,request});postMessage({kind:'parsed',version,build,epoch,nonce,request,payload:{}});};"};
 const preferences={backgroundThrottling:false,preload:path.join(root,'dist/preload.js'),contextIsolation:false,nodeIntegration:true,sandbox:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,webviewTag:true};
 const parent=path.join(output,'parent.html');fs.writeFileSync(parent,'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-eval\'; frame-src geode-image-parser://broker/index.html"><body>Trusted synthetic packed-proof parent</body>');
 try{
  for(const [mode,resources] of [['canonical',canonical],['instrumented',instrumented],['fault-error',faultError],['fault-malformed',faultMalformed]]){
   const directory=path.join(output,mode);fs.mkdirSync(directory,{recursive:true});resourceHashes[mode]={};for(const [name,body] of Object.entries(resources)){fs.writeFileSync(path.join(directory,name),body);resourceHashes[mode][name]=hash(body);}
   const handle=createParserResourceHandler(resources);protocol.handle('geode-image-parser',request=>{const response=handle(request);served.push({mode,url:request.url,method:request.method,status:response.status,csp:response.headers.get('Content-Security-Policy'),mime:response.headers.get('Content-Type'),nosniff:response.headers.get('X-Content-Type-Options')});return response;});
   const win=new BrowserWindow({show:true,width:900,height:600,webPreferences:preferences});let probeReports=0;
   win.webContents.on('console-message',event=>{consoleMessages.push({mode,message:event.message});if(mode==='instrumented'&&(event.message.startsWith('IMAGE_PACKED_REALM ')||event.message.startsWith('IMAGE_PACKED_TRANSFER '))&&++probeReports===3)void win.webContents.executeJavaScript('window.__IMAGE_PACKED_PROBES_RESOLVE?.()').catch(error=>consoleMessages.push({mode,message:'synthetic diagnostic dispatch failed: '+error.message}));});
   let input;
   try{await win.loadFile(parent);const parentDOMOrigin=await win.webContents.executeJavaScript('({locationProtocol:location.protocol,locationOrigin:location.origin,globalOrigin:globalThis.origin,urlOrigin:new URL(location.href).origin})');assert.equal(parentDOMOrigin.locationProtocol,'file:');parentOrigins[mode]={webFrameMainOrigin:win.webContents.mainFrame.origin,...parentDOMOrigin};const actual=win.webContents.getLastWebPreferences();effectivePreferences[mode]=Object.fromEntries(['contextIsolation','nodeIntegration','sandbox','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webSecurity','preload'].map(key=>[key,actual[key]]));for(const key of ['contextIsolation','nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webSecurity'])assert.equal(actual[key],preferences[key],key);win.focus();input=setInterval(()=>{if(!win.isDestroyed()){win.webContents.sendInputEvent({type:'mouseDown',x:50,y:30,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:50,y:30,button:'left',clickCount:1});}},100);
    let negative;
    if(mode==='canonical'){
     const session=await win.webContents.executeJavaScript(`(${prepareNativeRejectionFrames.toString()})()`);
     const frames=win.webContents.mainFrame.frames;assert.equal(frames.length,2);const foreignFrame=frames.find(frame=>frame.name==='synthetic-foreign');assert.ok(foreignFrame);assert.equal(foreignFrame.origin,'geode-image-parser://broker');const targetFrame=frames.find(frame=>frame.name==='synthetic-target');assert.ok(targetFrame);
     await targetFrame.executeJavaScript(`globalThis.__OWNED_PACKED_OBSERVED=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned initialization observation deadline')),8000);const observe=event=>{const value=event.data;if(event.source===parent&&value?.kind==='initialize'&&value.version===1&&value.build==='image-parser-packed-v1'&&value.epoch===7&&value.nonce===${JSON.stringify(session.nonce)}&&Object.keys(value).length===5){removeEventListener('message',observe);clearTimeout(timer);resolve({origin:event.origin,actualParent:event.source===parent});}};addEventListener('message',observe);});true;`);
     await targetFrame.executeJavaScript(`globalThis.__FOREIGN_PACKED_OBSERVED=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('foreign initialization observation deadline')),8000);const observe=event=>{if(event.data?.kind==='initialize'&&event.data.nonce===${JSON.stringify(session.nonce)}){removeEventListener('message',observe);clearTimeout(timer);resolve({origin:event.origin,actualSibling:event.source===parent.frames[0]});}};addEventListener('message',observe);});true;`);
     await foreignFrame.executeJavaScript(`globalThis.__FOREIGN_PACKED_MESSAGES=[];globalThis.__FOREIGN_PACKED_CHANNEL=new MessageChannel();__FOREIGN_PACKED_CHANNEL.port1.onmessage=event=>__FOREIGN_PACKED_MESSAGES.push(event.data);__FOREIGN_PACKED_CHANNEL.port1.start();parent.frames[1].postMessage(${JSON.stringify({kind:'initialize',...session})},'geode-image-parser://broker',[__FOREIGN_PACKED_CHANNEL.port2]);`);
     const observedForeign=await targetFrame.executeJavaScript('globalThis.__FOREIGN_PACKED_OBSERVED');assert.deepEqual(observedForeign,{origin:'geode-image-parser://broker',actualSibling:true});
     negative=await win.webContents.executeJavaScript(`(${completeNativeRejections.toString()})()`);negative.observedNativeForeign=observedForeign;negative.observedNativeParent=await targetFrame.executeJavaScript('globalThis.__OWNED_PACKED_OBSERVED');assert.deepEqual(negative.observedNativeParent,{origin:'null',actualParent:true});
     negative.actualForeignFrameResponses=await foreignFrame.executeJavaScript('globalThis.__FOREIGN_PACKED_MESSAGES.length');
     await foreignFrame.executeJavaScript('__FOREIGN_PACKED_CHANNEL.port1.close()');
     await win.webContents.executeJavaScript('for(const channel of __PACKED_NEGATIVE.channels){channel.port1.close();channel.port2.close();}for(const frame of __PACKED_NEGATIVE.frames)frame.remove();delete window.__PACKED_NEGATIVE;');
    }
    modes[mode]=await win.webContents.executeJavaScript(`(${(mode==='canonical'?canonicalHost:mode==='instrumented'?probeHost:faultHost).toString()})(${JSON.stringify(pathToFileURL(helper).href)},${JSON.stringify(sentinelURL)})`);modes[mode].proofMode=mode;if(negative)modes[mode].negative=negative;
   }finally{clearInterval(input);win.destroy();protocol.unhandle('geode-image-parser');}
  }
  const result=modes.canonical;assert.equal(result.negative.foreignResponses,0);assert.equal(result.negative.actualForeignFrameResponses,0);assert.equal(result.negative.sourceUnits,14);assert.equal(result.negative.rows,1);assert.ok(!result.negative.ownedMessages.some(value=>value.request===99));assert.deepEqual(result.startup,{receivedOwnedReady:true,rejection:'AbortError',frameRemoved:true});assert.equal(result.hostGraphParserFree,true);assert.equal(result.framesAfterClose,0);
  assert.equal(result.full.status,'ready');assert.equal(result.full.sourceUnits,300000);assert.equal(result.full.occurrences,0);assert.equal(result.full.issues,0);assert.equal(result.full.firstError,'AbortError');assert.equal(result.full.secondError,'AbortError');assert.equal(result.full.cancelAcknowledged,true);assert.equal(result.full.obsolete,0);assert.ok(result.full.cancellationMs<1000);assert.ok(result.full.hostTicks>10);assert.ok(result.full.hostInputClicks>2);
  assert.equal(result.semantic.status,'ready');assert.equal(result.semantic.occurrences.length,1);assert.deepEqual(result.semantic.occurrences[0],{from:0,to:15,label:'label',title:'title',target:'Photo.png',resolvedPath:'Pictures/Photo.png',status:'ready',keyObject:true});assert.equal(result.semantic.issues,0);
  const expectedCeiling=require(path.join(root,'tests/unit/helpers/image-source-ceiling-fingerprints.json'));assert.deepEqual(Object.keys(result.characterization).sort(),Object.keys(expectedCeiling).sort());
  for(const [name,expected] of Object.entries(expectedCeiling)){const actual=result.characterization[name];assert.equal(actual.status,'ready');assert.equal(actual.sourceUnits,expected.units);assert.equal(actual.sourceEqual,true);assert.equal(actual.sourceDigest,expected.sha256);assert.equal(actual.occurrences,expected.occurrences);assert.equal(actual.markerFree,true);}
  const probes=consoleMessages.filter(item=>item.message.startsWith('IMAGE_PACKED_REALM ')).map(item=>JSON.parse(item.message.slice('IMAGE_PACKED_REALM '.length)));assert.equal(probes.length,2);assert.deepEqual(probes.map(item=>item.role).sort(),['broker','worker']);const transfers=consoleMessages.filter(item=>item.message.startsWith('IMAGE_PACKED_TRANSFER ')).map(item=>JSON.parse(item.message.slice('IMAGE_PACKED_TRANSFER '.length)));assert.deepEqual(transfers,[{kind:'transfer',request:1,buffers:3,byteLengthsBefore:[48,0,0],detached:true}]);
  for(const {role,proof} of probes){for(const value of Object.values(proof.realm))assert.equal(value,'undefined');for(const name of ['eval','wasm','fetch','localFetch','import','xhr','wss'])assert.equal(proof[name],true,role+':'+name);if(role==='broker'){assert.equal(proof.parentDOM,true);assert.equal(proof.parentNode,true);}else assert.equal(proof.descendant,true);}
  assert.equal(modes.instrumented.parentFileRead,'synthetic-packed-parser-sentinel');assert.equal(modes.instrumented.parentRealm.require,'function');assert.equal(modes.instrumented.parentRealm.geode,'object');assert.equal(modes.instrumented.units,14);assert.equal(modes.instrumented.rows,1);assert.equal(hits,0);assert.equal(connections,0);assert.ok(consoleMessages.some(item=>item.message.includes('synthetic-readable-sentinel.txt')&&/Content Security Policy|connect-src/.test(item.message)));
  for(const [mode,code] of [['fault-error','worker-error'],['fault-malformed','invalid-result']]){const fault=modes[mode];assert.equal(fault.first,'Image parser '+code+'.');assert.match(fault.refusal,/closed|unavailable/i);assert.equal(fault.closeFailure,fault.first);assert.equal(fault.closeSameError,true);assert.equal(fault.factories,1);assert.equal(fault.framesAfterFailure,0);assert.equal(served.filter(entry=>entry.mode===mode&&entry.url.endsWith('/worker.mjs')).length,1);}
  for(const entry of served){assert.ok(['index.html','broker.mjs','worker.mjs'].some(name=>entry.url==='geode-image-parser://broker/'+name));assert.equal(entry.method,'GET');assert.equal(entry.status,200);assert.equal(entry.nosniff,'nosniff');assert.equal(entry.mime,entry.url.endsWith('.mjs')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');assert.equal(entry.csp,entry.url.endsWith('worker.mjs')?WORKER_CSP:BROKER_CSP);}
  validated=true;
 }catch(error){failure=String(error.stack||error);}
 const report={validated,runId:process.env.GEODE_IMAGE_PARSER_PROOF_RUN_ID||null,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),electron:process.versions.electron,node:process.versions.node,processSandboxDisabled:app.commandLine.hasSwitch('no-sandbox'),preferences,effectivePreferences,parentOrigins,resourceHashes,sourceHashes:Object.fromEntries(['src/renderer/image-inspection/parser-protocol.ts','src/renderer/image-inspection/parser-coordinator.ts','src/renderer/image-inspection/parser-transport.ts','src/renderer/image-inspection/parser-broker.ts','src/renderer/image-inspection/parser-worker.ts','src/renderer/image-inspection/parser-resources.ts','src/renderer/image-inspection/parse-source.ts','src/renderer/image-inspection/packed.ts','src/renderer/image-inspection/async-source.ts','src/renderer/image-inspection/source.ts','src/renderer/image-inspection/reading-bindings.ts','tests/unit/helpers/image-source-ceiling-fixtures.ts','tests/unit/helpers/image-source-ceiling-fingerprints.json','scripts/proof-image-parser-packed.cjs','scripts/run-image-parser-packed-proof.cjs','scripts/check-image-parser-packed-report.cjs','scripts/image-parser-packed-proof/instrumented-broker.ts','scripts/image-parser-packed-proof/instrumented-worker.ts','scripts/image-parser-proof/native-probe.mjs'].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),hostInputs,hostHash:hash(fs.readFileSync(helper)),preloadHash:hash(fs.readFileSync(path.join(root,'dist/preload.js'))),modes,served,consoleMessages,hits,connections,failure:failure||null,limits:'Unwired private runtime proof. Canonical assets, separately labelled instrumented native-probe wrappers and synthetic fatal-worker fixtures differ; all served bytes archived. Linux --no-sandbox mode only. Local worker handle/listener release and endpoint/frame disposal do not prove OS process settlement or heap reclamation. No production integration or complete parity claim.'};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await new Promise(resolve=>server.close(resolve));app.exit(failure?1:0);
}).catch(error=>{console.error(error);app.exit(1);});

/** Test-only fixed-origin broker; never installed in production. */
import { isProofInit, isProofRequest, BUILD } from './protocol';
import { probeRealm } from './native-probe.mjs';
let initialized = false;
addEventListener('message',async event => {
  if (initialized || event.source !== parent || event.origin !== 'null' || !isProofInit(event.data) || event.ports.length !== 1) return;
  initialized = true;
  const init = event.data, port = event.ports[0];
  const proof = await probeRealm(false);
  proof.initialization = { parentOrigin:event.origin, actualParent:event.source===parent };
  let worker, active, stopped = false;
  const send = value => {if(!stopped)port.postMessage({...value,version:1,build:BUILD,epoch:init.epoch,nonce:init.nonce});};
  const terminate = () => {
    if (worker) {worker.onmessage = null;worker.onerror = null;worker.terminate();worker = undefined;}
    active = undefined;
  };
  port.onmessage = event => {
    const value = event.data;
    if (!isProofRequest(value,init.epoch)) return;
    if (value.kind === 'cancel') {
      if (active !== value.request) return;
      terminate();send({kind:'cancelled',request:value.request,workerHandleReleased:!worker});return;
    }
    if (worker || active) {send({kind:'busy',request:value.request});return;}
    active = value.request;
    worker = new Worker('geode-image-parser://broker/worker.mjs',{type:'module'});
    worker.onerror = () => {terminate();send({kind:'failed',request:value.request,code:'worker-error'});};
    worker.onmessage = event => {
      if (!worker || active !== value.request) return;
      if(event.data.kind === 'worker-ready') {
        send({kind:'worker-ready',request:value.request,proof:event.data.proof});worker.postMessage(value);
      } else if (event.data.kind === 'parsing') send(event.data);
      else if (event.data.kind === 'parsed') {const result = event.data;terminate();send(result);}
    };
  };
  port.onmessageerror = () => {terminate();stopped=true;port.close();};
  port.start();send({kind:'ready',proof});
});

/** Synthetic test-only native browser probes: no API replacement or build-defined globals. */
export async function probeRealm(workerRealm) {
  const keys = ['process','require','geode','electron','ipcRenderer','Buffer'];
  if (workerRealm) keys.push('window','document');
  const realm = Object.fromEntries(keys.map(key => [key, typeof Reflect.get(globalThis,key)]));
  const denied = async action => { try { await action(); return false; } catch { return true; } };
  const result = { realm };
  result.eval = await denied(() => (0,eval)('1'));
  result.wasm = await denied(() => WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])));
  result.fetch = await denied(() => fetch(`http://127.0.0.1:${__IMAGE_PROOF_PORT__}/fetch`));
  result.localFetch = await denied(() => fetch(__IMAGE_PROOF_FILE__));
  result.import = await denied(() => import(`http://127.0.0.1:${__IMAGE_PROOF_PORT__}/foreign.mjs`));
  result.xhr = await new Promise(resolve => {
    try { const xhr = new XMLHttpRequest(); xhr.open('GET',`http://127.0.0.1:${__IMAGE_PROOF_PORT__}/xhr`); xhr.onerror = () => resolve(true); xhr.onload = () => resolve(false); xhr.send(); } catch { resolve(true); }
  });
  result.wss = await new Promise(resolve => {
    try { const socket = new WebSocket(`wss://127.0.0.1:${__IMAGE_PROOF_PORT__}/socket`); socket.onerror = () => resolve(true); socket.onopen = () => {socket.close();resolve(false);}; } catch { resolve(true); }
  });
  if (workerRealm) result.descendant = await denied(() => {
    const child = new Worker('geode-image-parser://broker/worker.mjs',{type:'module'});
    return new Promise((resolve,reject) => { child.onerror = () => {child.terminate();reject(Error('policy denied'));}; child.onmessage = () => {child.terminate();resolve();}; });
  });
  else {
    result.parentDOM = await denied(() => parent.document.body);
    result.parentNode = await denied(() => parent.require('node:fs'));
  }
  return result;
}

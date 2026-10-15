/** Test-only native API probes run before operational parser allowlists install. */
export async function nativeProbe() {
  const realm = {};
  for (const key of ["process", "require", "geode", "electron", "ipcRenderer", "Buffer", "window", "document"]) realm[key] = typeof Reflect.get(globalThis, key);
  const result = { realm };
  try { eval("1"); result.eval = false; } catch { result.eval = true; }
  try { await fetch(`http://127.0.0.1:${__PDF_PROOF_PORT__}/fetch`); result.fetch = false; } catch { result.fetch = true; }
  try { await import(`http://127.0.0.1:${__PDF_PROOF_PORT__}/import.mjs`); result.import = false; } catch { result.import = true; }
  result.xhr = await new Promise(resolve => {
    try { const xhr = new XMLHttpRequest(); xhr.open("GET", `http://127.0.0.1:${__PDF_PROOF_PORT__}/xhr`); xhr.onerror = () => resolve(true); xhr.onload = () => resolve(false); xhr.send(); }
    catch { resolve(true); }
  });
  result.wss = await new Promise(resolve => {
    try { const socket = new WebSocket(`wss://127.0.0.1:${__PDF_PROOF_PORT__}/socket`); socket.onerror = () => resolve(true); socket.onopen = () => { socket.close(); resolve(false); }; }
    catch { resolve(true); }
  });
  try {
    const worker = new Worker("geode-pdf://viewer/worker.mjs", { type: "module" });
    result.subworker = await new Promise(resolve => { worker.onerror = () => resolve(true); worker.onmessage = () => resolve(false); setTimeout(() => resolve("timeout"), 1000); });
    worker.terminate();
  } catch { result.subworker = true; }
  try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); result.wasm = true; } catch { result.wasm = false; }
  return result;
}

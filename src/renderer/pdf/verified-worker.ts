export const PDF_REALM_KEYS = ["process", "require", "geode", "electron", "ipcRenderer", "Buffer", "window", "document"] as const;
export function pdfWorkerRealm(scope: object): Record<string, string> {
  const realm: Record<string, string> = Object.create(null);
  for (const key of PDF_REALM_KEYS) realm[key] = typeof Reflect.get(scope, key);
  return realm;
}
export function verifyPdfWorker(worker: Worker, version: string, signal?: AbortSignal): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); worker.removeEventListener("message", message); worker.removeEventListener("error", failed); signal?.removeEventListener("abort", cancelled);
    };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); try { worker.terminate(); } finally { reject(error); } };
    const failed = () => fail(new Error("The isolated PDF worker could not start. Try again."));
    const cancelled = () => { const error = new Error("PDF loading cancelled."); error.name = "AbortError"; fail(error); };
    const message = (event: MessageEvent) => {
      const data = event.data;
      if (data?.kind !== "geode-pdf-worker-ready") return;
      if (data.version !== version || !data.realm || !PDF_REALM_KEYS.every(key => Object.hasOwn(data.realm, key) && data.realm[key] === "undefined")) { fail(new Error("PDF worker isolation or version check failed.")); return; }
      if (settled) return;
      settled = true; cleanup(); resolve(worker);
    };
    const timer = setTimeout(() => fail(new Error("The isolated PDF worker timed out. Try again.")), 8000);
    worker.addEventListener("message", message); worker.addEventListener("error", failed); signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

import { BUILD, ORIGIN, isParserInit, isParserRequest, isParserReply, type ParserSession } from "./parser-protocol";
import { validatePackedImages } from "./packed";
/** Fixed document entry only; never registered or installed by the application in this package. */
export function installParserBroker(scope: Window = window, createWorker: () => Worker = () => new Worker(`${ORIGIN}/worker.mjs`, { type: "module" })): void {
  let initialized = false;
  scope.addEventListener("message", event => {
    if (initialized || event.source !== scope.parent || event.origin !== "null" || event.ports.length !== 1 || !isParserInit(event.data)) return;
    initialized = true;
    const session: ParserSession = event.data, port = event.ports[0];
    let stopped = false, failed = false;
    let active: { worker: Worker; request: number; source: string; booted: boolean; started: boolean } | undefined;
    const send = (value: object, transfer: Transferable[] = []) => port.postMessage({ ...value, version: session.version, build: session.build, epoch: session.epoch, nonce: session.nonce }, transfer);
    const terminate = () => {
      const current = active;
      if (current) {
        current.worker.onmessage = null;current.worker.onerror = null;current.worker.onmessageerror = null;
        current.worker.terminate();active = undefined;
      }
    };
    const failure = (request: number, code: "worker-error" | "invalid-result") => {
      failed = true;terminate();send({ kind: "failed", request, code });
    };
    port.onmessageerror = () => { failed = true;terminate();stopped = true;port.onmessage = null;port.onmessageerror = null;port.close(); };
    port.onmessage = event => {
      if (stopped || !isParserRequest(event.data, session)) return;
      const value = event.data;
      if (value.kind === "close") {
        terminate();stopped = true;send({ kind: "closed" });port.onmessage = null;port.onmessageerror = null;port.close();return;
      }
      if (value.kind === "cancel") {
        if (active?.request !== value.request) return;
        terminate();send({ kind: "cancelled", request: value.request, released: true });return;
      }
      if (failed || active) return;
      let worker: Worker;
      try { worker = createWorker(); } catch { failure(value.request, "worker-error");return; }
      const current = { worker, request: value.request, source: value.source, booted: false, started: false };
      active = current;
      worker.onerror = () => { if (active === current) failure(value.request, "worker-error"); };
      worker.onmessageerror = () => { if (active === current) failure(value.request, "invalid-result"); };
      worker.onmessage = event => {
        if (active !== current || stopped) return;
        const reply = event.data;
        if (!current.booted) {
          if (!reply || Object.keys(reply).length !== 3 || reply.kind !== "worker-ready" || reply.version !== 1 || reply.build !== BUILD) { failure(value.request, "invalid-result");return; }
          current.booted = true;
          try { worker.postMessage(value); } catch { failure(value.request, "worker-error"); }
          return;
        }
        if (!isParserReply(reply, session) || reply.kind !== "parsed" && reply.kind !== "failed" && reply.kind !== "worker-ready" || reply.request !== current.request) { failure(value.request, "invalid-result");return; }
        if (reply.kind === "failed") { failure(value.request, reply.code);return; }
        if (reply.kind === "worker-ready" && !current.started) { current.started = true;send({ kind: "worker-ready", request: current.request });return; }
        if (!current.started || reply.kind !== "parsed") { failure(value.request, "invalid-result");return; }
        try {
          const payload = validatePackedImages(current.source, reply.payload);
          terminate();send({ kind: "parsed", request: value.request, payload }, [payload.candidates.buffer as ArrayBuffer, payload.definitions.buffer as ArrayBuffer, payload.issues.buffer as ArrayBuffer]);
        } catch { failure(value.request, "invalid-result"); }
      };
    };
    port.start();send({ kind: "ready" });
  });
}

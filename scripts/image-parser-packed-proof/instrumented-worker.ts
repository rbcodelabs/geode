/** Synthetic diagnostics only; executes native postMessage and observes its return. */
import { installParserWorker, type ParserWorkerScope } from "../../src/renderer/image-inspection/parser-worker";
import { probeRealm } from "../image-parser-proof/native-probe.mjs";
declare const __PACKED_PROOF_CHANNEL__: string;
const relay = new BroadcastChannel(__PACKED_PROOF_CHANNEL__);
const proof = await probeRealm(true);
relay.postMessage({ role: "worker", proof });
const scope = globalThis as unknown as ParserWorkerScope;
const nativePost = scope.postMessage.bind(scope);
installParserWorker({
  get onmessage() { return scope.onmessage; },
  set onmessage(handler) { scope.onmessage = handler; },
  postMessage(value, transfer = []) {
    const byteLengthsBefore = transfer.map(buffer => buffer instanceof ArrayBuffer ? buffer.byteLength : -1);
    nativePost(value, transfer);
    if ((value as { kind?: string }).kind === "parsed") {
      relay.postMessage({ kind: "transfer", request: (value as { request: number }).request,
        buffers: transfer.length, byteLengthsBefore, detached: transfer.every(buffer => {
          if (!(buffer instanceof ArrayBuffer)) return false;
          try { new Uint8Array(buffer);return false; } catch { return true; }
        }) });
      relay.close();
    }
  },
});

/** Synthetic diagnostics only. Canonical assets do not import this module. */
import { installParserBroker } from "../../src/renderer/image-inspection/parser-broker";
import { ORIGIN } from "../../src/renderer/image-inspection/parser-protocol";
import { probeRealm } from "../image-parser-proof/native-probe.mjs";
declare const __PACKED_PROOF_CHANNEL__: string;
const relay = new BroadcastChannel(__PACKED_PROOF_CHANNEL__);
const detached = new Set<number>(), pending = new Map<number, () => void>();
relay.onmessage = event => {
  if (event.data.kind === "transfer") {
    console.log("IMAGE_PACKED_TRANSFER " + JSON.stringify(event.data));
    detached.add(event.data.request);
    pending.get(event.data.request)?.();pending.delete(event.data.request);
  } else console.log("IMAGE_PACKED_REALM " + JSON.stringify(event.data));
};
installParserBroker(window, () => {
  const worker = new Worker(`${ORIGIN}/worker.mjs`, { type: "module" });
  const setter = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage")!.set!;
  Object.defineProperty(worker, "onmessage", { configurable: true, set(handler: ((event: MessageEvent) => void) | null) {
    setter.call(worker, handler ? (event: MessageEvent) => {
      // Keep this small diagnostic worker alive until its postMessage-return
      // detachment observation arrives. Canonical mode has no such delay.
      if (event.data.kind === "parsed" && !detached.has(event.data.request)) pending.set(event.data.request, () => handler(event));
      else handler(event);
    } : null);
  } });
  return worker;
});
const proof = await probeRealm(false);
console.log("IMAGE_PACKED_REALM " + JSON.stringify({ role: "broker", proof }));

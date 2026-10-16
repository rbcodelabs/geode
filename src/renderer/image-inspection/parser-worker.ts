import { BUILD, isParserRequest, type ParserSession } from "./parser-protocol";
import { extractPackedImageSource } from "./parse-source";
export interface ParserWorkerScope { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void }
/** Worker-only complete analysis. No file resolution, occurrence authority or host fallback. */
export function installParserWorker(scope: ParserWorkerScope): void {
  let admitted = false;
  scope.onmessage = event => {
    if (admitted) return;
    const value = event.data;
    const session: ParserSession = { version: 1, build: BUILD, epoch: value?.epoch, nonce: value?.nonce };
    if (!isParserRequest(value, session) || value.kind !== "parse") return;
    admitted = true;
    try {
      scope.postMessage({ kind: "worker-ready", ...session, request: value.request });
      const payload = extractPackedImageSource(value.source);
      scope.postMessage({ kind: "parsed", ...session, request: value.request, payload }, [payload.candidates.buffer as ArrayBuffer, payload.definitions.buffer as ArrayBuffer, payload.issues.buffer as ArrayBuffer]);
    } catch {
      scope.postMessage({ kind: "failed", ...session, request: value.request, code: "invalid-result" });
    }
  };
  scope.postMessage({ kind: "worker-ready", version: 1, build: BUILD });
}

/** Test-only ADR0043 runtime boundary. Not imported or installed by the app. */
export const BUILD = "image-parser-proof-v1";
export const ORIGIN = "geode-image-parser://broker";
export const BROKER_CSP = "default-src 'none'; script-src 'self'; worker-src geode-image-parser://broker/worker.mjs; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const WORKER_CSP = "default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export interface ProofInit { kind: "initialize"; version: 1; build: string; epoch: number; nonce: string }
export function isProofInit(value: unknown): value is ProofInit {
  return record(value) && exact(value, ["kind", "version", "build", "epoch", "nonce"]) && value.kind === "initialize" && value.version === 1 && value.build === BUILD && positive(value.epoch) && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce);
}
export type ProofRequest = { kind: "parse"; version: 1; epoch: number; request: number; source: string } | { kind: "cancel"; version: 1; epoch: number; request: number };
export function isProofRequest(value: unknown, epoch: number): value is ProofRequest {
  if (!record(value) || value.version !== 1 || value.epoch !== epoch || !positive(value.request)) return false;
  if (value.kind === "cancel") return exact(value, ["kind", "version", "epoch", "request"]);
  return value.kind === "parse" && exact(value, ["kind", "version", "epoch", "request", "source"]) && typeof value.source === "string" && value.source.length <= 300_000 && !value.source.includes("\r");
}
export function createProofProtocol(resources: Readonly<Record<"index.html" | "broker.mjs" | "worker.mjs", string>>) {
  const inventory = new Map(Object.entries(resources).map(([name, body]) => [`${ORIGIN}/${name}`, { body, name }]));
  return (request: { method: string; url: string }): Response => {
    const item = inventory.get(request.url);
    if (request.method !== "GET" || !item) return new Response(null, { status: 404 });
    return new Response(item.body, { headers: { "Content-Type": item.name.endsWith(".mjs") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", "Content-Security-Policy": item.name === "worker.mjs" ? WORKER_CSP : BROKER_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  };
}

export function isProofReady(value: unknown, init: ProofInit): boolean {
  return record(value) && exact(value, ["kind", "version", "build", "epoch", "nonce", "proof"]) && value.kind === "ready" && value.version === 1 && value.build === init.build && value.epoch === init.epoch && value.nonce === init.nonce && record(value.proof) && record(value.proof.realm) && ["process", "require", "geode", "electron", "ipcRenderer", "Buffer"].every(key => Object.hasOwn(value.proof.realm as object, key) && (value.proof.realm as Record<string, unknown>)[key] === "undefined");
}

import { ORIGIN } from "./parser-protocol";
export const BROKER_CSP = "default-src 'none'; script-src 'self'; worker-src geode-image-parser://broker/worker.mjs; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const WORKER_CSP = "default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
export const BROKER_DOCUMENT = '<!doctype html><html><head><script type="module" src="./broker.mjs"></script></head><body></body></html>';
export type ParserResources = Readonly<Record<"index.html" | "broker.mjs" | "worker.mjs", string>>;
/** Fixed packaged bytes only. This factory does not install a production protocol handler. */
export function createParserResourceHandler(resources: ParserResources): (request: { method: string; url: string }) => Response {
  const names = ["index.html", "broker.mjs", "worker.mjs"] as const;
  if (Object.keys(resources).length !== names.length || !names.every(name => Object.hasOwn(resources, name) && typeof resources[name] === "string")) throw new Error("Invalid image parser resource inventory.");
  const inventory = new Map(names.map(name => [`${ORIGIN}/${name}`, { name, body: resources[name] }]));
  return request => {
    const item = inventory.get(request.url);
    if (request.method !== "GET" || !item) return new Response(null, { status: 404 });
    return new Response(item.body, { headers: {
      "Content-Type": item.name.endsWith(".mjs") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
      "Content-Security-Policy": item.name === "worker.mjs" ? WORKER_CSP : BROKER_CSP,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    } });
  };
}

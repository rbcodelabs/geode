export const PDF_SCHEME = "geode-pdf";
export const PDF_FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src blob: data:; img-src blob: data:; connect-src 'none'; worker-src geode-pdf://viewer/worker.mjs; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const PDF_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
export type PdfProtocolResources = Readonly<Record<"index.html" | "viewer.mjs" | "worker.mjs" | "viewer.css", string>>;
/** Fixed app bytes only: no request-dependent filesystem or network operation. */
export function createPdfProtocolHandler(resources: PdfProtocolResources): (request: { url: string; method: string }) => Response {
  const entries = new Map((["index.html", "viewer.mjs", "worker.mjs", "viewer.css"] as const).map(name => [`geode-pdf://viewer/${name}`, { body: resources[name], type: name.endsWith(".mjs") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html", csp: name === "worker.mjs" ? PDF_WORKER_CSP : PDF_FRAME_CSP }]));
  return request => {
    const resource = entries.get(request.url);
    if (request.method !== "GET" || !resource) return new Response(null, { status: 404 });
    return new Response(resource.body, { headers: { "Content-Type": resource.type + "; charset=utf-8", "Content-Security-Policy": resource.csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
  };
}

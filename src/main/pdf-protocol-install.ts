import type { Protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPdfProtocolHandler, PDF_SCHEME } from "./pdf-protocol";
/** Only fixed packaged files are read, once; requests cannot select a path. */
export function installPdfProtocol(target: Pick<Protocol, "handle">, bundleDirectory: string): void {
  target.handle(PDF_SCHEME, createPdfProtocolHandler({
    "index.html": fs.readFileSync(path.join(bundleDirectory, "pdf-viewer.html"), "utf8"),
    "viewer.mjs": fs.readFileSync(path.join(bundleDirectory, "pdf-viewer.mjs"), "utf8"),
    "worker.mjs": fs.readFileSync(path.join(bundleDirectory, "pdf-worker.mjs"), "utf8"),
    "viewer.css": fs.readFileSync(path.join(bundleDirectory, "pdf-viewer.css"), "utf8"),
  }));
}

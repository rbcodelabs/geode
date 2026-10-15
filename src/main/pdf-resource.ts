import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { PDF_LIMITS } from "../shared/pdf";

interface PdfReadRequest { root: string; expectedRoot: string; path: string; current(): boolean; limit?: number }
const inside = (root: string, target: string) => target !== root && target.startsWith(root + path.sep);
/** Authorized local-vault PDF bytes only; callers supply a captured session predicate. */
export async function readAuthorizedPdf(request: PdfReadRequest): Promise<ArrayBuffer> {
  const check = () => { if (request.root !== request.expectedRoot || !request.current()) throw new Error("PDF vault session changed or is unavailable."); };
  check();
  const relative = request.path;
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative) || /^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..") || path.extname(relative).toLowerCase() !== ".pdf") throw new Error("PDF path must identify a PDF inside the current vault.");
  const root = await fs.realpath(request.root); check();
  const authored = path.resolve(request.root, relative), target = await fs.realpath(authored); check();
  if (!inside(root, target)) throw new Error("PDF path resolves outside the vault.");
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    check(); const before = await handle.stat(); check();
    const limit = Math.min(request.limit ?? PDF_LIMITS.bytes, PDF_LIMITS.bytes);
    if (!Number.isSafeInteger(limit) || limit < 5 || !before.isFile() || before.size < 5) throw new Error("This PDF is empty or unsupported.");
    if (before.size > limit) throw new Error(`PDF exceeds the ${limit}-byte resource limit.`);
    const verifyPath = async () => {
      const currentRoot = await fs.realpath(request.root); check();
      const currentTarget = await fs.realpath(authored); check();
      if (currentRoot !== root || currentTarget !== target || !inside(root, currentTarget)) throw new Error("PDF vault path changed during loading.");
      const identity = await fs.stat(currentTarget); check();
      if (identity.dev !== before.dev || identity.ino !== before.ino) throw new Error("PDF file changed during loading.");
    };
    await verifyPath();
    // Read at most the observed size plus one byte, even if a file grows mid-read.
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset); check();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat(); check(); await verifyPath();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("PDF file changed during loading. Try again.");
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("This file is not a supported PDF.");
    return Uint8Array.from(bytes.subarray(0, offset)).buffer;
  } finally { await handle.close(); }
}

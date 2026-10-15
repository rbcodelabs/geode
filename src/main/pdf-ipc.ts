import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { readAuthorizedPdf } from "./pdf-resource";
interface PdfReadAuthority { root: string; current(): boolean }
/** Internal read-only IPC. The viewer subframe never receives this capability. */
export function registerPdfReadIpc(ipc: Pick<IpcMain, "handle">, authorityFor: (event: IpcMainInvokeEvent) => PdfReadAuthority, read: typeof readAuthorizedPdf = readAuthorizedPdf): void {
  const active = new WeakMap<object, number>();
  ipc.handle("vault-read-pdf", async (event: IpcMainInvokeEvent, request: unknown) => {
    const sender = event.sender, frame = event.senderFrame;
    if (sender.isDestroyed() || !frame || frame !== sender.mainFrame) throw new Error("PDF reads require the current main application frame.");
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error("Invalid PDF read request.");
    const input = request as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== "root" && key !== "path") || typeof input.root !== "string" || typeof input.path !== "string" || input.root.length > 4096 || input.path.length > 4096) throw new Error("Invalid PDF read request.");
    const authority = authorityFor(event), count = active.get(sender) ?? 0;
    if (count >= 4) throw new Error("PDF reads are busy. Retry after another PDF finishes loading.");
    active.set(sender, count + 1);
    try {
      return await read({ root: authority.root, expectedRoot: input.root, path: input.path, current: () => !sender.isDestroyed() && sender.mainFrame === frame && authority.current() });
    } finally {
      const remaining = (active.get(sender) ?? 1) - 1;
      if (remaining) active.set(sender, remaining); else active.delete(sender);
    }
  });
}

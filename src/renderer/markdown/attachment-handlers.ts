import { EditorView } from "@codemirror/view";
import {
  imageFilesFromDrop,
  imageFilesFromPaste,
  saveImageAttachments,
  type AttachmentOrigin,
  type AttachmentSource,
  type AttachmentVault,
} from "../attachments";
import type { TFile } from "../types";

export interface AttachmentHandlerContext {
  vault: AttachmentVault;
  /** The wikilink target for `file` as written from the note at `sourcePath`. */
  linktext(file: TFile, sourcePath: string): string;
  /** Vault path of the note being edited, or "" when the editor has no file. */
  sourcePath(): string;
  /** False while the note is read-only (conflict recovery, vault switch). */
  canEdit(): boolean;
  notify(message: string): void;
}

/**
 * Paste and drop of image files into a note: each image is saved as a vault
 * attachment and an `![[embed]]` is inserted at the cursor (paste) or the drop
 * point. Anything that is not an image — text, in-app drags, mixed clipboards —
 * is left to CodeMirror's own handling by returning false.
 */
export function imageAttachmentHandlers(ctx: AttachmentHandlerContext) {
  async function attach(
    view: EditorView,
    files: AttachmentSource[],
    origin: AttachmentOrigin,
    from: number,
    to: number,
  ): Promise<void> {
    const sourcePath = ctx.sourcePath();
    let saved: TFile[];
    try {
      saved = await saveImageAttachments(ctx.vault, files, { sourcePath, origin });
    } catch (error) {
      ctx.notify(`Could not save the image: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (saved.length === 0) return;
    // The write is async; if the user moved to another note meanwhile, inserting
    // here would put an embed in the wrong document.
    if (!view.dom.isConnected || ctx.sourcePath() !== sourcePath) {
      ctx.notify(`Saved ${saved.map((file) => file.name).join(", ")}, but the note changed before it could be embedded`);
      return;
    }
    const insert = saved.map((file) => `![[${ctx.linktext(file, sourcePath)}]]`).join("\n");
    const length = view.state.doc.length;
    const start = Math.min(from, length);
    view.dispatch({
      changes: { from: start, to: Math.min(to, length), insert },
      selection: { anchor: start + insert.length },
      userEvent: origin === "paste" ? "input.paste" : "input.drop",
      scrollIntoView: true,
    });
    view.focus();
  }

  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!ctx.canEdit() || !ctx.sourcePath()) return false;
      const files = imageFilesFromPaste(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      const { from, to } = view.state.selection.main;
      void attach(view, files, "paste", from, to);
      return true;
    },
    dragover(event) {
      // A file drag must be cancelled for the browser to deliver `drop`.
      if (!ctx.canEdit() || !event.dataTransfer?.types.includes("Files")) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      if (!ctx.canEdit() || !ctx.sourcePath()) return false;
      const files = imageFilesFromDrop(event.dataTransfer);
      if (files.length === 0) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      void attach(view, files, "drop", at, at);
      return true;
    },
  });
}

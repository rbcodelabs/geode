import moment from "moment";
import type { EditorView } from "@codemirror/view";
import type { App } from "../../app";
import { Modal, SuggestModal } from "../../modals/modals";
import {
  combineNotes,
  composerLinkTarget,
  extractionReplacement,
  placementForKey,
  renderComposerTemplate,
  type ComposerPlacement,
} from "../../note-composer";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { renamePathForBasename, rewriteWikilinksForRename } from "../../rename";
import { templatePath } from "../../templates";
import { isTFile, type TAbstractFile, type TFile } from "../../types";
import type { MarkdownView } from "../../views/markdown-view";

export const NOTE_COMPOSER_PLUGIN_MANIFEST: PluginManifest = {
  id: "note-composer",
  name: "Note composer",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Merge notes or extract selections into other notes, keeping links intact.",
  author: "Geode",
};

/** Where the user wants the moved content to go: an existing note or a new note with a typed name. */
type ComposerTarget = { kind: "existing"; file: TFile; placement: "append" | "prepend" } | { kind: "new"; name: string };

const isMarkdown = (file: TFile): boolean => file.extension === "md";

/**
 * Note composer core plugin. Merge moves a whole note into another (or a new)
 * note, trashes the source and rewrites every link to it; Extract moves the
 * editor selection into another (or a new) note and leaves a link, embed or
 * nothing behind. Both go through the same target picker: Enter appends,
 * Shift+Enter prepends, Ctrl/Cmd+Enter creates a new note named by the query.
 */
export class NoteComposerPlugin extends GeodePlugin {
  constructor(app: App) {
    super(app, NOTE_COMPOSER_PLUGIN_MANIFEST);
  }

  onload(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: unknown) => {
        if (!isTFile(file as TAbstractFile) || !isMarkdown(file as TFile)) return;
        const source = file as TFile;
        menu.addItem((item: any) =>
          item.setTitle("Merge entire file with…").setIcon("git-merge").onClick(() => this.promptMerge(source))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: any, editor: EditorView, view: MarkdownView) => {
        if (!view?.file || editor.state.selection.main.empty) return;
        menu.addItem((item: any) =>
          item.setTitle("Extract current selection…").setIcon("file-output").onClick(() => this.promptExtract(view, editor))
        );
      })
    );

    this.addCommand({
      id: "merge-file",
      name: "Merge current file with another file…",
      checkCallback: (checking) => {
        const file = this.app.getActiveMarkdownView()?.file;
        if (!file || !isMarkdown(file)) return false;
        if (!checking) this.promptMerge(file);
        return true;
      },
    });
    this.addCommand({
      id: "extract-selection",
      name: "Extract current selection…",
      editorCheckCallback: (checking, editor, view) => {
        if (!view?.file || editor.state.selection.main.empty) return false;
        if (!checking) this.promptExtract(view, editor);
        return true;
      },
    });
  }

  // --- Merge -------------------------------------------------------------

  promptMerge(source: TFile): void {
    new ComposerTargetModal(this.app, {
      placeholder: "Select a note to merge into…",
      exclude: source,
      onChoose: (target) => {
        if (!this.app.noteComposer.options.askBeforeMerging) return void this.runMerge(source, target);
        new ConfirmMergeModal(this.app, source.basename, describeTarget(target), () => void this.runMerge(source, target)).open();
      },
    }).open();
  }

  private async runMerge(source: TFile, target: ComposerTarget): Promise<void> {
    const { vault } = this.app;
    try {
      const sourceText = await vault.read(source);
      const oldNoExt = source.path.replace(/\.md$/i, "");
      let destination: TFile;
      let linkTarget: string;
      let referencers: TFile[];
      if (target.kind === "new") {
        const path = this.newNotePath(source, target.name);
        linkTarget = target.name.trim();
        referencers = this.otherReferencers(source, null);
        const content = await this.newNoteContent(sourceText, source.basename, linkTarget);
        const rewritten = rewriteWikilinksForRename(content, source.basename, oldNoExt, source.path, linkTarget);
        destination = await vault.create(path, rewritten);
      } else {
        destination = target.file;
        linkTarget = composerLinkTarget(destination, vault.getMarkdownFiles().map((f) => f.path));
        referencers = this.otherReferencers(source, destination);
        const merged = combineNotes(await vault.read(destination), sourceText, target.placement);
        await vault.modify(destination, rewriteWikilinksForRename(merged, source.basename, oldNoExt, source.path, linkTarget));
      }
      for (const ref of referencers) {
        const text = await vault.read(ref);
        const updated = rewriteWikilinksForRename(text, source.basename, oldNoExt, source.path, linkTarget);
        if (updated !== text) await vault.modify(ref, updated);
      }
      await vault.trash(source);
      await this.app.openFile(destination, false);
      this.app.notify(`Merged "${source.basename}" into "${destination.basename}"`);
    } catch (error) {
      console.error("Note composer merge failed", error);
      this.app.notify(`Could not merge: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private otherReferencers(source: TFile, destination: TFile | null): TFile[] {
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const { source: ref } of this.app.metadataCache.getBacklinks(source)) {
      if (ref.path === source.path || ref.path === destination?.path || seen.has(ref.path)) continue;
      seen.add(ref.path);
      out.push(ref);
    }
    return out;
  }

  // --- Extract -----------------------------------------------------------

  promptExtract(view: MarkdownView, editor: EditorView): void {
    const source = view.file;
    const { from, to } = editor.state.selection.main;
    if (!source || from === to) return;
    const text = editor.state.doc.sliceString(from, to);
    new ComposerTargetModal(this.app, {
      placeholder: "Select a note to extract into…",
      exclude: source,
      onChoose: (target) => void this.runExtract(source, editor, { from, to, text }, target),
    }).open();
  }

  private async runExtract(
    source: TFile,
    editor: EditorView,
    selection: { from: number; to: number; text: string },
    target: ComposerTarget
  ): Promise<void> {
    const { vault } = this.app;
    try {
      let destination: TFile;
      if (target.kind === "new") {
        const content = await this.newNoteContent(selection.text, source.basename, target.name.trim());
        destination = await vault.create(this.newNotePath(source, target.name), content);
      } else {
        destination = target.file;
        await vault.modify(destination, combineNotes(await vault.read(destination), selection.text, target.placement));
      }
      // The picker can outlive an edit; only replace if the selection is still intact.
      if (editor.state.doc.sliceString(selection.from, selection.to) !== selection.text) {
        this.app.notify(`Extracted into "${destination.basename}", but the selection changed so the source was left as is.`);
        return;
      }
      const linkTarget = composerLinkTarget(destination, vault.getMarkdownFiles().map((f) => f.path));
      const insert = extractionReplacement(this.app.noteComposer.options.textAfterExtraction, linkTarget);
      editor.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length } });
      this.app.notify(`Extracted selection into "${destination.basename}"`);
    } catch (error) {
      console.error("Note composer extract failed", error);
      this.app.notify(`Could not extract: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- Shared ------------------------------------------------------------

  /** New notes land next to the source note. Throws if the name is invalid or taken. */
  private newNotePath(source: TFile, rawName: string): string {
    const path = renamePathForBasename(source.path, rawName.trim().replace(/\.md$/i, ""));
    if (!path.ok) throw new Error(path.error);
    if (this.app.vault.getAbstractFileByPath(path.path)) throw new Error(`A note named "${rawName.trim()}" already exists`);
    return path.path;
  }

  private async newNoteContent(content: string, fromTitle: string, newTitle: string): Promise<string> {
    const template = this.app.noteComposer.options.template;
    if (!template) return content.endsWith("\n") ? content : `${content}\n`;
    const file = this.app.vault.getAbstractFileByPath(templatePath(template));
    if (!isTFile(file)) throw new Error(`Template not found: ${templatePath(template)}`);
    return renderComposerTemplate(await this.app.vault.read(file), { content, fromTitle, newTitle, now: moment() });
  }
}

function describeTarget(target: ComposerTarget): string {
  return target.kind === "new" ? `a new note "${target.name}"` : `"${target.file.basename}"`;
}

/** Fuzzy picker over notes with the Enter / Shift+Enter / Ctrl-Cmd+Enter semantics. */
class ComposerTargetModal extends SuggestModal<TFile> {
  constructor(
    app: App,
    private readonly options: { placeholder: string; exclude: TFile; onChoose: (target: ComposerTarget) => void }
  ) {
    super(app);
    this.modalEl.classList.add("note-composer-picker");
    this.inputEl.placeholder = options.placeholder;
    this.inputEl.setAttribute("aria-label", options.placeholder);
    const hints = document.createElement("div");
    hints.className = "prompt-instructions";
    hints.textContent = "↵ append · shift ↵ prepend · ctrl/cmd ↵ create new note";
    this.modalEl.appendChild(hints);
    // Capture so a modifier+Enter creates a new note even while results are listed.
    this.inputEl.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.createNew();
      },
      true
    );
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => f.path !== this.options.exclude.path);
  }
  getItemText(file: TFile): string {
    return file.path.replace(/\.md$/i, "");
  }
  onChooseItem(file: TFile, evt: KeyboardEvent | MouseEvent): void {
    const placement: ComposerPlacement = placementForKey(evt);
    if (placement === "new") return this.createNewAfterClose();
    this.options.onChoose({ kind: "existing", file, placement });
  }

  private createNew(): void {
    const name = this.inputEl.value.trim();
    if (!name) return void this.app.notify("Type a name for the new note, then press Ctrl/Cmd+Enter");
    this.close();
    this.options.onChoose({ kind: "new", name });
  }
  private createNewAfterClose(): void {
    const name = this.inputEl.value.trim();
    if (!name) return void this.app.notify("Type a name for the new note, then press Ctrl/Cmd+Enter");
    this.options.onChoose({ kind: "new", name });
  }
}

class ConfirmMergeModal extends Modal {
  constructor(app: App, private readonly from: string, private readonly into: string, private readonly onConfirm: () => void) {
    super(app);
    this.modalEl.classList.add("note-composer-confirm");
  }

  onOpen(): void {
    const root = this.contentEl;
    const heading = document.createElement("h2");
    heading.textContent = "Merge notes";
    const body = document.createElement("p");
    body.textContent =
      `Merge "${this.from}" into ${this.into}? "${this.from}" will be moved to the system trash and links to it will be updated.`;
    const footer = document.createElement("div");
    footer.className = "note-composer-confirm-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const merge = document.createElement("button");
    merge.className = "mod-warning note-composer-confirm-merge";
    merge.textContent = "Merge";
    merge.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    footer.append(cancel, merge);
    root.append(heading, body, footer);
    merge.focus();
  }
}

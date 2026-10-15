/** Test-only browser entry. Never imported by a production bundle. */
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { NativePresentationPrototype, OccurrenceLedger, type NativeOccurrence } from "../../src/renderer/markdown/native-presentation-prototype";
import type { App } from "../../src/renderer/app";
import type { RenderScope } from "../../src/renderer/workspaces/render-ownership";

interface PrototypeWindow extends Window {
  app: App;
  nativeLayerHarness?: ReturnType<typeof mount>;
  mountNativeLayerPrototype?: typeof mount;
}
const global = window as unknown as PrototypeWindow;
function mount(source: string) {
  const app = global.app; const leaf = app.workspace.getActiveLeaf();
  if (!leaf?.view || !("renderOwner" in leaf.view)) throw new Error("A Markdown owner must already be connected.");
  const owner = leaf.view as typeof leaf.view & { renderOwner: RenderScope };
  const body = owner.containerEl.querySelector<HTMLElement>(".markdown-view-body")!;
  const original = [...body.children] as HTMLElement[]; const prior = original.map(el => el.style.display); const bodyPosition = body.style.position;
  const host = document.createElement("div"); host.className = "native-layer-prototype-host";
  Object.assign(host.style, { position: "absolute", inset: "0", overflow: "hidden" }); body.style.position = "relative";
  for (const element of original) element.style.display = "none";
  body.appendChild(host);
  const editorHost = document.createElement("div"); editorHost.style.height = "100%"; host.appendChild(editorHost);
  const ledger = new OccurrenceLedger(); let occurrences = ledger.reconcile(source).active; let editor: EditorView;
  let layer: NativePresentationPrototype; const native: CanvasView[] = []; let closes = 0; let connectedBeforeMount = true;
  const scope = owner.renderOwner.child({ close: async () => {
    layer.disposeProjection(); editor.destroy(); host.remove();
    original.forEach((el, index) => { el.style.display = prior[index]; }); body.style.position = bodyPosition;
  } });
  layer = new NativePresentationPrototype({ owner: scope, host, mount: async (content, parent, occurrence, token) => {
    connectedBeforeMount &&= content.isConnected;
    if (!content.isConnected) throw new Error("Native startup requires a connected presentation.");
    const canvas = new CanvasView(app, parent); native.push(canvas);
    // Observe the real destructor without changing its behavior or ownership.
    const internal = canvas.renderOwner as unknown as { options: { close(): Promise<void> } };
    const close = internal.options.close; internal.options.close = async () => { closes++; await close(); };
    canvas.markEmbedded(); content.appendChild(canvas.containerEl);
    Object.assign(canvas.containerEl.style, { width: "100%", height: "100%", flex: "1" });
    canvas.onOpen(); const file = app.vault.getFileByPath(occurrence.target); if (!file) throw new Error("Missing fixture Canvas.");
    await canvas.setFile(file); token.check(); canvas.markEmbedded();
  } });
  layer.reconcile(occurrences);
  class Placeholder extends WidgetType {
    private lease: object | null = null;
    constructor(private readonly occurrence: NativeOccurrence) { super(); }
    eq(other: Placeholder): boolean { return other.occurrence.id === this.occurrence.id; }
    get estimatedHeight(): number { return 320; }
    toDOM(): HTMLElement {
      const element = document.createElement("div"); element.className = "native-layer-placeholder";
      element.dataset.occurrence = String(this.occurrence.id); element.style.height = "320px";
      element.textContent = `Embedded ${this.occurrence.target}`;
      this.lease = layer.attachAnchor(this.occurrence.id, element); return element;
    }
    destroy(element: HTMLElement): void { if (this.lease) layer.releaseAnchor(this.occurrence.id, this.lease, element); }
  }
  const decorations = () => Decoration.set(occurrences.map(occurrence => Decoration.replace({ widget: new Placeholder(occurrence), block: true }).range(occurrence.from, occurrence.to)));
  const field = StateField.define<DecorationSet>({
    create: decorations,
    update(value, transaction) {
      if (!transaction.docChanged) return value;
      occurrences = ledger.reconcile(transaction.newDoc.toString(), transaction.changes).active; layer.reconcile(occurrences); return decorations();
    },
    provide: value => EditorView.decorations.from(value),
  });
  const extensions: Extension[] = [field, history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" }, ".cm-content": { padding: "12px 20px", minHeight: "100%" } }), EditorView.updateListener.of(() => layer.requestGeometry())];
  editor = new EditorView({ parent: editorHost, state: EditorState.create({ doc: source, extensions }) }); layer.setEditor(editor);
  const harness = {
    layer, editor, host, native, scope,
    snapshot: () => ({ layer: layer.snapshot(), connectedBeforeMount, closes, editorSource: editor.state.doc.toString(), ownerSource: "getText" in owner ? (owner as unknown as { getText(): string }).getText() : null, writers: scope.writers().map(writer => ({ type: (writer as CanvasView).viewType, path: (writer as CanvasView).getFile?.()?.path })) }),
    remove(id: number) { const occurrence = occurrences.find(item => item.id === id); if (occurrence) editor.dispatch({ changes: { from: occurrence.from, to: occurrence.to } }); },
    retarget(id: number, target: string) { const occurrence = occurrences.find(item => item.id === id); if (occurrence) editor.dispatch({ changes: { from: occurrence.from, to: occurrence.to, insert: `![[${target}]]` } }); },
    close: () => scope.close(), undo: () => undo(editor), redo: () => redo(editor),
  };
  global.nativeLayerHarness = harness; return harness;
}
global.mountNativeLayerPrototype = mount;

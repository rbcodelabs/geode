/**
 * Obsidian's `editorInfoField` and `editorLivePreviewField` CodeMirror state
 * fields. Plugins read them from an `EditorView.state` to learn which note and
 * leaf an editor belongs to, and whether it is in Live Preview.
 *
 * The values are fed by facets the host installs in the editor state: the
 * owning view (stable for the editor's life) and a Live Preview flag that lives
 * in the mode compartment, so a mode switch's reconfigure flips the field.
 * Without the host extensions installed (a plugin's own EditorState),
 * `state.field(field, false)` is undefined, as in Obsidian.
 */
import { Facet, StateField, type Extension } from "@codemirror/state";

const infoHostFacet = Facet.define<object, object | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

const livePreviewFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** The owning MarkdownView (has `file`, `leaf`, `getMode()`), or null. */
export const editorInfoField = StateField.define<object | null>({
  create: (state) => state.facet(infoHostFacet),
  update: (value, tr) => tr.state.facet(infoHostFacet) ?? value,
});

/** True while the editor is in Live Preview (not Source mode). */
export const editorLivePreviewField = StateField.define<boolean>({
  create: (state) => state.facet(livePreviewFacet),
  update: (_value, tr) => tr.state.facet(livePreviewFacet),
});

/** Install once per editor, outside the mode compartment. */
export function editorInfoExtension(host: object): Extension {
  return [infoHostFacet.of(host), editorInfoField, editorLivePreviewField];
}

/** Include in the editing compartment contents for Live Preview only. */
export function livePreviewFlagExtension(): Extension {
  return livePreviewFacet.of(true);
}

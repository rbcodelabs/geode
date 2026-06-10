import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { Extension, Range, RangeSet, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { App } from "../app";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** Length of doc prefix scanned for frontmatter. */
const FM_SCAN = 8192;

function frontmatterRange(docPrefix: string): { end: number; yaml: string } | null {
  const m = docPrefix.match(FM_RE);
  if (!m) return null;
  return { end: m[0].length - (m[2]?.length ?? 0), yaml: m[1] };
}

// --- Properties (frontmatter) widget ---------------------------------------

class PropertiesWidget extends WidgetType {
  constructor(
    private yamlText: string,
    private app: App
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    return other.yamlText === this.yamlText;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "metadata-properties";
    let obj: Record<string, unknown> = {};
    try {
      const parsed = parseYaml(this.yamlText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      root.classList.add("has-invalid-yaml");
    }

    const heading = document.createElement("div");
    heading.className = "metadata-properties-heading";
    heading.textContent = "Properties";
    root.appendChild(heading);

    const commit = () => writeFrontmatter(view, obj);

    for (const [key, value] of Object.entries(obj)) {
      root.appendChild(this.renderRow(key, value, obj, commit));
    }

    // "Add property" row
    const addRow = document.createElement("div");
    addRow.className = "metadata-add-button";
    addRow.textContent = "+ Add property";
    addRow.addEventListener("click", () => {
      addRow.replaceWith(this.renderNewRow(obj, commit));
    });
    root.appendChild(addRow);
    return root;
  }

  private typeIcon(value: unknown): string {
    if (Array.isArray(value)) return "≡";
    if (typeof value === "boolean") return "☑";
    if (typeof value === "number") return "#";
    return "Aa";
  }

  private renderRow(
    key: string,
    value: unknown,
    obj: Record<string, unknown>,
    commit: () => void
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "metadata-property";

    const keyEl = document.createElement("div");
    keyEl.className = "metadata-property-key";
    keyEl.innerHTML = `<span class="metadata-property-icon">${this.typeIcon(value)}</span>`;
    const keyInput = document.createElement("input");
    keyInput.className = "metadata-input metadata-key-input";
    keyInput.value = key;
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") keyInput.blur();
    });
    keyInput.addEventListener("blur", () => {
      const newKey = keyInput.value.trim();
      if (!newKey || newKey === key) {
        keyInput.value = key;
        return;
      }
      // Preserve property order while renaming.
      const entries = Object.entries(obj).map(([k, v]) => (k === key ? [newKey, v] : [k, v]));
      for (const k of Object.keys(obj)) delete obj[k];
      for (const [k, v] of entries) obj[k as string] = v;
      commit();
    });
    keyEl.appendChild(keyInput);

    const valueEl = document.createElement("div");
    valueEl.className = "metadata-property-value";
    valueEl.appendChild(this.renderValueInput(key, value, obj, commit));

    const removeBtn = document.createElement("div");
    removeBtn.className = "metadata-property-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove property";
    removeBtn.addEventListener("click", () => {
      delete obj[key];
      commit();
    });

    row.appendChild(keyEl);
    row.appendChild(valueEl);
    row.appendChild(removeBtn);
    return row;
  }

  private renderValueInput(
    key: string,
    value: unknown,
    obj: Record<string, unknown>,
    commit: () => void
  ): HTMLElement {
    if (typeof value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.addEventListener("change", () => {
        obj[key] = input.checked;
        commit();
      });
      return input;
    }
    const input = document.createElement("input");
    input.className = "metadata-input";
    if (Array.isArray(value)) {
      input.value = value.map(String).join(", ");
      input.placeholder = "comma, separated, values";
    } else if (typeof value === "number") {
      input.type = "number";
      input.value = String(value);
    } else {
      input.value = value == null ? "" : String(value);
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      let next: unknown = input.value;
      if (Array.isArray(value)) {
        next = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (typeof value === "number") {
        const n = Number(input.value);
        next = Number.isFinite(n) ? n : input.value;
      }
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      obj[key] = next;
      commit();
    });
    return input;
  }

  private renderNewRow(obj: Record<string, unknown>, commit: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "metadata-property is-new";
    const keyInput = document.createElement("input");
    keyInput.className = "metadata-input metadata-key-input";
    keyInput.placeholder = "name";
    const valInput = document.createElement("input");
    valInput.className = "metadata-input";
    valInput.placeholder = "value";
    const save = () => {
      const k = keyInput.value.trim();
      if (!k) return;
      let v: unknown = valInput.value;
      if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (v !== "" && !Number.isNaN(Number(v))) v = Number(v);
      obj[k] = v;
      commit();
    };
    for (const input of [keyInput, valInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
    }
    valInput.addEventListener("blur", () => window.setTimeout(save, 100));
    row.appendChild(keyInput);
    row.appendChild(valInput);
    window.setTimeout(() => keyInput.focus(), 0);
    return row;
  }
}

function writeFrontmatter(view: EditorView, obj: Record<string, unknown>) {
  const prefix = view.state.doc.sliceString(0, Math.min(view.state.doc.length, FM_SCAN));
  const fm = frontmatterRange(prefix);
  const hasProps = Object.keys(obj).length > 0;
  const insert = hasProps ? `---\n${stringifyYaml(obj)}---` : "";
  if (fm) {
    // When removing the last property also swallow the trailing newline.
    const to = hasProps ? fm.end : Math.min(view.state.doc.length, fm.end + 1);
    view.dispatch({ changes: { from: 0, to, insert } });
  } else if (hasProps) {
    view.dispatch({ changes: { from: 0, to: 0, insert: insert + "\n" } });
  }
}

// --- Inline widgets ---------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private pos: number
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HRWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-hr-widget";
    el.innerHTML = "<hr>";
    return el;
  }
}

// --- Live preview extension -------------------------------------------------

export function livePreview(app: App, getPath: () => string): Extension {
  const hide = Decoration.replace({});

  const frontmatterField = StateField.define<DecorationSet>({
    create(state) {
      return computeFrontmatter(state.doc.sliceString(0, Math.min(state.doc.length, FM_SCAN)));
    },
    update(value, tr) {
      if (!tr.docChanged) return value;
      return computeFrontmatter(
        tr.state.doc.sliceString(0, Math.min(tr.state.doc.length, FM_SCAN))
      );
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function computeFrontmatter(prefix: string): DecorationSet {
    const fm = frontmatterRange(prefix);
    if (!fm) return Decoration.none;
    return Decoration.set([
      Decoration.replace({ widget: new PropertiesWidget(fm.yaml, app), block: true }).range(
        0,
        fm.end
      ),
    ]);
  }

  function buildInline(view: EditorView): DecorationSet {
    const decos: Range<Decoration>[] = [];
    const doc = view.state.doc;
    const active = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const from = doc.lineAt(r.from).number;
      const to = doc.lineAt(r.to).number;
      for (let i = from; i <= to; i++) active.add(i);
    }
    const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, FM_SCAN)));
    const fmEnd = fm?.end ?? 0;
    const isActive = (pos: number) => active.has(doc.lineAt(pos).number);

    const listMarks: { line: number; from: number; to: number }[] = [];
    const taskLines = new Set<number>();

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter(node) {
          if (node.from < fmEnd) return;
          switch (node.name) {
            case "HeaderMark": {
              if (!node.node.parent?.name.startsWith("ATXHeading")) break;
              if (isActive(node.from)) break;
              const after = doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, after === " " ? node.to + 1 : node.to));
              break;
            }
            case "EmphasisMark":
            case "CodeMark":
            case "StrikethroughMark": {
              if (!isActive(node.from)) decos.push(hide.range(node.from, node.to));
              break;
            }
            case "QuoteMark": {
              const line = doc.lineAt(node.from);
              decos.push(Decoration.line({ class: "cm-live-quote" }).range(line.from));
              if (!isActive(node.from)) {
                const after = doc.sliceString(node.to, node.to + 1);
                decos.push(hide.range(node.from, after === " " ? node.to + 1 : node.to));
              }
              break;
            }
            case "ListMark": {
              listMarks.push({ line: doc.lineAt(node.from).number, from: node.from, to: node.to });
              break;
            }
            case "TaskMarker": {
              const lineNo = doc.lineAt(node.from).number;
              taskLines.add(lineNo);
              if (!isActive(node.from)) {
                const checked = doc.sliceString(node.from, node.to).toLowerCase() !== "[ ]";
                decos.push(
                  Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(
                    node.from,
                    node.to
                  )
                );
              }
              break;
            }
            case "Link": {
              if (isActive(node.from)) break;
              const marks = node.node.getChildren("LinkMark");
              const url = node.node.getChild("URL");
              if (marks.length < 2 || !url) break;
              const href = doc.sliceString(url.from, url.to);
              const labelFrom = marks[0].to;
              const labelTo = marks[1].from;
              if (labelTo > labelFrom) {
                decos.push(
                  Decoration.mark({
                    class: "cm-live-extlink",
                    attributes: { "data-href": href },
                  }).range(labelFrom, labelTo)
                );
              }
              for (const mark of marks) decos.push(hide.range(mark.from, mark.to));
              decos.push(hide.range(url.from, url.to));
              break;
            }
            case "FencedCode": {
              const first = doc.lineAt(node.from).number;
              const last = doc.lineAt(Math.min(node.to, doc.length)).number;
              for (let i = first; i <= last; i++) {
                decos.push(Decoration.line({ class: "cm-live-codeblock" }).range(doc.line(i).from));
              }
              break;
            }
            case "HorizontalRule": {
              if (!isActive(node.from)) {
                decos.push(
                  Decoration.replace({ widget: new HRWidget() }).range(node.from, node.to)
                );
              }
              break;
            }
          }
        },
      });

      // Regex passes for syntax lezer doesn't model: wikilinks and highlights.
      const firstLine = doc.lineAt(from).number;
      const lastLine = doc.lineAt(to).number;
      for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
        if (active.has(lineNo)) continue;
        const line = doc.line(lineNo);
        if (line.from < fmEnd) continue;
        const text = line.text;

        for (const m of text.matchAll(/(!?)\[\[([^\[\]\n]+)\]\]/g)) {
          if (m[1] === "!") continue; // embeds keep raw syntax for now
          const start = line.from + m.index!;
          const inner = m[2];
          const pipe = inner.indexOf("|");
          const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
          const innerStart = start + 2;
          const displayFrom = pipe === -1 ? innerStart : innerStart + pipe + 1;
          const displayTo = start + 2 + inner.length;
          decos.push(hide.range(start, displayFrom));
          if (displayTo > displayFrom) {
            decos.push(
              Decoration.mark({
                class: "cm-live-wikilink",
                attributes: { "data-href": target },
              }).range(displayFrom, displayTo)
            );
          }
          decos.push(hide.range(displayTo, start + m[0].length));
        }

        for (const m of text.matchAll(/==([^=\n]+?)==/g)) {
          const start = line.from + m.index!;
          decos.push(hide.range(start, start + 2));
          decos.push(
            Decoration.mark({ class: "cm-live-highlight" }).range(
              start + 2,
              start + m[0].length - 2
            )
          );
          decos.push(hide.range(start + m[0].length - 2, start + m[0].length));
        }
      }
    }

    // Hide the "- " bullet on task lines so only the checkbox shows.
    for (const mark of listMarks) {
      if (taskLines.has(mark.line) && !active.has(mark.line)) {
        const after = doc.sliceString(mark.to, mark.to + 1);
        decos.push(hide.range(mark.from, after === " " ? mark.to + 1 : mark.to));
      }
    }

    return Decoration.set(decos, true);
  }

  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildInline(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildInline(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, _view) {
      const target = e.target as HTMLElement;
      const wikilink = target.closest(".cm-live-wikilink") as HTMLElement | null;
      if (wikilink?.dataset.href) {
        e.preventDefault();
        app.openLink(wikilink.dataset.href, getPath(), e.metaKey || e.ctrlKey);
        return true;
      }
      const extlink = target.closest(".cm-live-extlink") as HTMLElement | null;
      if (extlink?.dataset.href) {
        e.preventDefault();
        window.geode.openExternal(extlink.dataset.href);
        return true;
      }
      return false;
    },
  });

  return [
    frontmatterField,
    EditorView.atomicRanges.of(
      (view) => view.state.field(frontmatterField, false) ?? RangeSet.empty
    ),
    inlinePlugin,
    clickHandler,
  ];
}

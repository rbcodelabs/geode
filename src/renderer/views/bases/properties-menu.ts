import type { App } from "../../app";
import { PromptModal } from "../../modals/modals";
import { openPanel, type Panel } from "./panel";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface PropertiesMenuOpts {
  /** Currently visible columns, in display order. */
  visibleColumns: string[];
  /** Known columns not currently visible (offered as "show" candidates). */
  hiddenColumns: string[];
  onReorder(next: string[]): void;
  onHide(path: string): void;
  onShow(path: string): void;
  /** Author a new named formula (`BaseDefinition.formulas`) and add it as a column — the spec's "new formula" entry point. */
  onNewFormula(name: string, expression: string): void;
}

/**
 * Properties toolbar panel: show/hide + reorder columns, plus a "new
 * formula" entry point. Full formula authoring (autocomplete, live preview)
 * is out of scope for this phase — a two-step name+expression prompt is
 * explicitly sufficient per the spec.
 */
export function openPropertiesMenu(anchorEl: HTMLElement, app: App, opts: PropertiesMenuOpts): Panel {
  return openPanel(
    anchorEl,
    (panel) => {
      const rerender = () => {
        panel.el.innerHTML = "";
        panel.el.appendChild(el("div", "bases-panel-title", "Properties"));

        const visibleList = el("div", "bases-properties-list");
        opts.visibleColumns.forEach((path, i) => {
          const row = el("div", "bases-properties-row");
          const checkbox = el("input") as HTMLInputElement;
          checkbox.type = "checkbox";
          checkbox.checked = true;
          checkbox.addEventListener("change", () => {
            opts.onHide(path);
            rerender();
          });
          const label = el("span", "bases-properties-label", path);
          const upBtn = el("button", "clickable-icon bases-sort-move", "▲");
          upBtn.disabled = i === 0;
          upBtn.addEventListener("click", () => {
            const next = opts.visibleColumns.slice();
            [next[i - 1], next[i]] = [next[i], next[i - 1]];
            opts.onReorder(next);
            rerender();
          });
          const downBtn = el("button", "clickable-icon bases-sort-move", "▼");
          downBtn.disabled = i === opts.visibleColumns.length - 1;
          downBtn.addEventListener("click", () => {
            const next = opts.visibleColumns.slice();
            [next[i + 1], next[i]] = [next[i], next[i + 1]];
            opts.onReorder(next);
            rerender();
          });
          row.append(checkbox, label, upBtn, downBtn);
          visibleList.appendChild(row);
        });
        panel.el.appendChild(visibleList);

        if (opts.hiddenColumns.length) {
          panel.el.appendChild(el("div", "bases-panel-subtitle", "Hidden"));
          const hiddenList = el("div", "bases-properties-list");
          for (const path of opts.hiddenColumns) {
            const row = el("div", "bases-properties-row");
            const checkbox = el("input") as HTMLInputElement;
            checkbox.type = "checkbox";
            checkbox.checked = false;
            checkbox.addEventListener("change", () => {
              opts.onShow(path);
              rerender();
            });
            row.append(checkbox, el("span", "bases-properties-label", path));
            hiddenList.appendChild(row);
          }
          panel.el.appendChild(hiddenList);
        }

        const newFormulaBtn = el("button", "bases-filter-add", "+ New formula");
        newFormulaBtn.addEventListener("click", () => {
          new PromptModal(app, {
            placeholder: "Formula name",
            onSubmit: (name) => {
              new PromptModal(app, {
                placeholder: "Expression, e.g. note.price * note.qty",
                onSubmit: (expression) => opts.onNewFormula(name, expression),
              }).open();
            },
          }).open();
        });
        panel.el.appendChild(newFormulaBtn);
      };

      rerender();
    },
    "bases-properties-panel"
  );
}

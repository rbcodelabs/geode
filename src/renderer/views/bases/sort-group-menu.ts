import { openPanel, type Panel } from "./panel";

export interface SortSpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface GroupBySpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface SortGroupValue {
  sort: SortSpec[];
  groupBy: GroupBySpec | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function propertySelect(properties: string[], selected: string): HTMLSelectElement {
  const select = el("select", "bases-sort-prop") as HTMLSelectElement;
  for (const p of properties) {
    const opt = el("option", undefined, p) as HTMLOptionElement;
    opt.value = p;
    if (p === selected) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

/**
 * Sort & group-by editor panel — a single ordered list of sort rows
 * (add/remove/reorder/direction) plus a single group-by picker, per the
 * spec's "Sort and group" section. Calls `onChange` with the full next
 * value on every edit; the caller (BaseView) owns persisting it.
 */
export function openSortGroupMenu(
  anchorEl: HTMLElement,
  initial: SortGroupValue,
  properties: string[],
  onChange: (next: SortGroupValue) => void
): Panel {
  let value: SortGroupValue = { sort: initial.sort.slice(), groupBy: initial.groupBy };

  return openPanel(
    anchorEl,
    (panel) => {
      const rerender = () => {
        panel.el.innerHTML = "";

        panel.el.appendChild(el("div", "bases-panel-title", "Sort"));
        const sortList = el("div", "bases-sort-list");
        value.sort.forEach((spec, i) => {
          const row = el("div", "bases-sort-row");
          const select = propertySelect(properties, spec.property);
          select.addEventListener("change", () => {
            value.sort[i] = { ...spec, property: select.value };
            onChange(value);
          });
          const dirBtn = el("button", "bases-sort-dir", spec.direction === "ASC" ? "↑ ASC" : "↓ DESC");
          dirBtn.addEventListener("click", () => {
            value.sort[i] = { ...spec, direction: spec.direction === "ASC" ? "DESC" : "ASC" };
            onChange(value);
            rerender();
          });
          const upBtn = el("button", "clickable-icon bases-sort-move", "▲");
          upBtn.disabled = i === 0;
          upBtn.addEventListener("click", () => {
            [value.sort[i - 1], value.sort[i]] = [value.sort[i], value.sort[i - 1]];
            onChange(value);
            rerender();
          });
          const downBtn = el("button", "clickable-icon bases-sort-move", "▼");
          downBtn.disabled = i === value.sort.length - 1;
          downBtn.addEventListener("click", () => {
            [value.sort[i + 1], value.sort[i]] = [value.sort[i], value.sort[i + 1]];
            onChange(value);
            rerender();
          });
          const removeBtn = el("button", "clickable-icon bases-filter-remove", "×");
          removeBtn.addEventListener("click", () => {
            value.sort.splice(i, 1);
            onChange(value);
            rerender();
          });
          row.append(select, dirBtn, upBtn, downBtn, removeBtn);
          sortList.appendChild(row);
        });
        panel.el.appendChild(sortList);

        const addBtn = el("button", "bases-filter-add", "+ Add sort");
        addBtn.disabled = properties.length === 0;
        addBtn.addEventListener("click", () => {
          value.sort.push({ property: properties[0] ?? "file.name", direction: "ASC" });
          onChange(value);
          rerender();
        });
        panel.el.appendChild(addBtn);

        panel.el.appendChild(el("div", "bases-panel-title", "Group by"));
        const groupRow = el("div", "bases-sort-row");
        const groupSelect = el("select", "bases-sort-prop") as HTMLSelectElement;
        const noneOpt = el("option", undefined, "(none)") as HTMLOptionElement;
        noneOpt.value = "";
        if (!value.groupBy) noneOpt.selected = true;
        groupSelect.appendChild(noneOpt);
        for (const p of properties) {
          const opt = el("option", undefined, p) as HTMLOptionElement;
          opt.value = p;
          if (value.groupBy?.property === p) opt.selected = true;
          groupSelect.appendChild(opt);
        }
        groupSelect.addEventListener("change", () => {
          value.groupBy = groupSelect.value ? { property: groupSelect.value, direction: value.groupBy?.direction ?? "ASC" } : null;
          onChange(value);
          rerender();
        });
        groupRow.appendChild(groupSelect);
        if (value.groupBy) {
          const dirBtn = el("button", "bases-sort-dir", value.groupBy.direction === "ASC" ? "↑ ASC" : "↓ DESC");
          dirBtn.addEventListener("click", () => {
            value.groupBy = { ...value.groupBy!, direction: value.groupBy!.direction === "ASC" ? "DESC" : "ASC" };
            onChange(value);
            rerender();
          });
          groupRow.appendChild(dirBtn);
        }
        panel.el.appendChild(groupRow);
      };

      rerender();
    },
    "bases-sort-panel"
  );
}

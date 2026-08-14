import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  emptyCondition,
  emptyGroup,
  FILTER_OPERATORS,
  FilterConjunction,
  FilterGroup,
  groupToNode,
  operatorTakesValue,
  parseNodeToGroup,
  type FilterCondition,
  type FilterOperator,
} from "../../bases/filter-groups";
import { openPanel, type Panel } from "./panel";

export interface FilterEditorScope {
  /** "All views" (base-wide) or "This view" (view-level) — the two scopes the spec's Filter panel exposes. */
  label: string;
  /** Current raw YAML filter node (`BaseDefinition.filters`/`BaseViewDefinition.filters`), or undefined if none set. */
  node: unknown;
  /** Called whenever the user changes this scope's filters; `undefined` means "no filters" (clears the key entirely). */
  onChange(node: unknown | undefined): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Per-scope editor mode: "visual" (GUI rows) or "code" (raw YAML text) — the spec's "code button" toggle. */
interface ScopeState {
  mode: "visual" | "code";
  group: FilterGroup;
  codeText: string;
  codeError: string | null;
}

function initialState(node: unknown): ScopeState {
  if (node === undefined) return { mode: "visual", group: emptyGroup("and"), codeText: "", codeError: null };
  const group = parseNodeToGroup(node);
  if (group) return { mode: "visual", group, codeText: "", codeError: null };
  return { mode: "code", group: emptyGroup("and"), codeText: stringifyYaml(node), codeError: null };
}

/** A path of child indices from a scope's root group down to one item (e.g. `[1, 0]` = the root's 2nd child's 1st child). Stable across non-structural edits, since those never reorder/add/remove items. */
type ItemPath = number[];

/** Replace the item at `path` (relative to `root`) via `mutate`, rebuilding only the ancestor chain (structural sharing for everything else). */
function updateAtPath(root: FilterGroup, path: ItemPath, mutate: (group: FilterGroup, index: number) => FilterGroup["children"][number]): FilterGroup {
  if (path.length === 0) throw new Error("updateAtPath: empty path");
  const [index, ...rest] = path;
  const children = root.children.slice();
  if (rest.length === 0) {
    children[index] = mutate(root, index);
  } else {
    const child = children[index];
    if (child.kind !== "group") throw new Error("updateAtPath: intermediate path segment is not a group");
    children[index] = updateAtPath(child, rest, mutate);
  }
  return { ...root, children };
}

function patchCondition(root: FilterGroup, path: ItemPath, patch: Partial<FilterCondition>): FilterGroup {
  return updateAtPath(root, path, (group, index) => {
    const child = group.children[index];
    return child.kind === "condition" ? { ...child, ...patch } : child;
  });
}

function setConjunction(root: FilterGroup, path: ItemPath, conjunction: FilterConjunction): FilterGroup {
  if (path.length === 0) return { ...root, conjunction };
  return updateAtPath(root, path, (group, index) => {
    const child = group.children[index];
    return child.kind === "group" ? { ...child, conjunction } : child;
  });
}

function removeAtPath(root: FilterGroup, path: ItemPath): FilterGroup {
  if (path.length === 1) {
    const children = root.children.slice();
    children.splice(path[0], 1);
    return { ...root, children };
  }
  const [index, ...rest] = path;
  const children = root.children.slice();
  const child = children[index];
  if (child.kind !== "group") return root;
  children[index] = removeAtPath(child, rest);
  return { ...root, children };
}

function addChild(root: FilterGroup, path: ItemPath, item: FilterGroup["children"][number]): FilterGroup {
  if (path.length === 0) return { ...root, children: [...root.children, item] };
  return updateAtPath(root, path, (group, index) => {
    const child = group.children[index];
    if (child.kind !== "group") return child;
    return { ...child, children: [...child.children, item] };
  });
}

function renderCondition(
  cond: FilterCondition,
  path: ItemPath,
  onPatch: (path: ItemPath, patch: Partial<FilterCondition>) => void,
  onRemove: (path: ItemPath) => void
): HTMLElement {
  const row = el("div", "bases-filter-row");

  const propInput = el("input", "bases-filter-prop") as HTMLInputElement;
  propInput.type = "text";
  propInput.placeholder = "property";
  propInput.value = cond.property;
  propInput.setAttribute("list", "bases-known-properties");
  propInput.addEventListener("change", () => onPatch(path, { property: propInput.value }));

  const opSelect = el("select", "bases-filter-op") as HTMLSelectElement;
  for (const op of FILTER_OPERATORS) {
    const opt = el("option", undefined, op) as HTMLOptionElement;
    opt.value = op;
    if (op === cond.operator) opt.selected = true;
    opSelect.appendChild(opt);
  }
  opSelect.addEventListener("change", () => onPatch(path, { operator: opSelect.value as FilterOperator }));

  const valueInput = el("input", "bases-filter-value") as HTMLInputElement;
  valueInput.type = "text";
  valueInput.placeholder = "value";
  valueInput.value = cond.value;
  valueInput.disabled = !operatorTakesValue(cond.operator);
  valueInput.addEventListener("change", () => onPatch(path, { value: valueInput.value }));

  const removeBtn = el("button", "clickable-icon bases-filter-remove", "×");
  removeBtn.title = "Remove condition";
  removeBtn.addEventListener("click", () => onRemove(path));

  row.append(propInput, opSelect, valueInput, removeBtn);
  return row;
}

interface GroupHandlers {
  onPatch(path: ItemPath, patch: Partial<FilterCondition>): void;
  onConjunctionChange(path: ItemPath, conjunction: FilterConjunction): void;
  onRemove(path: ItemPath): void;
  onAddCondition(path: ItemPath): void;
  onAddGroup(path: ItemPath): void;
}

function renderGroup(group: FilterGroup, path: ItemPath, handlers: GroupHandlers, canRemove: boolean): HTMLElement {
  const wrap = el("div", "bases-filter-group");

  const header = el("div", "bases-filter-group-header");
  const conjSelect = el("select", "bases-filter-conjunction") as HTMLSelectElement;
  const labels: Record<FilterConjunction, string> = {
    and: "All the following are true",
    or: "Any of the following are true",
    not: "None of the following are true",
  };
  (["and", "or", "not"] as const).forEach((c) => {
    const opt = el("option", undefined, labels[c]) as HTMLOptionElement;
    opt.value = c;
    if (c === group.conjunction) opt.selected = true;
    conjSelect.appendChild(opt);
  });
  conjSelect.addEventListener("change", () => handlers.onConjunctionChange(path, conjSelect.value as FilterConjunction));
  header.appendChild(conjSelect);
  if (canRemove) {
    const removeGroupBtn = el("button", "clickable-icon bases-filter-remove", "×");
    removeGroupBtn.title = "Remove group";
    removeGroupBtn.addEventListener("click", () => handlers.onRemove(path));
    header.appendChild(removeGroupBtn);
  }
  wrap.appendChild(header);

  const childrenEl = el("div", "bases-filter-children");
  group.children.forEach((item, i) => {
    const childPath = [...path, i];
    if (item.kind === "condition") {
      childrenEl.appendChild(renderCondition(item, childPath, handlers.onPatch, handlers.onRemove));
    } else {
      childrenEl.appendChild(renderGroup(item, childPath, handlers, true));
    }
  });
  wrap.appendChild(childrenEl);

  const actions = el("div", "bases-filter-group-actions");
  const addConditionBtn = el("button", "bases-filter-add", "+ Condition");
  addConditionBtn.addEventListener("click", () => handlers.onAddCondition(path));
  const addGroupBtn = el("button", "bases-filter-add", "+ Group");
  addGroupBtn.addEventListener("click", () => handlers.onAddGroup(path));
  actions.append(addConditionBtn, addGroupBtn);
  wrap.appendChild(actions);

  return wrap;
}

function renderScope(scope: FilterEditorScope, rerender: () => void): HTMLElement {
  const state = scopeStates.get(scope) ?? initialState(scope.node);
  scopeStates.set(scope, state);

  const section = el("div", "bases-filter-scope");
  const header = el("div", "bases-filter-scope-header");
  header.appendChild(el("span", "bases-filter-scope-title", scope.label));
  const codeToggle = el("button", "clickable-icon bases-filter-code-toggle", "</>");
  codeToggle.title = "Toggle raw filter text";
  codeToggle.classList.toggle("is-active", state.mode === "code");
  codeToggle.addEventListener("click", () => {
    if (state.mode === "visual") {
      state.codeText = stringifyYaml(groupToNode(state.group));
      state.mode = "code";
    } else {
      const parsed = tryParseYaml(state.codeText);
      if (parsed !== undefined) {
        const group = parseNodeToGroup(parsed);
        if (group) {
          state.group = group;
          state.mode = "visual";
          state.codeError = null;
        } else {
          state.codeError = "Couldn't map this filter to the visual editor — staying in code mode.";
        }
      }
    }
    rerender();
  });
  header.appendChild(codeToggle);
  section.appendChild(header);

  if (state.mode === "code") {
    const textarea = el("textarea", "bases-filter-code") as HTMLTextAreaElement;
    textarea.value = state.codeText;
    textarea.placeholder = "and:\n  - note.status == \"Done\"";
    textarea.addEventListener("change", () => {
      state.codeText = textarea.value;
      const parsed = tryParseYaml(textarea.value);
      if (parsed === undefined && textarea.value.trim() !== "") {
        state.codeError = "Invalid YAML";
        rerender();
        return;
      }
      state.codeError = null;
      scope.onChange(textarea.value.trim() === "" ? undefined : parsed);
    });
    section.appendChild(textarea);
    if (state.codeError) section.appendChild(el("div", "bases-filter-error", state.codeError));
  } else {
    // Non-structural edits (a field's text/select value) commit into `state.group` — always the
    // current, authoritative tree — and skip the DOM rebuild. Structural edits (add/remove/
    // reorder/conjunction) both commit and rebuild, since the panel's shape actually changed.
    const commit = (next: FilterGroup, structural: boolean) => {
      state.group = next;
      scope.onChange(next.children.length ? groupToNode(next) : undefined);
      if (structural) rerender();
    };
    const handlers: GroupHandlers = {
      onPatch: (path, patch) => commit(patchCondition(state.group, path, patch), false),
      onConjunctionChange: (path, conjunction) => commit(setConjunction(state.group, path, conjunction), true),
      onRemove: (path) => commit(removeAtPath(state.group, path), true),
      onAddCondition: (path) => commit(addChild(state.group, path, emptyCondition()), true),
      onAddGroup: (path) => commit(addChild(state.group, path, emptyGroup("and")), true),
    };
    section.appendChild(renderGroup(state.group, [], handlers, false));
  }

  return section;
}

function tryParseYaml(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/** Per-scope-object visual/code editor state, kept for the panel's lifetime (module-level `WeakMap` keyed by the caller's scope objects, cleared implicitly when the panel closes and the scopes are discarded). */
const scopeStates = new WeakMap<FilterEditorScope, ScopeState>();

export function openFilterEditor(anchorEl: HTMLElement, scopes: FilterEditorScope[], knownProperties: string[]): Panel {
  const datalist = document.getElementById("bases-known-properties") ?? document.createElement("datalist");
  datalist.id = "bases-known-properties";
  datalist.innerHTML = "";
  for (const p of knownProperties) {
    const opt = document.createElement("option");
    opt.value = p;
    datalist.appendChild(opt);
  }
  if (!datalist.parentElement) document.body.appendChild(datalist);

  return openPanel(
    anchorEl,
    (panel) => {
      const rerender = () => {
        panel.el.innerHTML = "";
        for (const scope of scopes) panel.el.appendChild(renderScope(scope, rerender));
      };
      for (const scope of scopes) panel.el.appendChild(renderScope(scope, rerender));
    },
    "bases-filter-panel"
  );
}

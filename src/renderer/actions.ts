import type { Command } from "./commands";

export type ActionValue<TContext, TValue> = TValue | ((context: TContext) => TValue);

export interface ActionDefinition<TContext> {
  id: string;
  label: ActionValue<TContext, string>;
  icon?: ActionValue<TContext, string | null>;
  checked?: (context: TContext) => boolean;
  warning?: boolean;
  isAvailable?: (context: TContext) => boolean;
  run: (context: TContext) => void | Promise<void>;
}

export interface ResolvedAction<TContext> {
  id: string;
  label: string;
  icon: string | null;
  checked: boolean;
  warning: boolean;
  available: boolean;
  run: () => void | Promise<void>;
}

const value = <TContext, TValue>(input: ActionValue<TContext, TValue> | undefined, context: TContext, fallback: TValue): TValue =>
  input === undefined ? fallback : typeof input === "function" ? (input as (context: TContext) => TValue)(context) : input;

/** Geode-internal contextual behavior registry. This is deliberately not re-exported through the Obsidian API. */
export class ActionRegistry<TContext> {
  private definitions = new Map<string, ActionDefinition<TContext>>();

  register(definition: ActionDefinition<TContext>): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * Resolve an action's presentation and availability against a context.
   *
   * `label`, `icon` and `checked` are evaluated BEFORE `available` and are
   * returned alongside it. Two consequences worth stating out loud:
   *
   * 1. **Dynamic callbacks must be total.** A `label` that dereferences a
   *    field only some contexts carry throws for every caller that enumerates
   *    actions, including `commands.list()` (which polls availability across
   *    every command to build the palette) and every context menu. Write them
   *    defensively: `(c) => c.thing?.label ?? "Fallback"`.
   * 2. **Do not "fix" (1) by short-circuiting when unavailable.** Menu specs
   *    can pass `includeUnavailable`, and those greyed-out items still need
   *    real labels rather than the id fallback.
   */
  resolve(id: string, context: TContext): ResolvedAction<TContext> | null {
    const definition = this.definitions.get(id);
    if (!definition) return null;
    return {
      id,
      label: value(definition.label, context, id),
      icon: value(definition.icon, context, null),
      checked: definition.checked?.(context) ?? false,
      warning: definition.warning ?? false,
      available: definition.isAvailable?.(context) ?? true,
      run: () => definition.run(context),
    };
  }

  async execute(id: string, context: TContext): Promise<boolean> {
    const action = this.resolve(id, context);
    if (!action?.available) return false;
    await action.run();
    return true;
  }
}

export interface MenuSection {
  section: string;
  actions: string[];
  includeUnavailable?: boolean;
}

export const DOCUMENT_MENU_SPEC: MenuSection[] = [
  { section: "open", actions: ["file.open-new-tab"] },
  { section: "bookmark", actions: ["resource.bookmark"] },
  { section: "file", actions: ["resource.rename", "resource.delete"] },
];

export const TAB_MENU_SPEC: MenuSection[] = [
  // Placed first rather than appended. On a web tab every DOCUMENT_MENU_SPEC
  // section collapses (there is no file) while the tab section below renders
  // four items unconditionally, so appending would bury Reload at the bottom
  // of the menu. No `includeUnavailable`: on a markdown tab this section
  // filters out entirely, leaving the existing menu text untouched.
  { section: "web", actions: ["web.reload"] },
  ...DOCUMENT_MENU_SPEC,
  { section: "tab", actions: ["tab.pin", "tab.close", "tab.close-others", "tab.close-right"], includeUnavailable: true },
];

/** Page-scoped actions for the Web Viewer toolbar's "More options" button. */
export const WEB_TAB_MENU_SPEC: MenuSection[] = [
  { section: "page", actions: ["web.reload", "web.bookmark-page"] },
];

export const FOLDER_MENU_SPEC: MenuSection[] = [
  { section: "create", actions: ["folder.new-note", "folder.new-canvas", "folder.new-base", "folder.new-folder"] },
  { section: "bookmark", actions: ["resource.bookmark"] },
  { section: "file", actions: ["resource.rename", "resource.delete"] },
];

export interface ComposedMenuItem {
  id: string;
  title: string;
  icon: string | null;
  checked: boolean;
  warning: boolean;
  disabled: boolean;
  section: string;
  action: () => void;
}

export function composeMenu<TContext>(
  registry: ActionRegistry<TContext>,
  context: TContext,
  spec: MenuSection[]
): ComposedMenuItem[] {
  return spec.flatMap(({ section, actions, includeUnavailable }) => actions.flatMap((id) => {
    const action = registry.resolve(id, context);
    if (!action || (!action.available && !includeUnavailable)) return [];
    return [{
      id,
      title: action.label,
      icon: action.icon,
      checked: action.checked,
      warning: action.warning,
      disabled: !action.available,
      section,
      action: () => void action.run(),
    }];
  }));
}

export function createActionCommand<TContext>(
  registry: ActionRegistry<TContext>,
  actionId: string,
  name: string,
  resolveContext: () => TContext | null,
  hotkey?: string,
  commandId = actionId
): Command {
  return {
    id: commandId,
    name,
    hotkey,
    checkCallback: (checking) => {
      const context = resolveContext();
      const available = context ? registry.resolve(actionId, context)?.available === true : false;
      if (checking) return available;
      if (context && available) void registry.execute(actionId, context);
      return available;
    },
  };
}

export type TabCloseMode = "self" | "others" | "right";

/** Pure target selection. The returned array is a snapshot safe for sequential async detach calls. */
export function tabCloseTargets<T extends { pinned: boolean }>(leaves: readonly T[], clicked: T, mode: TabCloseMode): T[] {
  if (mode === "self") return leaves.includes(clicked) ? [clicked] : [];
  const clickedIndex = leaves.indexOf(clicked);
  if (clickedIndex < 0) return [];
  return leaves.filter((leaf, index) => {
    if (leaf === clicked || leaf.pinned) return false;
    return mode === "others" || index > clickedIndex;
  });
}
